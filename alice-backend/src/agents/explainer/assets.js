/**
 * Media generation for the explainer pipeline, using Alice's own models:
 *   voice      Kokoro (TTS service) — narration + a ~5s voice sample
 *   portrait   Krea 2 — one presenter image, reused for every clip
 *   images     Krea 2 — narrated-scene backgrounds
 *   presenter  LTX-2.3 ID-LoRA — talking-head clips (speech generated,
 *              voice cloned from the Kokoro sample; see talkingHeadClient.js)
 *   music      ACE-Step 1.5 — instrumental bed sized to the final timeline
 *   sfx        Stable Audio 3 — transition sounds
 *
 * Split into phases because the LLM and ComfyUI can't run at once on this
 * box (comfyManager stops vllm-laguna for ComfyUI jobs):
 *   voicePhase()  — no GPU; runs while the LLM is still up
 *   comfyPhase()  — one ComfyUI session, ordered to minimise model swaps
 * Every generation is best-effort: a failed presenter clip demotes its
 * scene to narrated (its Kokoro audio already exists), a failed image falls
 * back to a gradient background, missing music/sfx are simply omitted.
 */

import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { textToSpeech } from '../../services/ttsService.js';
import { generateImage } from '../comfyClient.js';
import { generateTalkingHead } from '../talkingHeadClient.js';
import { generateMusic, generateSfx } from '../musicClient.js';
import { probeDuration } from './hyperframesCli.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');
const VOICE_SAMPLE_TEXT = 'This is a short sample of my natural speaking voice, recorded for reference.';
const MAX_CLIP_SECONDS = 12;
// Krea 2 happily renders fake UI, gibberish text and real brand logos when a
// prompt mentions dashboards/apps — fatal behind on-screen text. Backgrounds
// are atmosphere only.
const BACKGROUND_SUFFIX = ', atmospheric background photograph, soft focus, shallow depth of field, no text, no letters, no numbers, no logos, no user interface, no screens';

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
 * Phase 1 (no GPU): Kokoro for every spoken line + the voice sample.
 * Mutates `assets[i]` with { ttsFile, ttsDur } and returns { voice, voiceRefFile }.
 */
export async function voicePhase(dir, plan, assets, { voice, onProgress = () => {} }) {
  const chosen = voice || pickVoice(plan.presenter?.description);
  onProgress(`Recording voiceover (${chosen})…`);
  for (const [i, scene] of plan.scenes.entries()) {
    if (!scene.speech) continue;
    const wav = await textToSpeech(scene.speech, { voice: chosen });
    const rel = `assets/vo-${i}.wav`;
    writeFileSync(join(dir, rel), wav);
    assets[i].ttsFile = rel;
    assets[i].ttsDur = await probeDuration(join(dir, rel));
    if (scene.type === 'presenter') assets[i].clipSeconds = clipSecondsFor(assets[i].ttsDur);
    else { assets[i].voiceFile = rel; assets[i].voiceDur = assets[i].ttsDur; }
  }
  let voiceRefFile = null;
  if (plan.scenes.some(s => s.type === 'presenter')) {
    voiceRefFile = 'assets/voiceref.wav';
    writeFileSync(join(dir, voiceRefFile), await textToSpeech(VOICE_SAMPLE_TEXT, { voice: chosen }));
  }
  return { voice: chosen, voiceRefFile };
}

/** Demote a presenter scene to narrated, reusing its Kokoro read. */
function demote(plan, assets, i) {
  plan.scenes[i].type = 'narrated';
  assets[i].voiceFile = assets[i].ttsFile;
  assets[i].voiceDur = assets[i].ttsDur;
  delete assets[i].clipFile;
}

/**
 * Phase 2: everything ComfyUI. Caller owns ensureComfyRunning()/freeComfyMemory().
 * @param {number} musicSeconds  final timeline length (known before this phase)
 * @returns {{musicFile?: string, warnings: string[]}}
 */
