/**
 * "Zoom in and highlight X, then Y, then Z (in time with the audio)" on a
 * screenshot/footage scene — handled by the vision-guided camera instead of
 * a free-form LLM rewrite (the LLM can't see the screenshot, so it can't
 * know where X is). The LLM only extracts the target names; the vision model
 * locates them; the showcase template's cursor, spotlight/callout and camera
 * visit each one as the narrator reaches it. The targets are stored on the
 * scene (scene.focus) so later re-renders keep them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { complete } from '../llmClient.js';
import { focusForScene } from './focus.js';
import { layoutTimeline, fallbackSceneHtml } from './timeline.js';
import { resolveStyle } from './styles.js';

/** Requests this path handles: zoom / highlight / focus / point at / circle named things. */
export const FOCUS_REQUEST = /\b(zoom(s|ing)?\s+(in|into|to|on)|highlight|spotlight|focus(es|ing)?\s+on|point(s|ing)?\s+(at|to)|circle|draw attention|call ?out)\b/i;

/** The on-screen elements the client named, in order (LLM, no reasoning). */
export async function extractTargets(llm, instruction, { completeFn = complete } = {}) {
  const reply = await completeFn(llm.endpoint, llm.model, [
    { role: 'system', content: 'Extract, in order, the on-screen UI elements the client wants the video to zoom to or highlight. Reply ONLY with a JSON array of their names as they would be labelled in the app, 1-5 items, e.g. ["Fleet status", "Active screens", "Storage used"].' },
    { role: 'user', content: instruction },
  ], { numPredict: 300, temperature: 0, noThink: true, signal: AbortSignal.timeout(60_000) });
  const m = /\[[\s\S]*\]/.exec(String(reply ?? ''));
  let list = [];
  try { list = JSON.parse(m?.[0] ?? '[]'); } catch { /* none */ }
  return list.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 60)).slice(0, 5);
}

/**
 * Apply a focus edit to scene `i`. Mutates plan (scene.focus) and assets.json.
 * @returns {Promise<{ok: boolean, targets: string[], found: string[], message?: string}>}
 */
export async function applyFocusEdit(dir, plan, i, instruction, { llm, check, completeFn, fetchFn } = {}) {
  const saved = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
  const asset = saved.assets[i];
  const scene = plan.scenes[i];
  if (!asset?.mediaFile) return { ok: false, targets: [], found: [], message: 'that scene has no screenshot or footage to zoom into' };
  const targets = await extractTargets(llm, instruction, { completeFn });
  if (!targets.length) return { ok: false, targets, found: [], message: "I couldn't tell which parts of the screen you want highlighted" };
  scene.focus = targets;
  const r = await focusForScene(dir, scene, asset, { fetchFn });
  const found = targets.filter((_, k) => r?.focus?.[k]);
  if (!found.length) { delete scene.focus; return { ok: false, targets, found, message: `I couldn't find ${targets.map(t => `"${t}"`).join(', ')} on that screen` }; }
  writeFileSync(join(dir, 'assets.json'), JSON.stringify(saved, null, 2));
  const slots = layoutTimeline(plan.scenes, saved.assets);
  const html = fallbackSceneHtml(`scene-${i}`, scene, {
    style: resolveStyle(plan), palette: plan.palette, font: plan.font, duration: slots[i].duration, words: asset.words ?? [],
    mediaFile: asset.mediaFile, mediaSize: asset.mediaSize, mediaFocus: asset.mediaFocus, mediaVideo: asset.mediaVideo,
  });
  const file = join(dir, 'compositions', `scene-${i}.html`);
  const before = readFileSync(file, 'utf8');
  writeFileSync(file, html);
  if (check) {
    const { findings } = await check(dir);
    const mine = findings.filter(f => (f.sourceFile ?? '').endsWith(`scene-${i}.html`) && f.code !== 'contrast_aa_failure');
    if (mine.length) { writeFileSync(file, before); return { ok: false, targets, found, message: mine.map(f => f.code).join(', ') }; }
  }
  return { ok: true, targets, found };
}
