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
    else if (hint && typeof hint === 'object') {
      // tts may list alternatives (retried in order when a take is heard wrong);
      // heard / notHeard = how right and wrong takes transcribe (whisper).
      const strs = (v) => (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, 6);
      const e = {};
      if (strs(hint.tts).length) e.tts = Array.isArray(hint.tts) ? strs(hint.tts) : strs(hint.tts)[0];
      if (typeof hint.presenter === 'string' && hint.presenter.trim()) e.presenter = hint.presenter.trim();
      if (strs(hint.heard).length) e.heard = strs(hint.heard);
      if (strs(hint.notHeard).length) e.notHeard = strs(hint.notHeard);
      if (e.tts || e.presenter) out[w] = e;
    }
  }
  return out;
}

/**
 * The respelling map for one engine ('tts' | 'presenter'). `variant` picks
 * among listed tts alternatives (0 = preferred) — used for re-takes.
 */
export function lexiconFor(lexicon, engine, variant = 0) {
  const out = {};
  for (const [w, v] of Object.entries(lexicon)) {
    const pick = (x) => (Array.isArray(x) ? x[variant % x.length] : x);
    const r = typeof v === 'string'
      ? (engine === 'presenter' ? presenterRespelling(v) : normalizeRespelling(v))
      : (pick(v[engine]) ?? '');
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

// ── Did the voice actually say it right? ────────────────────────────────
// VoxCPM2 samples, so the same respelling comes out differently line to line
// ("Theea cast" was heard as "TheaCast", "VA Cast", "Satya Cast" in one video).
// The pipeline transcribes each take and re-records the ones that drift.

const letters = (s) => String(s ?? '').toLowerCase().replace(/\.(com|io|net|org|ai|app|co|uk)\b/g, '').replace(/[^a-z]/g, '');

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * How far the transcript is from saying the word right (0 = perfect, ~0.25+
 * = wrong). Every 1-3 word window of the transcript is compared with how a
 * correct take transcribes (`good`); a window closer to a known-wrong form
 * (`bad`, e.g. "theeacast" for a literal "thee-ee-ay") counts as wrong —
 * edit distance alone can't tell those apart.
 * @param {string[]} heard  transcript words
 * @param {{good: string[], bad?: string[], count?: number}} check
 */
export function mispronunciation(heard, { good, bad = [], count: occurrences = 1 }) {
  const targets = good.map(letters).filter(Boolean);
  const wrong = bad.map(letters).filter(Boolean);
  const w = heard.map(letters);
  const windows = [];
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= 3 && i + n <= w.length; n++) {
      const cand = w.slice(i, i + n).join('');
      if (!cand) continue;
      const d = Math.min(...targets.map(t => editDistance(cand, t) / t.length));
      const dBad = wrong.length ? Math.min(...wrong.map(t => editDistance(cand, t) / t.length)) : Infinity;
      windows.push({ i, n, d: dBad < d ? 1 : d });
    }
  }
  // Every occurrence must be said right: score = the worst of the best
  // non-overlapping matches, one per occurrence.
  windows.sort((a, b) => a.d - b.d);
  const taken = []; const used = new Set();
  for (const win of windows) {
    if (taken.length >= occurrences) break;
    const span = Array.from({ length: win.n }, (_, k) => win.i + k);
    if (span.some(x => used.has(x))) continue;
    span.forEach(x => used.add(x)); taken.push(win.d);
  }
  return taken.length < occurrences ? 1 : Math.max(...taken);
}

/** Respellings of every lexicon word the line contains: [{word, sounds}] */
export function wordsToCheck(text, lexicon) {
  return Object.entries(lexicon)
    .filter(([w]) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu').test(String(text ?? '')))
    .map(([w, v]) => ({
      word: w,
      // What a right take transcribes as: listed "heard" forms if any, else the word and its respellings.
      good: [w, ...(typeof v === 'string' ? [v] : (v.heard ?? [v.tts, v.presenter].flat().filter(Boolean)))],
      bad: typeof v === 'string' ? [] : (v.notHeard ?? []),
      count: (String(text).match(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'giu')) ?? []).length,
    }));
}
