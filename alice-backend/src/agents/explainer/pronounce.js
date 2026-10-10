/**
 * Pronunciation overrides for spoken text only.
 *
 * Kokoro (and LTX's generated presenter speech) guess how unfamiliar names
 * sound — "TheiaCast" came out as "THAY-uh-cast" (θˈeɪə kˈast). A respelling
 * fixes it: "Theeahcast" → θˈiːɑːkˌast ("thee-ah-cast"). Respellings apply to
 * the audio only; captions and on-screen text keep the real spelling.
 *
 * The two speech engines need DIFFERENT respellings:
 *   tts        Kokoro phonemizes text: hyphenated "Thee-ah-cast" reads the
 *              first syllable like "the" (ð), so syllables are joined →
 *              "Theeahcast".
 *   presenter  LTX-2.3 reads more like a person: it said "Theeahcast" as
 *              "thee-you-cast", so it gets the hyphenated hint "Thee-ah-cast".
 * Entries are either a plain hint ("thee-ah-cast" — both forms derived from
 * it) or explicit { "tts": "...", "presenter": "..." }.
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

/** Presenter (LTX) form: keep syllable breaks, hyphenated, capitalised. */
export function presenterRespelling(hint) {
  const s = String(hint ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '');
  if (!s || s.length > 60 || /[<>{}]/.test(s)) return '';
  const hyph = s.replace(/\s+/g, '-').toLowerCase();
  return hyph.charAt(0).toUpperCase() + hyph.slice(1);
}

/** Keep only sane entries. Plain hints are kept as given (raw form). */
export function cleanLexicon(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [word, hint] of Object.entries(raw)) {
    const w = word.trim();
    if (!w || w.startsWith('_') || w.length > 60 || Object.keys(out).length >= MAX_ENTRIES) continue;
    if (typeof hint === 'string' && normalizeRespelling(hint)) out[w] = hint.trim();
    else if (hint && typeof hint === 'object' && (typeof hint.tts === 'string' || typeof hint.presenter === 'string')) {
      out[w] = { ...(typeof hint.tts === 'string' ? { tts: hint.tts.trim() } : {}), ...(typeof hint.presenter === 'string' ? { presenter: hint.presenter.trim() } : {}) };
    }
  }
  return out;
}

/** The respelling map for one engine ('tts' | 'presenter'). */
export function lexiconFor(lexicon, engine) {
  const out = {};
  for (const [w, v] of Object.entries(lexicon)) {
    const r = typeof v === 'string'
      ? (engine === 'presenter' ? presenterRespelling(v) : normalizeRespelling(v))
      : (v[engine] ?? '');
    if (r) out[w] = r;
  }
  return out;
}

export function loadLexicon(planPronunciations = {}) {
  let shared = {};
  try {
    if (existsSync(LEXICON_FILE)) shared = JSON.parse(readFileSync(LEXICON_FILE, 'utf8'));
  } catch { /* bad file — ignore rather than break TTS */ }
  // The shared file holds respellings verified by ear per engine; a plan's
  // own guess for the same word (e.g. the LLM turning "thee-uh-cast" into
  // "Theeuhcast") must not override them.
  const curated = cleanLexicon(shared);
  const known = new Set(Object.keys(curated).map(k => k.toLowerCase()));
  const extra = Object.fromEntries(Object.entries(cleanLexicon(planPronunciations)).filter(([k]) => !known.has(k.toLowerCase())));
  return { ...extra, ...curated };
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
