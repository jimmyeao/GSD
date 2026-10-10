/**
 * Website capture for briefs that link a public site — no login needed, so
 * it works for any product with a marketing page.
 *
 * `hyperframes capture <url>` (headless Chrome) gives us what the plain
 * text scrape in research.js can't: the site's product images, logo, brand
 * colours/fonts, a full-page screenshot, and any demo videos it embeds.
 * harvestCapture() turns that into explainer media:
 *   - product images + logo   → attachments (classified like uploads)
 *   - full-page screenshot    → a tall "site tour" image the showcase layout scrolls
 *   - demo videos             → split at scene cuts into page-sized clips, each
 *                               labelled by the vision model, so a scene can show
 *                               real footage of the screen it talks about
 *   - brand tokens            → an accent colour + font hint for the planner
 *
 * The start URL is SSRF-checked (assertPublicUrl) before Chrome is pointed
 * at it. Everything here is best-effort: a failed capture leaves the brief
 * with the text research alone.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { NODE22, HYPERFRAMES_CLI_ARGS, hyperframesEnv, probeSize, probeDuration } from './hyperframesCli.js';
import { assertPublicUrl } from './research.js';

const FFMPEG = process.env.FFMPEG_BIN ?? join(process.env.HOME ?? '', '.local/bin/ffmpeg');
const MAX_IMAGES = 6;
const MAX_VIDEOS = 2;
const MAX_CLIPS = 6;
const MIN_CLIP_SECONDS = 2;

function runFile(bin, args, { timeoutMs = 300_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: hyperframesEnv(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Run `hyperframes capture` into outDir. Returns its JSON summary, or throws. */
export async function captureSite(url, outDir) {
  await assertPublicUrl(url);
  if (existsSync(join(outDir, 'extracted', 'tokens.json'))) return { ok: true, cached: true };
  const { code, stdout, stderr } = await runFile(NODE22, [...HYPERFRAMES_CLI_ARGS, 'capture', url, '-o', outDir, '--json', '--skip-vision',
    '--max-screenshots', '8', '--timeout', '60000', '--capture-budget', '90000'], { timeoutMs: 240_000 });
  const json = stdout.slice(stdout.lastIndexOf('\n{') + 1);
  let summary = null;
  try { summary = JSON.parse(json); } catch { /* fall through */ }
  if (code !== 0 || !summary?.ok) throw new Error(`capture failed: ${(stderr || stdout).slice(-300)}`);
  return summary;
}

/** Cut times (s) where the picture changes, merged so every clip is >= MIN_CLIP_SECONDS. */
export function mergeCuts(cuts, duration, minLen = MIN_CLIP_SECONDS) {
  const kept = [];
  for (const t of [...cuts].sort((a, b) => a - b)) {
    const prev = kept.at(-1) ?? 0;
    if (t - prev >= minLen && duration - t >= minLen) kept.push(t);
  }
  const edges = [0, ...kept, duration];
  return edges.slice(0, -1).map((start, i) => ({ start: Math.round(start * 100) / 100, end: Math.round(edges[i + 1] * 100) / 100 }));
}

async function sceneCuts(file) {
  const { stderr } = await runFile(FFMPEG, ['-hide_banner', '-i', file, '-vf', "select='gt(scene,0.12)',showinfo", '-f', 'null', '-'], { timeoutMs: 120_000 });
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1]));
}

async function grabFrame(file, at, out) {
  await runFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', file, '-frames:v', '1', out], { timeoutMs: 60_000 });
  return existsSync(out);
}

/** Pick the most brand-like colour: saturated, mid-lightness, early in the list. */
export function brandAccent(colors = []) {
  for (const hex of colors) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) continue;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    if (s > 0.55 && l > 0.35 && l < 0.65) return hex.toUpperCase();
  }
  return null;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SKIP_NAME = /contact-sheet|favicon|apple-touch|^icon-|sprite|placeholder|avatar/i;

/**
 * Turn a capture directory into explainer media, copied into the project.
 * @returns {Promise<{images: {name, dataUrl}[], clips: object[], brand: object|null}>}
 *   images go through addImages() like uploads; clips are video media items.
 */
