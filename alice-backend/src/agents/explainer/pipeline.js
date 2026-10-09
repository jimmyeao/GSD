/**
 * Explainer / product-promo video pipeline (HyperFrames + Alice's local models).
 *
 * Stages (each reusable; session.js drives them conversationally, the REST
 * one-shot runs them back to back):
 *   prepareContext  fetch the brief's links + classify attached images      [no GPU]
 *   (planner.js)    questions → plan → revisions                             [LLM up]
 *   makeAnimatic    draft render: real voice + layouts + attached media,
 *                   placeholders for presenter/backgrounds — ~1 min, no GPU
 *   produceVideo    voice → one ComfyUI session (portrait, backgrounds,
 *                   ID-LoRA presenter clips, music, sfx) → whisper-timed
 *                   captions → compose → check → render                    [LLM stopped during ComfyUI]
 *
 * Project dirs live under data/explainers/<id>/ (plan.json, assets.json,
 * index.html, compositions/, assets/, out.mp4) so a result can be
 * re-rendered (recomposeExplainer) or opened in HyperFrames Studio. Asset
 * files are content-hashed (assets.js), so re-runs reuse unchanged media.
 */

import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { ensureComfyRunning, freeComfyMemory } from '../../comfyManager.js';
import { LLMUnavailableError, complete } from '../llmClient.js';
import { planExplainer } from './planner.js';
import { voicePhase, comfyPhase, presenterPhase } from './assets.js';
import { remoteWorkerFor, resolveNeeds, workerModels } from '../../comfyWorkers.js';
import { TALKING_HEAD_NEEDS } from '../talkingHeadClient.js';
import { layoutTimeline, buildIndexHtml, fallbackSceneHtml, alignScriptWords } from './timeline.js';
import { writeScenes } from './sceneWriter.js';
import { researchBrief, describeImages } from './research.js';
import { assertRuntime, checkProject, renderProject, transcribe, GSAP_JS } from './hyperframesCli.js';

export const EXPLAINERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'explainers');
const LLM_WAIT_MS = 8 * 60_000; // vllm-laguna cold restart after a ComfyUI session
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** LLM used for planning/revisions/scene HTML. Overridable for model A/B tests. */
export function explainerLLM() {
  return { endpoint: config.models.coder.endpoint, model: process.env.EXPLAINER_LLM_MODEL || config.models.coder.model };
}

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

/** Attached images: [{name, dataUrl}] of png/jpeg/webp/gif, ≤ MAX_IMAGES, ≤ 10MB each. */
export function validateImages(images) {
  if (images === undefined || images === null) return { list: [] };
  if (!Array.isArray(images)) return { error: 'images must be an array of {name, dataUrl}' };
  if (images.length > MAX_IMAGES) return { error: `at most ${MAX_IMAGES} images` };
  const list = [];
  for (const img of images) {
    const m = /^data:(image\/[a-z]+);base64,/.exec(img?.dataUrl ?? '');
    if (!m || !IMAGE_MIME[m[1]] || typeof img.name !== 'string') return { error: 'each image must be {name, dataUrl} with a png/jpeg/webp/gif data URL' };
    if (img.dataUrl.length * 0.75 > MAX_IMAGE_BYTES) return { error: `image ${img.name} is over 10MB` };
    list.push({ name: img.name.replace(/[^\w.\- ]+/g, '_').slice(0, 80), dataUrl: img.dataUrl });
  }
  return { list };
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
  const images = validateImages(raw.images);
  if (images.error) return { error: images.error };
  return { opts: { brief: brief.trim().slice(0, 4000), format, presenter: !!presenter, maxPresenterScenes: maxP, targetSeconds: target, creative: !!creative, voice: voice || undefined, images: images.list } };
}

export function projectDir(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) throw new Error('invalid project id');
  const dir = resolve(EXPLAINERS_DIR, id);
  if (!dir.startsWith(resolve(EXPLAINERS_DIR) + sep)) throw new Error('invalid project path');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'compositions'), { recursive: true });
  mkdirSync(join(dir, '.work'), { recursive: true });
  copyFileSync(GSAP_JS, join(dir, 'assets/gsap.min.js'));
  return dir;
}

/**
 * Save attachments into the project and classify them (logo/screenshot/photo).
 * @param {object[]} existing  previously-added images (ids continue from them)
 */
export async function addImages(dir, images, existing = []) {
  const saved = images.map((img, k) => {
    const id = `img${existing.length + k + 1}`;
    const mime = /^data:(image\/[a-z]+);/.exec(img.dataUrl)[1];
    const file = `assets/media-${id}.${IMAGE_MIME[mime]}`;
    writeFileSync(join(dir, file), Buffer.from(img.dataUrl.split(',')[1], 'base64'));
    return { id, name: img.name, dataUrl: img.dataUrl, file };
  });
  const vision = { endpoint: config.models.vision.endpoint, model: config.models.vision.model, apiKey: config.llmGatewayKey };
  const described = await describeImages(saved, vision);
  return saved.map((img, k) => ({ id: img.id, name: img.name, file: img.file, kind: described[k].kind, description: described[k].description }));
}

