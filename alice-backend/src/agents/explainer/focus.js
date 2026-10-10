/**
 * Vision-guided zoom targets for screenshot (showcase) scenes.
 *
 * The scene LLM never sees the screenshot, so it can't zoom to "Fleet
 * status" — it only knows the words. Here the vision model (alice-vision,
 * Qwen2.5-VL) finds the region of the screenshot each bullet refers to;
 * layouts.js then pans/zooms to it as the narrator reaches that bullet.
 *
 * Boxes come back in the image's pixel space (verified on a 1600x900
 * TheiaCast dashboard) and are stored normalised 0-1. Results are cached
 * per (image, bullets) in assets/focus-<key>.json. Every failure degrades
 * to "no focus" — the scene keeps its plain slow zoom.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { execFile } from 'node:child_process';
import { probeSize } from './hyperframesCli.js';

const FFMPEG = process.env.FFMPEG_BIN ?? join(process.env.HOME ?? '', '.local/bin/ffmpeg');

/** One frame of a video as a PNG in the project (for locating targets on footage). */
function grabFrame(dir, video, at, rel) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', join(dir, video), '-frames:v', '1', join(dir, rel)], { timeout: 60_000 },
      () => resolve(existsSync(join(dir, rel)) ? rel : null));
  });
}

/**
 * Zoom targets for one scene's media → sets asset.mediaSize / mediaFocus.
 * Targets: the scene's explicit `focus` list (from a "zoom to X, then Y"
 * edit) or else its bullets. Footage only gets targets when asked for
 * explicitly (it moves by itself); they're found on its opening frame.
 */
export async function focusForScene(dir, scene, asset, { fetchFn } = {}) {
  const items = scene.focus?.length ? scene.focus : (asset.mediaVideo ? [] : scene.bullets ?? []);
  if (!asset.mediaFile || !items.length) return null;
  let image = asset.mediaFile;
  if (asset.mediaVideo) {
    const rel = `assets/focus-frame-${createHash('sha1').update(`${asset.mediaFile}@${asset.mediaVideo.start}`).digest('hex').slice(0, 10)}.png`;
    image = existsSync(join(dir, rel)) ? rel : await grabFrame(dir, asset.mediaFile, asset.mediaVideo.start + 0.3, rel);
    if (!image) return null;
  }
  const r = await locateFocus(dir, image, items, { fetchFn });
  if (r) { asset.mediaSize = r.size; asset.mediaFocus = r.focus; }
  return r;
}

const key = (...parts) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

/** Pull the first JSON array out of a model reply. */
export function parseBoxes(reply) {
  const m = /\[[\s\S]*\]/.exec(String(reply ?? '').replace(/```(?:json)?/gi, ''));
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * Normalise a pixel box to {x,y,w,h} in 0-1, or null if it's unusable:
 * outside the image, degenerate, or so big that zooming to it means nothing.
 */
export function normaliseBox(b, width, height) {
  const box = b?.bbox_2d ?? b?.bbox ?? b;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  let [x1, y1, x2, y2] = box;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(width, x2); y2 = Math.min(height, y2);
  const w = (x2 - x1) / width, h = (y2 - y1) / height;
  // Small targets are fine (the zoom is capped, so it shows their surroundings);
  // a near-zero box is noise, and one covering most of the screen means nothing.
  if (w < 0.01 || h < 0.01 || w * h > 0.6) return null;
  return { x: x1 / width, y: y1 / height, w, h };
}

/** Match model output to the bullets (by label, falling back to order). */
export function matchBoxes(items, boxes, width, height) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return items.map((item, i) => {
    const hit = boxes.find(b => norm(b?.label) === norm(item)) ?? (boxes.length === items.length ? boxes[i] : null);
    return hit ? normaliseBox(hit, width, height) : null;
  });
}

async function askVision(file, items, width, height, fetchFn) {
  const { endpoint, model } = config.models.vision;
  const body = {
    model, temperature: 0, max_tokens: 800,
    keep_alive: 0, // unload straight away — ComfyUI may need the memory next
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${readFileSync(file).toString('base64')}` } },
      { type: 'text', text: `This is a ${width}x${height} screenshot of a software UI. For each item below, find the region of the screenshot that best shows it and give its bounding box in pixels. If an item isn't visible, leave it out. Output ONLY JSON: [{"label": "<item exactly as written>", "bbox_2d": [x1, y1, x2, y2]}]\nItems:\n${items.map(t => `- ${t}`).join('\n')}` },
    ] }],
  };
  const res = await fetchFn(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.llmGatewayKey ? { Authorization: `Bearer ${config.llmGatewayKey}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`vision ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

/**
 * Zoom targets for one screenshot. Returns { size, focus } where focus is
 * aligned with `items` ({x,y,w,h} or null each), or null if nothing usable.
 */
export async function locateFocus(dir, mediaFile, items, { fetchFn = fetch } = {}) {
  const file = join(dir, mediaFile);
  if (!items.length || !existsSync(file)) return null;
  const size = await probeSize(file);
  const cacheRel = `assets/focus-${key(createHash('sha1').update(readFileSync(file)).digest('hex'), items)}.json`;
  if (existsSync(join(dir, cacheRel))) return JSON.parse(readFileSync(join(dir, cacheRel), 'utf8'));
  const focus = matchBoxes(items, parseBoxes(await askVision(file, items, size.width, size.height, fetchFn)), size.width, size.height);
  const result = focus.some(Boolean) ? { size, focus } : null;
  writeFileSync(join(dir, cacheRel), JSON.stringify(result));
  return result;
}

/**
 * Fill assets[i].mediaSize / mediaFocus for every screenshot scene.
 * Never throws: a scene whose lookup fails just keeps the plain zoom.
 */
export async function focusPhase(dir, plan, assets, { onProgress = () => {}, fetchFn } = {}) {
  // Video clips need their size (and targets only when a scene asks for them).
  for (const [i, a] of assets.entries()) {
    if (a.mediaVideo && a.mediaFile) a.mediaSize = await probeSize(join(dir, a.mediaFile)).catch(() => undefined);
  }
  const todo = plan.scenes.map((s, i) => (assets[i].mediaFile && (s.focus?.length || (!assets[i].mediaVideo && s.bullets?.length)) ? i : -1)).filter(i => i >= 0);
  if (!todo.length) return;
  onProgress(`Finding zoom targets in ${todo.length} screenshot(s)…`);
  for (const i of todo) {
    try {
      await focusForScene(dir, plan.scenes[i], assets[i], { fetchFn });
    } catch (err) {
      console.warn(`[explainer] zoom targets for scene ${i + 1} failed: ${err.message}`);
    }
  }
}