export async function harvestCapture(captureDir, projectDir) {
  const out = { images: [], clips: [], brand: null };
  const seen = new Set();
  const add = (file, name) => {
    const buf = readFileSync(file);
    const hash = createHash('sha1').update(buf).digest('hex');
    if (seen.has(hash)) return;
    seen.add(hash);
    const ext = extname(file).slice(1).replace('jpg', 'jpeg');
    out.images.push({ name, dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` });
  };

  // Product images (and the logo — og-image is usually it; addImages classifies).
  const assetsDir = join(captureDir, 'assets');
  const files = existsSync(assetsDir) ? readdirSync(assetsDir).filter(f => IMAGE_EXT.has(extname(f).toLowerCase())) : [];
  const logoish = files.filter(f => /og-image|logo/i.test(f));
  for (const f of [...logoish.slice(0, 1), ...files.filter(f => !SKIP_NAME.test(f) && !logoish.includes(f))]) {
    if (out.images.length >= MAX_IMAGES) break;
    const p = join(assetsDir, f);
    try {
      const { width } = await probeSize(p);
      if (width < 400 && !logoish.includes(f)) continue;
      add(p, `site: ${f}`);
    } catch { /* unreadable image */ }
  }

  // Full-page screenshot → a scrollable "site tour" (only if it's genuinely tall).
  const full = join(captureDir, 'screenshots', 'full-page.png');
  if (existsSync(full) && statSync(full).size < 12 * 1024 * 1024) {
    try {
      const { width, height } = await probeSize(full);
      if (height / width >= 1.5) add(full, 'site: full page (website tour)');
    } catch { /* skip */ }
  }

  // Demo videos → clips at scene cuts, one poster frame each for labelling.
  let manifest = [];
  try { manifest = JSON.parse(readFileSync(join(captureDir, 'extracted', 'video-manifest.json'), 'utf8')); } catch { /* none */ }
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  for (const [v, entry] of manifest.filter(e => e.localPath).slice(0, MAX_VIDEOS).entries()) {
    const src = join(captureDir, entry.localPath);
    if (!existsSync(src)) continue;
    const rel = `assets/site-video-${v}${extname(src) || '.mp4'}`;
    copyFileSync(src, join(projectDir, rel));
    let duration;
    try { duration = await probeDuration(join(projectDir, rel)); } catch { continue; }
    for (const [k, seg] of mergeCuts(await sceneCuts(join(projectDir, rel)), duration).entries()) {
      if (out.clips.length >= MAX_CLIPS) break;
      const poster = `assets/site-video-${v}-${k}.png`;
      if (!(await grabFrame(join(projectDir, rel), Math.min(seg.end - 0.1, seg.start + (seg.end - seg.start) / 2), join(projectDir, poster)))) continue;
      // Last frame: held on screen if the scene outlasts the clip.
      const endFrame = `assets/site-video-${v}-${k}-end.png`;
      const hasEnd = await grabFrame(join(projectDir, rel), Math.max(seg.start, seg.end - 0.15), join(projectDir, endFrame));
      out.clips.push({
        name: `site video ${basename(src)} ${seg.start.toFixed(1)}-${seg.end.toFixed(1)}s`,
        file: rel, start: seg.start, end: seg.end, videoDuration: Math.round(duration * 100) / 100, poster, ...(hasEnd ? { endFrame } : {}),
        context: [entry.heading, entry.caption, entry.ariaLabel].filter(Boolean).join(' — '),
      });
    }
  }

  // Brand tokens.
  try {
    const tokens = JSON.parse(readFileSync(join(captureDir, 'extracted', 'tokens.json'), 'utf8'));
    const font = (tokens.fonts ?? []).map(f => f.family).find(f => f && !/^-apple-system|system-ui|sans-serif|serif|arial|helvetica/i.test(f)) ?? null;
    out.brand = { accent: brandAccent(tokens.colors), colors: (tokens.colors ?? []).slice(0, 8), font };
  } catch { /* no tokens */ }
  return out;
}
