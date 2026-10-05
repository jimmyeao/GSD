/**
 * Explainer / product-promo video pipeline (HyperFrames + Alice's local models).
 *
 *   1. plan       LLM (Laguna) → validated scene plan            [LLM up]
 *   2. voice      Kokoro reads every line; durations measured     [no GPU]
 *   3. media      one ComfyUI session: portrait, backgrounds,
 *                 ID-LoRA presenter clips, music, sfx             [LLM stopped]
 *   4. captions   whisper word timings for every spoken track     [CPU, while LLM restarts]
 *   5. compose    deterministic index.html + layout-library scenes;
 *                 optional `creative` mode lets the LLM write scene
 *                 graphics, gated by `hyperframes check`           [LLM up]
 *   6. render     final check + `hyperframes render` → MP4
 *
 * Project dirs live under data/explainers/<id>/ (index.html, compositions/,
 * assets/, out.mp4) so a result can be re-rendered or edited in HyperFrames
 * Studio afterwards.
 */

import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { ensureComfyRunning, freeComfyMemory } from '../../comfyManager.js';
import { LLMUnavailableError } from '../llmClient.js';
import { planExplainer } from './planner.js';
import { voicePhase, comfyPhase } from './assets.js';
import { layoutTimeline, buildIndexHtml, fallbackSceneHtml } from './timeline.js';
import { writeScenes } from './sceneWriter.js';
import { assertRuntime, checkProject, renderProject, transcribe, GSAP_JS } from './hyperframesCli.js';

export const EXPLAINERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'explainers');
const LLM_WAIT_MS = 8 * 60_000; // vllm-laguna cold restart after a ComfyUI session

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run an LLM-dependent step, waiting out the window where vllm-laguna is
 * stopped/restarting around ComfyUI work.
 */
export async function withLLM(fn, { onProgress = () => {}, waitMs = LLM_WAIT_MS, pollMs = 15_000 } = {}) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof LLMUnavailableError || /LLM API (5\d\d|404)/.test(err.message);
      if (!transient || Date.now() > deadline) throw err;
      if (!announced) { onProgress('Waiting for the LLM to come back up…'); announced = true; }
      await sleep(pollMs);
    }
  }
}

/**
 * Validate + default explainer options from an untrusted caller (REST body
 * or chat socket payload). Returns { opts } or { error }.
 */
export function validateExplainerOptions(raw = {}) {
  const { brief, format = 'explainer', presenter = true, maxPresenterScenes = 2, targetSeconds = 45, creative = false, voice } = raw;
  if (!brief || typeof brief !== 'string' || brief.trim().length < 10) return { error: 'brief (string, at least 10 characters) is required' };
  if (!['explainer', 'promo'].includes(format)) return { error: 'format must be "explainer" or "promo"' };
  const maxP = Number(maxPresenterScenes);
  if (!Number.isInteger(maxP) || maxP < 0 || maxP > 3) return { error: 'maxPresenterScenes must be an integer 0-3' };
  const target = Number(targetSeconds);
  if (!Number.isFinite(target) || target < 15 || target > 120) return { error: 'targetSeconds must be between 15 and 120' };
  if (voice !== undefined && voice !== null && voice !== '' && !/^[a-z]{2}_[a-z]+$/.test(voice)) return { error: 'voice must be a Kokoro voice id, e.g. bf_alice' };
  return { opts: { brief: brief.trim().slice(0, 4000), format, presenter: !!presenter, maxPresenterScenes: maxP, targetSeconds: target, creative: !!creative, voice: voice || undefined } };
}

/**
 * @param {string} id  job id (project directory name)
 * @param {object} opts
 *   brief (string, required), format 'explainer'|'promo', presenter (bool),
 *   maxPresenterScenes, targetSeconds, creative (bool), voice (Kokoro id)
 * @param {(msg:string)=>void} onProgress
 * @returns {Promise<{file:string, dir:string, plan:object, warnings:string[], scenes:object[]}>}
 */
