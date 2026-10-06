/**
 * Pronunciation overrides for spoken text only.
 *
 * Kokoro (and LTX's generated presenter speech) guess how unfamiliar names
 * sound — "TheiaCast" came out as "THAY-uh-cast" (θˈeɪə kˈast). A respelling
 * fixes it: "Theeahcast" → θˈiːɑːkˌast ("thee-ah-cast"). Respellings apply to
 * the audio only; captions and on-screen text keep the real spelling.
 *
 * Sources, merged (later wins): config/pronunciations.json (shared) → the
 * plan's own `pronunciations` (from the client's chat feedback).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEXICON_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'pronunciations.json');
const MAX_ENTRIES = 40;

/**
 * Turn a human pronunciation hint into a TTS-friendly respelling.
 * Hyphens/spaces between syllables are dropped ("thee-ah-cast" → "Theeahcast"):
 * the split form makes the phonemizer read "thee" like "the" (ð), and pause.
 */
export function normalizeRespelling(hint) {
  const s = String(hint ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (!s || s.length > 60 || /[<>{}]/.test(s)) return '';
  const joined = /^[\p{L}]+([- ][\p{L}]+)+$/u.test(s) ? s.replace(/[- ]/g, '') : s;
  return joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase();
}

/** Keep only sane {word: respelling} string pairs. */
export function cleanLexicon(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [word, hint] of Object.entries(raw)) {
    if (word.startsWith('_') || typeof hint !== 'string') continue;
    const w = word.trim();
    const r = normalizeRespelling(hint);
    if (w && r && w.length <= 60 && Object.keys(out).length < MAX_ENTRIES) out[w] = r;
  }
  return out;
}

export function loadLexicon(planPronunciations = {}) {
  let shared = {};
  try {
    if (existsSync(LEXICON_FILE)) shared = JSON.parse(readFileSync(LEXICON_FILE, 'utf8'));
  } catch { /* bad file — ignore rather than break TTS */ }
  return { ...cleanLexicon(shared), ...cleanLexicon(planPronunciations) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace whole-word occurrences (case-insensitive), longest keys first. */
export function applyPronunciations(text, lexicon) {
  let out = String(text ?? '');
  for (const word of Object.keys(lexicon).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'giu'), lexicon[word]);
  }
  return out;
}