export async function comfyPhase(dir, plan, assets, { endpoint, voiceRefFile, musicSeconds, seed, onProgress = () => {} }) {
  const warnings = [];
  const warn = (msg) => { warnings.push(msg); onProgress(`⚠ ${msg}`); };
  const presenterIdx = plan.scenes.map((s, i) => (s.type === 'presenter' ? i : -1)).filter(i => i >= 0);

  // ── Krea 2: portrait + narrated backgrounds ─────────────────────────
  let portrait = null;
  if (presenterIdx.length) {
    onProgress('Generating presenter portrait…');
    try {
      const out = await generateImage(endpoint, portraitPrompt(plan.presenter.description), '', 600_000, 'krea2', 'landscape');
      const buf = await fetchComfyOutput(endpoint, out);
      writeFileSync(join(dir, 'assets/portrait.png'), buf);
      portrait = { name: `portrait-${seed}.png`, dataUrl: dataUrl(buf, 'image/png') };
    } catch (err) {
      warn(`presenter portrait failed (${err.message}) — presenter scenes become narrated`);
      presenterIdx.forEach(i => demote(plan, assets, i));
    }
  }
  const narrated = plan.scenes.map((s, i) => (s.type === 'narrated' && s.image_prompt ? i : -1)).filter(i => i >= 0);
  for (const [k, i] of narrated.entries()) {
    onProgress(`Generating background image ${k + 1}/${narrated.length}…`);
    try {
      const out = await generateImage(endpoint, `${plan.scenes[i].image_prompt}${BACKGROUND_SUFFIX}`, '', 600_000, 'krea2', 'landscape');
      writeFileSync(join(dir, `assets/img-${i}.png`), await fetchComfyOutput(endpoint, out));
      assets[i].imageFile = `assets/img-${i}.png`;
    } catch (err) {
      warn(`image for scene ${i + 1} failed (${err.message}) — using a gradient`);
    }
  }

  // ── LTX-2.3 ID-LoRA: presenter clips ────────────────────────────────
  if (portrait) {
    const voiceRef = { name: `voiceref-${seed}.wav`, dataUrl: dataUrl(readFileSync(join(dir, voiceRefFile)), 'audio/wav') };
    const live = plan.scenes.map((s, i) => (s.type === 'presenter' ? i : -1)).filter(i => i >= 0);
    for (const [k, i] of live.entries()) {
      onProgress(`Generating presenter clip ${k + 1}/${live.length} (${assets[i].clipSeconds}s)…`);
      try {
        const out = await generateTalkingHead(endpoint, {
          portrait, voiceRef,
          visual: presenterVisual(plan.presenter.description),
          speech: plan.scenes[i].speech,
          sounds: 'Clear, warm, confident voice, moderate volume, close to the microphone. Quiet room tone.',
          seconds: assets[i].clipSeconds, seed,
        });
        writeFileSync(join(dir, `assets/presenter-${i}.mp4`), await fetchComfyOutput(endpoint, out));
        dropCache('videos', out.filename);
        assets[i].clipFile = `assets/presenter-${i}.mp4`;
        assets[i].clipDur = await probeDuration(join(dir, assets[i].clipFile));
      } catch (err) {
        warn(`presenter clip for scene ${i + 1} failed (${err.message}) — narrating it instead`);
        demote(plan, assets, i);
      }
    }
  }

  // ── ACE-Step: music bed ─────────────────────────────────────────────
  let musicFile;
  onProgress(`Composing ${Math.ceil(musicSeconds)}s music bed…`);
  try {
    const out = await generateMusic(endpoint, plan.music.prompt, '', Math.ceil(musicSeconds) + 1, 600_000);
    writeFileSync(join(dir, 'assets/music.flac'), await fetchComfyOutput(endpoint, out));
    dropCache('audio', out.filename);
    musicFile = 'assets/music.flac';
  } catch (err) {
    warn(`music failed (${err.message}) — no music bed`);
  }

  // ── Stable Audio 3: transition sfx (deduped by prompt) ───────────────
  const sfxByPrompt = new Map();
  for (const [i, scene] of plan.scenes.entries()) {
    if (!scene.sfx) continue;
    try {
      if (!sfxByPrompt.has(scene.sfx)) {
        onProgress(`Generating sound effect "${scene.sfx}"…`);
        const out = await generateSfx(endpoint, `${scene.sfx}, clean, short, no music`, 1.5, 300_000);
        const rel = `assets/sfx-${sfxByPrompt.size}.flac`;
        writeFileSync(join(dir, rel), await fetchComfyOutput(endpoint, out));
        dropCache('audio', out.filename);
        sfxByPrompt.set(scene.sfx, rel);
      }
      assets[i].sfxFile = sfxByPrompt.get(scene.sfx);
    } catch (err) {
      warn(`sound effect "${scene.sfx}" failed (${err.message})`);
      sfxByPrompt.set(scene.sfx, undefined);
    }
  }

  return { musicFile, warnings };
}