export async function runExplainerPipeline(id, opts, onProgress = () => {}) {
  assertRuntime();
  const dir = join(EXPLAINERS_DIR, id);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'compositions'), { recursive: true });
  mkdirSync(join(dir, '.work'), { recursive: true });
  copyFileSync(GSAP_JS, join(dir, 'assets/gsap.min.js'));
  const llm = { endpoint: config.models.coder.endpoint, model: config.models.coder.model };
  const comfy = config.models.comfyui.endpoint;
  const seed = Math.floor(Math.random() * 2 ** 31);

  // 1. plan
  onProgress('Planning scenes…');
  const plan = await withLLM(() => planExplainer(llm, opts), { onProgress });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  onProgress(`Plan: "${plan.title}" — ${plan.scenes.length} scenes (${plan.scenes.map(s => s.type).join(', ')})`);

  // 2. voice
  const assets = plan.scenes.map(() => ({}));
  const { voiceRefFile } = await voicePhase(dir, plan, assets, { voice: opts.voice, onProgress });

  // 3. media — duration is known up front: presenter clips are sized from
  //    their Kokoro reads, everything else from the reads themselves.
  const estimate = layoutTimeline(plan.scenes, assets.map(a => ({ ...a, clipDur: a.clipSeconds })));
  const musicSeconds = estimate.at(-1).start + estimate.at(-1).duration;
  let media;
  await ensureComfyRunning();
  try {
    media = await comfyPhase(dir, plan, assets, { endpoint: comfy, voiceRefFile, musicSeconds, seed, onProgress });
  } finally {
    freeComfyMemory();
  }

  // 4. captions (CPU) — word timings from the audio that will actually play
  onProgress('Transcribing for captions…');
  for (const [i, a] of assets.entries()) {
    const spoken = a.clipFile ?? a.voiceFile;
    if (!spoken) continue;
    const work = join(dir, '.work', `tr-${i}`);
    mkdirSync(work, { recursive: true });
    copyFileSync(join(dir, spoken), join(work, spoken.split('/').pop()));
    a.words = await transcribe(work, spoken.split('/').pop());
  }

  // 5. compose
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ assets, musicFile: media.musicFile }, null, 2));
  const slots = layoutTimeline(plan.scenes, assets);
  writeFileSync(join(dir, 'index.html'), buildIndexHtml(plan, assets, { musicFile: media.musicFile }));
  const sceneInfo = slots.map((s, i) => ({ duration: s.duration, words: assets[i].words ?? [] }));
  let scenes = plan.scenes.map((_, i) => ({ index: i, source: 'layout', rounds: 0 }));
  for (const [i, scene] of plan.scenes.entries()) {
    writeFileSync(join(dir, 'compositions', `scene-${i}.html`), fallbackSceneHtml(`scene-${i}`, scene, { palette: plan.palette, font: plan.font, ...sceneInfo[i] }));
  }
  if (opts.creative) {
    scenes = await withLLM(() => writeScenes(dir, plan, sceneInfo, { llm, check: checkProject, slots, onProgress }), { onProgress });
    scenes = scenes.map(s => ({ ...s, source: s.source === 'fallback' ? 'layout' : 'llm' }));
  }

  // 6. render
  onProgress('Checking composition…');
  const final = await checkProject(dir);
  if (!final.ok) media.warnings.push(`check: ${final.findings.map(f => f.code).join(', ')}`);
  onProgress('Rendering video…');
  const file = await renderProject(dir, join(dir, 'out.mp4'));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ scenes, warnings: media.warnings, check: final.findings }, null, 2));
  return { file, dir, plan, warnings: media.warnings, scenes };
}

/**
 * Re-compose and re-render an existing project from its saved plan.json +
 * assets.json — no media regeneration. Useful after layout/timeline fixes
 * or hand-edits to plan.json (headlines, bullets, layouts, palette).
 */
export async function recomposeExplainer(id, onProgress = () => {}) {
  const { readFileSync } = await import('node:fs');
  const dir = join(EXPLAINERS_DIR, id);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  const { assets, musicFile } = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
  const slots = layoutTimeline(plan.scenes, assets);
  writeFileSync(join(dir, 'index.html'), buildIndexHtml(plan, assets, { musicFile }));
  for (const [i, scene] of plan.scenes.entries()) {
    writeFileSync(join(dir, 'compositions', `scene-${i}.html`), fallbackSceneHtml(`scene-${i}`, scene, { palette: plan.palette, font: plan.font, duration: slots[i].duration, words: assets[i].words ?? [] }));
  }
  onProgress('Rendering video…');
  return renderProject(dir, join(dir, 'out.mp4'));
}