/**
 * Everything the planner should know beyond the brief itself.
 * @returns {Promise<{brief, sourceText, sources, images}>}
 */
export async function prepareContext(dir, { brief, images = [] }, onProgress = () => {}) {
  const ctx = { brief, sourceText: '', sources: [], images: [] };
  const research = await researchBrief(brief);
  if (research.sources.length) onProgress(`Read ${research.sources.length} page(s): ${research.sources.join(', ')}`);
  for (const e of research.errors) onProgress(`⚠ ${e}`);
  ctx.sourceText = research.text;
  ctx.sources = research.sources;
  if (images.length) {
    onProgress(`Looking at ${images.length} attached image(s)…`);
    ctx.images = await addImages(dir, images);
  }
  return ctx;
}

const logoOf = (ctx) => ctx.images?.find(i => i.kind === 'logo')?.file;

function writeComposition(dir, plan, assets, { musicFile, portraitFile, logoFile }) {
  const slots = layoutTimeline(plan.scenes, assets);
  // Project metadata HyperFrames Studio shows (name) and uses (asset paths).
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: dir.split('/').pop(), name: plan.title }, null, 2));
  if (!existsSync(join(dir, 'hyperframes.json'))) {
    writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' }, media: { autoProxy: true } }, null, 2));
  }
  writeFileSync(join(dir, 'index.html'), buildIndexHtml(plan, assets, { musicFile, portraitFile }));
  plan.scenes.forEach((scene, i) => {
    writeFileSync(join(dir, 'compositions', `scene-${i}.html`), fallbackSceneHtml(`scene-${i}`, scene, {
      palette: plan.palette, font: plan.font, duration: slots[i].duration, words: assets[i].words ?? [],
      mediaFile: assets[i].mediaFile, logoFile: (scene.type === 'title' || scene.type === 'outro') ? logoFile : undefined,
    }));
  });
  return slots;
}

/**
 * Draft animatic for storyboard review: Kokoro voice, real layouts, attached
 * screenshots/logo, placeholders for presenter clips + AI backgrounds. No GPU.
 * @returns {Promise<{file, slots, assets}>}
 */
export async function makeAnimatic(dir, plan, ctx, { voice, portraitFile } = {}, onProgress = () => {}) {
  const { assets } = await voicePhase(dir, plan, { voice, images: ctx.images, onProgress });
  for (const [i, scene] of plan.scenes.entries()) {
    const a = assets[i];
    if (scene.type === 'presenter') { a.clipDur = a.clipSeconds; a.voiceFile = a.ttsFile; a.voiceDur = a.ttsDur; }
    if (a.ttsDur) a.words = alignScriptWords(scene.speech, [], a.ttsDur);
  }
  const slots = writeComposition(dir, plan, assets, { portraitFile, logoFile: logoOf(ctx) });
  onProgress('Rendering storyboard animatic…');
  const file = await renderProject(dir, join(dir, 'animatic.mp4'), { quality: 'draft', fps: 24 });
  return { file, slots, assets };
}

/**
 * Full render of an approved plan.
 * @returns {Promise<{file, warnings, scenes, portraitFile}>}
 */
