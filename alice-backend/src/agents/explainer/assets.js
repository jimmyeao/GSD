/**
 * Media generation for the explainer pipeline, using Alice's own models:
 *   voice      Kokoro (TTS service) — narration + a ~5s voice sample
 *   portrait   Krea 2 — one presenter image, reused for every clip
 *   images     Krea 2 — narrated-scene backgrounds (skipped for scenes
 *              showing an attached screenshot)
 *   presenter  LTX-2.3 ID-LoRA — talking-head clips (speech generated,
 *              voice cloned from the Kokoro sample; see talkingHeadClient.js)
 *   music      ACE-Step 1.5 — instrumental bed sized to the final timeline
 *   sfx        Stable Audio 3 — transition sounds
 *
 * Every output is named by a hash of its inputs (assets/<kind>-<hash>.ext)
 * and reused if it already exists, so storyboard revisions and re-renders
 * only regenerate what actually changed.
 *
 * Split into phases because the LLM and ComfyUI can't run at once on this
 * box (comfyManager stops vllm-laguna for ComfyUI jobs):
 *   voicePhase()  — no GPU; also all the storyboard animatic needs
 *   comfyPhase()  — one ComfyUI session, ordered to minimise model swaps
 * Every generation is best-effort: a failed presenter clip demotes its
 * scene to narrated (its Kokoro read already exists), a failed image falls
 * back to a gradient background, missing music/sfx are simply omitted.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { textToSpeech } from '../../services/ttsService.js';
import { generateImage } from '../comfyClient.js';
import { generateTalkingHead } from '../talkingHeadClient.js';
import { generateMusic, generateSfx } from '../musicClient.js';
import { probeDuration } from './hyperframesCli.js';
import { loadLexicon, lexiconFor, applyPronunciations } from './pronounce.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const VOICE_SAMPLE_TEXT = 'This is a short sample of my natural speaking voice, recorded for reference.';
const MAX_CLIP_SECONDS = 12;
// Krea 2 happily renders fake UI, gibberish text and real brand logos when a
// prompt mentions dashboards/apps — fatal behind on-screen text. Backgrounds
// are atmosphere only.
const BACKGROUND_SUFFIX = ', atmospheric background photograph, soft focus, shallow depth of field, no text, no letters, no numbers, no logos, no user interface, no screens';
const PRESENTER_SOUNDS = 'Clear, warm, confident voice, moderate volume, close to the microphone. Quiet room tone.';

/** Kokoro voice for the presenter/narrator when the caller didn't pick one. */
export function pickVoice(presenterDescription = '') {
  return /\b(man|male|he|his|him|guy|gentleman|father|boy)\b/i.test(presenterDescription) ? 'bm_george' : 'bf_alice';
}

/** Presenter clip length from the Kokoro read of the same line (+ breathing room). */
export function clipSecondsFor(ttsSeconds) {
  return Math.min(MAX_CLIP_SECONDS, Math.max(3, Math.round((ttsSeconds + 1.0) * 10) / 10));
}

export function portraitPrompt(description) {
  return `${description}, looking directly at the camera with a warm, friendly expression, medium close-up from the chest up, centered, soft studio lighting, shallow depth of field, photorealistic`;
}

export function presenterVisual(description) {
  return `A static medium close-up of ${description}. They look directly at the camera and speak clearly and warmly, their mouth moving naturally with the words, with small natural head movements and an occasional light hand gesture at chest height. The camera stays completely still.`;
}

export const assetKey = (...parts) => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
const dataUrl = (buf, mime) => `data:${mime};base64,${buf.toString('base64')}`;

