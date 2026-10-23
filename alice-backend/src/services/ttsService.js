/**
 * TTS service — proxies to the persistent Kokoro TTS server.
 * Falls back to Piper CLI if Kokoro server is unavailable.
 */
import { loadLexicon, lexiconFor, applyPronunciations } from '../agents/explainer/pronounce.js';
import { voxcpmAvailable, voxcpmSpeak } from './voxcpmClient.js';

const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:5100';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'jarvis';

// The Jarvis Piper voice (trained on 300 sentences) can't say "pass-" — Whisper
// heard "pesky"/"custody" for passkey. Respellings verified by transcription
// 2026-10-23. Jarvis only: Kokoro says these words fine.
const JARVIS_RESPELLINGS = {
  passkeys: 'pahss keez',
  passkey: 'pahss kee',
  passwords: 'pahs words',
  password: 'pahs word',
};

const JARVIS_CLONE_VOICE = 'bm_jarvis'; // refs/bm_jarvis.{wav,txt} on the VoxCPM host
const CLONE_TIMEOUT_MS = 60_000;        // per chunk, counted from when it starts; covers the ~12 s cold load
const CLONE_MAX_CHARS = 260;            // keeps one request to a few seconds (1000 chars took 23 s)
const HEALTH_TTL_MS = 30_000;
const WARM_EVERY_MS = 5 * 60_000;
let _cloneHealth = { at: 0, ok: false };

/** voxcpmAvailable() hits /health, so cache the answer briefly (one call per sentence otherwise). */
async function cloneAvailable() {
  if (Date.now() - _cloneHealth.at > HEALTH_TTL_MS) {
    _cloneHealth = { at: Date.now(), ok: await voxcpmAvailable(JARVIS_CLONE_VOICE) };
  }
  return _cloneHealth.ok;
}

// VoxCPM serialises requests on the laptop, so queue them here too. Otherwise
// the browser's parallel prefetch makes later chunks sit behind earlier ones,
// time out, and get spoken by the Piper voice — a different voice mid-reply.
let _cloneChain = Promise.resolve();
function enqueueClone(fn) {
  const run = _cloneChain.then(fn, fn);
  _cloneChain = run.catch(() => {});
  return run;
}

/** Split into sentence-sized pieces of at most `max` chars. */
function splitForClone(text, max = CLONE_MAX_CHARS) {
  const out = [];
  let cur = '';
  const push = (s) => { if (s.trim()) out.push(s.trim()); };
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      push(cur); cur = '';
      let rest = sentence;
      while (rest.length > max) {
        const cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf(' ', max));
        const at = cut > max / 3 ? cut + 1 : max;
        push(rest.slice(0, at)); rest = rest.slice(at);
      }
      cur = rest;
    } else if ((cur + ' ' + sentence).trim().length > max) {
      push(cur); cur = sentence;
    } else {
      cur = (cur + ' ' + sentence).trim();
    }
  }
  push(cur);
  return out;
}

/** Locate the PCM format fields and data of a WAV buffer. */
function wavParts(buf) {
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = buf.subarray(p + 8, p + 24);
    if (id === 'data') return { fmt, data: buf.subarray(p + 8, Math.min(p + 8 + size, buf.length)) };
    p += 8 + size + (size & 1);
  }
  throw new Error('bad WAV from VoxCPM');
}

/** Concatenate PCM WAVs (same format) with a short pause between. */
function joinWavs(bufs, gapMs = 120) {
  if (bufs.length === 1) return bufs[0];
  const parts = bufs.map(wavParts);
  const fmt = parts[0].fmt;
  const gap = Buffer.alloc(Math.round(fmt.readUInt32LE(4) * gapMs / 1000) * fmt.readUInt16LE(2) * (fmt.readUInt16LE(14) / 8));
  const data = Buffer.concat(parts.flatMap((p, i) => (i ? [gap, p.data] : [p.data])));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); fmt.copy(head, 20);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function cloneSpeak(text) {
  const wavs = [];
  for (const piece of splitForClone(text)) {
    wavs.push(await enqueueClone(() => withTimeout(voxcpmSpeak(piece, JARVIS_CLONE_VOICE), CLONE_TIMEOUT_MS)));
  }
  return joinWavs(wavs);
}

let _lastWarm = 0;
/**
 * Load the VoxCPM model ahead of the first spoken reply (call when someone opens
 * Alice). No-op unless the clone voice is the default; throttled; never throws.
 */
export function warmTts() {
  if (KOKORO_VOICE !== 'jarvis-clone' || Date.now() - _lastWarm < WARM_EVERY_MS) return;
  _lastWarm = Date.now();
  cloneAvailable()
    .then(ok => ok && enqueueClone(() => withTimeout(voxcpmSpeak('Ready.', JARVIS_CLONE_VOICE), CLONE_TIMEOUT_MS)))
    .catch(err => console.warn(`[tts] warm-up failed: ${err.message}`));
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Convert text to speech. Returns a WAV buffer.
 * @param {string} text
 * @param {object} opts - { speed, voice }
 * @returns {Promise<Buffer>} WAV audio data
 */
export async function textToSpeech(text, opts = {}) {
  // Shared pronunciation respellings (config/pronunciations.json), e.g.
  // TheiaCast → "Theeahcast". Idempotent, so callers that already applied a
  // larger lexicon (the explainer pipeline) are unaffected.
  let voice = opts.voice || KOKORO_VOICE;
  let clean = applyPronunciations(cleanText(text), lexiconFor(loadLexicon(), 'tts'));
  if (!clean) return Buffer.alloc(0);

  // 'jarvis-clone' = Jarvis cloned by VoxCPM2 on the laptop GPU: far better
  // pronunciation than the Piper model, but ~1x real time and the GPU is shared
  // with ComfyUI. Anything going wrong falls back to the Piper Jarvis voice.
  if (voice === 'jarvis-clone') {
    try {
      if (await cloneAvailable()) return await cloneSpeak(clean);
    } catch (err) {
      console.warn(`[tts] jarvis-clone failed, using Piper Jarvis: ${err.message}`);
    }
    voice = 'jarvis';
  }
  if (voice === 'jarvis') clean = applyPronunciations(clean, JARVIS_RESPELLINGS);

  const res = await fetch(KOKORO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: clean,
      voice,
      speed: opts.speed ?? 1.0,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`TTS server error: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Strip markdown for cleaner speech. */
function cleanText(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, ' image ')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    // IPv4: read digit by digit ("1 9 2 dot 1 6 8…") instead of "one hundred ninety two point…"
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, ip => ip.replace(/\./g, ' dot ').replace(/\d/g, d => d + ' ').replace(/\s+/g, ' ').trim())
    .replace(/[>\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