export async function produceVideo(dir, plan, ctx, { voice, seed, creative = false } = {}, onProgress = () => {}) {
  const { assets, voiceRefFile } = await voicePhase(dir, plan, { voice, images: ctx.images, onProgress });

  // Media — timeline length is known up front (presenter clips are sized
  // from their Kokoro reads), so the music bed can be generated to length.
  const estimate = layoutTimeline(plan.scenes, assets.map(a => ({ ...a, clipDur: a.clipSeconds })));
  const musicSeconds = estimate.at(-1).start + estimate.at(-1).duration;
  // Presenter clips go to an idle remote worker (laptop GPU) when one has
  // the models — in parallel with the local GPU's work, and without pausing
  // the LLM for them. The local GPU only starts if it has uncached work.
  const hasPresenter = plan.scenes.some(s => s.type === 'presenter');
  const remote = hasPresenter ? await remoteWorkerFor(TALKING_HEAD_NEEDS) : null;
  let remoteRun = null;
  let localStarted = false;
  const ensureLocal = async () => { if (!localStarted) { localStarted = true; await ensureComfyRunning(); } };
  let media;
  try {
    media = await comfyPhase(dir, plan, assets, {
      endpoint: config.models.comfyui.endpoint, ensureLocal, voiceRefFile, musicSeconds, seed, onProgress,
      presenters: !remote,
      onPortrait: (portraitFile) => {
        if (!remote) return;
        onProgress(`Presenter clips → ${remote.name} (runs alongside the rest)`);
        remoteRun = (async () => {
          const ckpt = resolveNeeds(TALKING_HEAD_NEEDS, await workerModels(remote.endpoint))[0];
          return presenterPhase(dir, plan, assets, { endpoint: remote.endpoint, ckpt, workerName: remote.name, portraitFile, voiceRefFile, seed, onProgress });
        })().catch((err) => { onProgress(`⚠ ${remote.name} failed (${err.message})`); return plan.scenes.map((sc, i) => (sc.type === 'presenter' ? i : -1)).filter(i => i >= 0); })
          .then(failed => ({ failed, portraitFile }));
      },
    });
  } finally {
    if (localStarted) freeComfyMemory();
  }
  if (remoteRun) {
    const { failed, portraitFile } = await remoteRun;
    if (failed.length) {
      // Remote worker dropped out — finish those clips on the local GPU.
      onProgress(`Retrying ${failed.length} presenter clip(s) locally…`);
      await ensureComfyRunning();
      try {
        const still = await presenterPhase(dir, plan, assets, { endpoint: config.models.comfyui.endpoint, portraitFile, voiceRefFile, seed, onProgress, only: failed });
        for (const i of still) { media.warnings.push(`presenter clip for scene ${i + 1} failed — narrated instead`); media.demote(i); }
      } finally {
        freeComfyMemory();
      }
    }
  }

  // Captions (CPU, while the LLM restarts): script words, whisper timing.
  onProgress('Timing captions…');
  for (const [i, a] of assets.entries()) {
    const spoken = a.clipFile ?? a.voiceFile;
    if (!spoken) continue;
    const work = join(dir, '.work', `tr-${i}`);
    mkdirSync(work, { recursive: true });
    const name = spoken.split('/').pop();
    copyFileSync(join(dir, spoken), join(work, name));
    a.words = alignScriptWords(plan.scenes[i].speech, await transcribe(work, name), a.clipDur ?? a.voiceDur);
  }

  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  writeFileSync(join(dir, 'assets.json'), JSON.stringify({ assets, musicFile: media.musicFile, logoFile: logoOf(ctx) }, null, 2));
  const slots = writeComposition(dir, plan, assets, { musicFile: media.musicFile, logoFile: logoOf(ctx) });
  let scenes = plan.scenes.map((_, i) => ({ index: i, source: 'layout', rounds: 0 }));
  if (creative) {
    // ComfyUI just finished, so vllm-laguna is still restarting — wait for a
    // real answer first, or every scene's first attempt fails at once.
    onProgress('Waiting for the LLM to write scene graphics…');
    await withLLM(async () => {
      const llm = explainerLLM();
      await complete(llm.endpoint, llm.model, [{ role: 'user', content: 'Reply with OK.' }], { numPredict: 200, signal: AbortSignal.timeout(60_000) });
    }, { onProgress });
    const sceneInfo = slots.map((s, i) => ({ duration: s.duration, words: assets[i].words ?? [] }));
    scenes = await withLLM(() => writeScenes(dir, plan, sceneInfo, { llm: explainerLLM(), check: checkProject, slots, onProgress }), { onProgress });
    scenes = scenes.map(s => ({ ...s, source: s.source === 'fallback' ? 'layout' : 'llm' }));
  }

  onProgress('Checking composition…');
  const final = await checkProject(dir);
  if (!final.ok) media.warnings.push(`check: ${final.findings.map(f => f.code).join(', ')}`);
  onProgress('Rendering video…');
  const file = await renderProject(dir, join(dir, 'out.mp4'));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({ scenes, warnings: media.warnings, check: final.findings }, null, 2));
  return { file, warnings: media.warnings, scenes, portraitFile: media.portraitFile };
}

/**
 * REST one-shot (no storyboard round-trip): context → plan → full render.
 * @returns {Promise<{file, dir, plan, warnings, scenes}>}
 */
export async function runExplainerPipeline(id, opts, onProgress = () => {}) {
  assertRuntime();
  const dir = projectDir(id);
  const ctx = await prepareContext(dir, opts, onProgress);
  onProgress('Planning scenes…');
  const plan = await withLLM(() => planExplainer(explainerLLM(), { ...opts, ...ctx }), { onProgress });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  onProgress(`Plan: "${plan.title}" — ${plan.scenes.length} scenes (${plan.scenes.map(s => s.type).join(', ')})`);
  const seed = Math.floor(Math.random() * 2 ** 31);
  const out = await produceVideo(dir, plan, ctx, { voice: opts.voice, seed, creative: opts.creative }, onProgress);
  return { ...out, dir, plan };
}

/**
 * Re-compose and re-render an existing project from its saved plan.json +
 * assets.json — no media regeneration. Useful after layout/timeline fixes
 * or hand-edits to plan.json (headlines, bullets, layouts, palette).
 */
export async function recomposeExplainer(id, onProgress = () => {}) {
  const dir = projectDir(id);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  const { assets, musicFile, logoFile } = JSON.parse(readFileSync(join(dir, 'assets.json'), 'utf8'));
  writeComposition(dir, plan, assets, { musicFile, logoFile: logoFile && existsSync(join(dir, logoFile)) ? logoFile : undefined });
  onProgress('Rendering video…');
  return renderProject(dir, join(dir, 'out.mp4'));
}