async function fetchComfyOutput(endpoint, out) {
  const url = `${endpoint}/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder ?? '')}&type=${encodeURIComponent(out.type ?? 'output')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`ComfyUI /view ${res.status} for ${out.filename}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The video/audio pollers also cache a copy under data/ — don't let those pile up. */
function dropCache(kind, filename) {
  try { unlinkSync(join(DATA_DIR, kind, filename)); } catch { /* not cached */ }
}

/**
 * Phase 1 (no GPU): Kokoro for every spoken line + the voice sample, and
 * attached-media wiring. Returns per-scene assets:
 *   { ttsFile, ttsDur, voiceFile?, voiceDur?, clipSeconds?, mediaFile? }
 */
export async function voicePhase(dir, plan, { voice, images = [], onProgress = () => {} }) {
  const chosen = voice || pickVoice(plan.presenter?.description);
  const lexicon = loadLexicon(plan.pronunciations);
  const ttsLex = lexiconFor(lexicon, 'tts');
  const presenterLex = lexiconFor(lexicon, 'presenter');
  const assets = plan.scenes.map(() => ({}));
  onProgress(`Recording voiceover (${chosen})…`);
  for (const [i, scene] of plan.scenes.entries()) {
    const a = assets[i];
    if (scene.media) a.mediaFile = images.find(img => img.id === scene.media)?.file;
    if (!scene.speech) continue;
    // Audio uses the respelled line; captions/on-screen text keep scene.speech.
    a.spoken = applyPronunciations(scene.speech, ttsLex);
    if (scene.type === 'presenter') a.presenterSpoken = applyPronunciations(scene.speech, presenterLex);
    const rel = `assets/tts-${assetKey(chosen, a.spoken)}.wav`;
    if (!existsSync(join(dir, rel))) writeFileSync(join(dir, rel), await textToSpeech(a.spoken, { voice: chosen }));
    a.ttsFile = rel;
    a.ttsDur = await probeDuration(join(dir, rel));
    if (scene.type === 'presenter') a.clipSeconds = clipSecondsFor(a.ttsDur);
    else { a.voiceFile = rel; a.voiceDur = a.ttsDur; }
  }
  let voiceRefFile = null;
  if (plan.scenes.some(s => s.type === 'presenter')) {
    voiceRefFile = `assets/voiceref-${assetKey(chosen)}.wav`;
    if (!existsSync(join(dir, voiceRefFile))) writeFileSync(join(dir, voiceRefFile), await textToSpeech(VOICE_SAMPLE_TEXT, { voice: chosen }));
  }
  return { assets, voice: chosen, voiceRefFile };
}

/** Demote a presenter scene to narrated, reusing its Kokoro read. */
function demote(plan, assets, i) {
  plan.scenes[i].type = 'narrated';
  assets[i].voiceFile = assets[i].ttsFile;
  assets[i].voiceDur = assets[i].ttsDur;
  delete assets[i].clipFile;
}

/** Generate (or reuse) one ComfyUI output at `rel`. */
async function cached(dir, rel, make) {
  if (existsSync(join(dir, rel))) return rel;
  writeFileSync(join(dir, rel), await make());
  return rel;
}

/**
 * Phase 2: everything ComfyUI. Caller owns ensureComfyRunning()/freeComfyMemory().
 * Mutates `assets` (imageFile, clipFile, clipDur, sfxFile) and may demote
 * presenter scenes in `plan`.
 * @param {number} musicSeconds  final timeline length (known before this phase)
 * @returns {{musicFile?: string, portraitFile?: string, warnings: string[]}}
 */
export async function comfyPhase(dir, plan, assets, { endpoint, voiceRefFile, musicSeconds, seed, onProgress = () => {} }) {
  const warnings = [];
  const warn = (msg) => { warnings.push(msg); onProgress(`⚠ ${msg}`); };
  const presenterIdx = () => plan.scenes.map((s, i) => (s.type === 'presenter' ? i : -1)).filter(i => i >= 0);

  // ── Krea 2: portrait + narrated backgrounds ─────────────────────────
  let portraitFile;
  if (presenterIdx().length) {
    onProgress('Presenter portrait…');
    try {
      portraitFile = await cached(dir, `assets/portrait-${assetKey(plan.presenter.description, seed)}.png`, async () =>
        fetchComfyOutput(endpoint, await generateImage(endpoint, portraitPrompt(plan.presenter.description), '', 600_000, 'krea2', 'landscape')));
    } catch (err) {
      warn(`presenter portrait failed (${err.message}) — presenter scenes become narrated`);
      presenterIdx().forEach(i => demote(plan, assets, i));
    }
  }
  const backgrounds = plan.scenes.map((s, i) => (s.type === 'narrated' && s.image_prompt && !assets[i].mediaFile ? i : -1)).filter(i => i >= 0);
  for (const [k, i] of backgrounds.entries()) {
    onProgress(`Background image ${k + 1}/${backgrounds.length}…`);
    try {
      const prompt = `${plan.scenes[i].image_prompt}${BACKGROUND_SUFFIX}`;
      assets[i].imageFile = await cached(dir, `assets/bg-${assetKey(prompt)}.png`, async () =>
        fetchComfyOutput(endpoint, await generateImage(endpoint, prompt, '', 600_000, 'krea2', 'landscape')));
    } catch (err) {
      warn(`image for scene ${i + 1} failed (${err.message}) — using a gradient`);
    }
  }

  // ── LTX-2.3 ID-LoRA: presenter clips ────────────────────────────────
  if (portraitFile) {
    const portrait = { name: `portrait-${seed}.png`, dataUrl: dataUrl(readFileSync(join(dir, portraitFile)), 'image/png') };
    const voiceRef = { name: `voiceref-${seed}.wav`, dataUrl: dataUrl(readFileSync(join(dir, voiceRefFile)), 'audio/wav') };
    const live = presenterIdx();
    for (const [k, i] of live.entries()) {
      const scene = plan.scenes[i];
      const rel = `assets/presenter-${assetKey(assets[i].presenterSpoken, plan.presenter.description, assets[i].clipSeconds, seed, voiceRefFile)}.mp4`;
      onProgress(existsSync(join(dir, rel)) ? `Presenter clip ${k + 1}/${live.length} (unchanged, reused)` : `Presenter clip ${k + 1}/${live.length} (${assets[i].clipSeconds}s, ~6 min)…`);
      try {
        assets[i].clipFile = await cached(dir, rel, async () => {
          const out = await generateTalkingHead(endpoint, {
            portrait, voiceRef, visual: presenterVisual(plan.presenter.description),
            speech: assets[i].presenterSpoken, sounds: PRESENTER_SOUNDS, seconds: assets[i].clipSeconds, seed,
          });
          const buf = await fetchComfyOutput(endpoint, out);
          dropCache('videos', out.filename);
          return buf;
        });
        assets[i].clipDur = await probeDuration(join(dir, assets[i].clipFile));
      } catch (err) {
        warn(`presenter clip for scene ${i + 1} failed (${err.message}) — narrating it instead`);
        demote(plan, assets, i);
      }
    }
  }

  // ── ACE-Step: music bed ─────────────────────────────────────────────
  let musicFile;
  const seconds = Math.ceil(musicSeconds) + 1;
  onProgress(`Music bed (${seconds}s)…`);
  try {
    musicFile = await cached(dir, `assets/music-${assetKey(plan.music.prompt, seconds)}.flac`, async () => {
      const out = await generateMusic(endpoint, plan.music.prompt, '', seconds, 600_000);
      const buf = await fetchComfyOutput(endpoint, out);
      dropCache('audio', out.filename);
      return buf;
    });
  } catch (err) {
    warn(`music failed (${err.message}) — no music bed`);
  }

  // ── Stable Audio 3: transition sfx ──────────────────────────────────
  for (const [i, scene] of plan.scenes.entries()) {
    if (!scene.sfx) continue;
    try {
      assets[i].sfxFile = await cached(dir, `assets/sfx-${assetKey(scene.sfx)}.flac`, async () => {
        onProgress(`Sound effect "${scene.sfx}"…`);
        const out = await generateSfx(endpoint, `${scene.sfx}, clean, short, no music`, 1.5, 300_000);
        const buf = await fetchComfyOutput(endpoint, out);
        dropCache('audio', out.filename);
        return buf;
      });
    } catch (err) {
      warn(`sound effect "${scene.sfx}" failed (${err.message})`);
    }
  }

  return { musicFile, portraitFile, warnings };
}
