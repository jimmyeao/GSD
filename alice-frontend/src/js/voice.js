/**
 * Voice utilities — speech recognition (input) and Kokoro TTS (output).
 */

import { getCsrfToken } from './auth.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// TTS is a POST → it needs the CSRF header to pass the backend's double-submit
// cookie check. Reads the cookie fresh on every call so rotations are handled.
function _ttsHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const csrf = getCsrfToken();
  if (csrf) h['X-CSRF-Token'] = csrf;
  return h;
}

// Kill orphaned audio on load
window.speechSynthesis?.cancel();
const _allAudio = new Set();
window.addEventListener('beforeunload', () => _allAudio.forEach(a => { try { a.pause(); } catch {} }));

// ── Speaking state ────────────────────────────────────────────────
// Lets the UI show a Stop control for as long as Alice is audibly (or about
// to be) talking — including after the LLM stream has finished.
const _speakListeners = new Set();
let _lastActive = false;

/** True while a single utterance or the streaming queue has audio pending/playing. */
export function isSpeechActive() {
  return !!_abort || isSpeaking() || !!(_queue && (_queue.active || _queue._fetching > 0));
}

/** Subscribe to speaking on/off transitions. cb(active: boolean) */
export function onSpeakingChange(cb) { _speakListeners.add(cb); }

function _emitSpeaking() {
  const a = isSpeechActive();
  if (a === _lastActive) return;
  _lastActive = a;
  _speakListeners.forEach(cb => { try { cb(a); } catch {} });
}

export function isSupported() {
  return { recognition: !!SpeechRecognition, synthesis: true };
}

// ── Speech Recognition ────────────────────────────────────────────

export function createRecognition(opts = {}) {
  if (!SpeechRecognition) {
    return { start() { opts.onError?.('Speech recognition not supported'); }, stop() {}, get isActive() { return false; } };
  }
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = opts.lang || 'en-GB';
  let active = false, full = '';

  rec.onresult = (e) => {
    let fin = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) fin += t; else interim += t;
    }
    if (interim) opts.onInterim?.(interim);
    if (fin) { full += fin; opts.onResult?.(fin); }
  };
  rec.onend = () => { active = false; if (full.trim()) opts.onComplete?.(full.trim()); full = ''; opts.onEnd?.(); };
  rec.onerror = (e) => { active = false; full = ''; if (e.error !== 'aborted' && e.error !== 'no-speech') opts.onError?.(e.error === 'not-allowed' ? 'Microphone access denied' : e.error); opts.onEnd?.(); };

  return {
    start() { if (!active) { active = true; full = ''; rec.start(); } },
    stop() { if (active) rec.stop(); },
    get isActive() { return active; },
  };
}

// ── TTS Backend ───────────────────────────────────────────────────

let _backendUrl = '';
export function setTTSBackend(url) { _backendUrl = url; }

// ── Single utterance speak ────────────────────────────────────────

let _audio = null;
let _abort = null;

export function isSpeaking() { return !!_audio && !_audio.paused; }

// Agents write status/progress as quoted lines ("> Looking up list events…") so they show in
// the chat; those are for reading, never for speaking.
const _stripStatusLines = (text) => String(text ?? '').replace(/^[ \t]*>[^\n]*\n?/gm, '');

export function speak(text, opts = {}) {
  stopSpeaking();
  text = _stripStatusLines(text);
  if (!text?.trim()) { opts.onEnd?.(); return; }

  const url = opts.backendUrl || _backendUrl;
  if (!url) { _browserSpeak(text, opts); return; }

  _abort = new AbortController();
  _emitSpeaking();
  fetch(`${url}/tts`, {
    method: 'POST',
    headers: _ttsHeaders(),
    credentials: 'include',
    body: JSON.stringify({ text, speed: opts.speed }),
    signal: _abort.signal,
  })
  .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
  .then(blob => {
    if (!_abort) return;
    _audio = _playBlob(blob, () => { _audio = null; _abort = null; opts.onEnd?.(); _emitSpeaking(); });
    _emitSpeaking();
  })
  .catch(() => { if (_abort) _browserSpeak(text, opts); });
}

export function stopSpeaking() {
  if (_abort) { _abort.abort(); _abort = null; }
  if (_audio) { _audio.pause(); _audio.src = ''; _audio = null; }
  _allAudio.forEach(a => { try { a.pause(); a.src = ''; } catch {} });
  _allAudio.clear();
  window.speechSynthesis?.cancel();
  // Also stop the speech queue
  if (_queue) _queue.stop();
  _emitSpeaking();
}

// ── Streaming Speech Queue ────────────────────────────────────────
// Accepts text incrementally, splits into sentences, speaks them in order.

let _queue = null;

/** Get (or create) the global speech queue. */
export function getSpeechQueue() {
  if (!_queue) _queue = new SpeechQueue();
  return _queue;
}

class SpeechQueue {
  constructor() {
    this._pending = '';           // partial chunk buffer
    this._textQueue = [];         // text chunks waiting to be fetched
    this._audioQueue = [];        // pre-fetched blobs ready to play
    this._fetching = 0;           // number of in-flight fetches
    // Fetches finish in whatever order the TTS server answers (the cloned voice varies a lot),
    // but speech must play in sentence order: each fetch gets a sequence number and its audio
    // waits in _ready until every earlier sentence has arrived (or failed).
    this._seq = 0;                // next sequence number to hand out
    this._nextSeq = 0;            // next sequence number allowed to play
    this._ready = new Map();      // seq → blob, or null if that fetch failed
    this._gen = 0;                // bumped on stop() so late results from a cancelled turn are ignored
    this._lineStart = true;       // for the status-line filter: are we at the start of a line?
    this._skipLine = false;       // …and are we inside a "> status" line that must not be spoken?
    this._playing = false;
    this._stopped = false;
    this._currentAudio = null;
    this._nextAudio = null;
    this._aborts = new Set();
    this._timer = null;
    this._MAX_PREFETCH = 3;
  }

  /** Feed new text chunk from streaming. Batches into decent-sized paragraphs. */
  push(text) {
    if (this._stopped) return;
    text = this._filterStatus(text);
    if (!text) return;
    this._pending += text;

    // Reset the flush timer on each push
    clearTimeout(this._timer);

    // Try to split on sentence endings once we have enough text
    if (this._pending.length >= 80) {
      const sentenceEnd = this._pending.search(/[.!?]\s/);
      if (sentenceEnd >= 40) {
        const splitAt = sentenceEnd + 1;
        this._enqueue(this._pending.slice(0, splitAt));
        this._pending = this._pending.slice(splitAt).trimStart();
        return;
      }
      // No sentence boundary but buffer is large — split at last space
      if (this._pending.length > 200) {
        const sp = this._pending.lastIndexOf(' ', 180);
        if (sp > 40) {
          this._enqueue(this._pending.slice(0, sp));
          this._pending = this._pending.slice(sp + 1);
          return;
        }
      }
    }

    // Safety: if no split happened, flush after 2s of no new tokens
    this._timer = setTimeout(() => {
      if (!this._stopped && this._pending.trim().length > 5) {
        this._enqueue(this._pending);
        this._pending = '';
      }
    }, 2000);
  }

  /**
   * Drop "> status" lines. Stateful, because LLM tokens can split a line anywhere
   * ("> " in one token, the words in the next).
   */
  _filterStatus(text) {
    let out = '';
    for (const ch of text) {
      if (this._skipLine) {
        if (ch === '\n') { this._skipLine = false; this._lineStart = true; out += ch; }
        continue;
      }
      if (this._lineStart && ch === '>') { this._skipLine = true; continue; }
      out += ch;
      this._lineStart = ch === '\n' || (this._lineStart && (ch === ' ' || ch === '\t'));
    }
    return out;
  }

  _enqueue(text) {
    // Clean markdown artifacts that make speech awkward
    const clean = text.trim()
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^[-*•]\s+/gm, '')           // bullet markers
      .replace(/^#{1,6}\s+/gm, '')           // heading markers
      .replace(/^\d+\.\s+/gm, '')            // numbered list markers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/[|>\-]{2,}/g, ' ')           // table/hr separators
      .replace(/\n+/g, '. ')                 // newlines to pauses
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length > 5) {
      this._textQueue.push(clean);
      this._prefetch();
      this._playNext();
      _emitSpeaking();
    }
  }

  /** Flush remaining text. */
  flush() {
    if (this._stopped) return;
    if (this._pending.trim().length > 3) {
      this._enqueue(this._pending);
      this._pending = '';
    }
  }

  /** Reset for a new stream. */
  reset() { this.stop(); this._stopped = false; }

  get active() { return this._playing || this._audioQueue.length > 0 || this._textQueue.length > 0; }

  /** Pre-fetch audio for upcoming text chunks (up to MAX_PREFETCH in parallel). */
  _prefetch() {
    while (this._textQueue.length > 0 && this._fetching < this._MAX_PREFETCH && !this._stopped) {
      const text = this._textQueue.shift();
      const seq = this._seq++;
      const gen = this._gen;
      this._fetching++;
      const abort = new AbortController();
      this._aborts.add(abort);

      fetch(`${_backendUrl}/tts`, {
        method: 'POST',
        headers: _ttsHeaders(),
        credentials: 'include',
        body: JSON.stringify({ text }),
        signal: abort.signal,
      })
      .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
      .then(blob => {
        this._aborts.delete(abort);
        if (gen !== this._gen) return; // belongs to a turn that has since been stopped
        this._fetching--;
        if (!this._stopped) {
          this._ready.set(seq, blob);
          this._drainReady();
          this._playNext();
          this._prefetch(); // fill more slots
        }
        _emitSpeaking();
      })
      .catch(() => {
        this._aborts.delete(abort);
        if (gen !== this._gen) return;
        this._fetching--;
        this._ready.set(seq, null); // don't let one failed sentence block the ones after it
        this._drainReady();
        this._playNext();
        this._prefetch();
        _emitSpeaking();
      });
    }
  }

  /** Move audio to the play queue strictly in sentence order, stopping at the first gap. */
  _drainReady() {
    while (this._ready.has(this._nextSeq)) {
      const blob = this._ready.get(this._nextSeq);
      this._ready.delete(this._nextSeq);
      this._nextSeq++;
      if (blob) this._audioQueue.push(blob);
    }
  }

  /** Play the next pre-fetched audio blob. Pre-loads the one after. */
  _playNext() {
    if (this._stopped || this._playing || !this._audioQueue.length) return;
    this._playing = true;
    const blob = this._audioQueue.shift();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _allAudio.add(audio);
    this._currentAudio = audio;

    // Pre-load the next audio element while this one plays
    this._preloadNext();

    audio.onended = () => {
      _allAudio.delete(audio);
      URL.revokeObjectURL(url);
      this._currentAudio = null;
      this._playing = false;
      // If we have a preloaded audio ready, play it immediately
      if (this._nextAudio && !this._stopped) {
        this._playing = true;
        this._currentAudio = this._nextAudio;
        this._nextAudio = null;
        this._currentAudio.play().catch(() => {});
        this._currentAudio.onended = audio.onended; // reuse same handler chain
        this._preloadNext();
      } else {
        this._playNext();
      }
      _emitSpeaking();
    };
    audio.onerror = audio.onended;
    audio.play().catch(() => { this._playing = false; });
  }

  /** Pre-load the next audio blob into an Audio element so it plays instantly. */
  _preloadNext() {
    if (this._stopped || this._nextAudio || !this._audioQueue.length) return;
    const blob = this._audioQueue.shift();
    const url = URL.createObjectURL(blob);
    this._nextAudio = new Audio(url);
    this._nextAudio._blobUrl = url;
    _allAudio.add(this._nextAudio);
    // Preload the audio data
    this._nextAudio.preload = 'auto';
    this._nextAudio.load();
  }

  stop() {
    this._stopped = true;
    this._textQueue = [];
    this._audioQueue = [];
    this._pending = '';
    this._playing = false;
    this._fetching = 0;
    this._gen++;
    this._seq = 0;
    this._nextSeq = 0;
    this._ready.clear();
    this._lineStart = true;
    this._skipLine = false;
    clearTimeout(this._timer);
    this._aborts.forEach(a => a.abort());
    this._aborts.clear();
    if (this._currentAudio) { _allAudio.delete(this._currentAudio); this._currentAudio.pause(); this._currentAudio.src = ''; this._currentAudio = null; }
    if (this._nextAudio) { _allAudio.delete(this._nextAudio); URL.revokeObjectURL(this._nextAudio._blobUrl); this._nextAudio = null; }
    _emitSpeaking();
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function _playBlob(blob, onEnd) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  _allAudio.add(audio);
  audio.onended = () => { _allAudio.delete(audio); URL.revokeObjectURL(url); onEnd?.(); };
  audio.onerror = () => { _allAudio.delete(audio); URL.revokeObjectURL(url); onEnd?.(); };
  audio.play().catch(() => onEnd?.());
  return audio;
}

function _browserSpeak(text, opts = {}) {
  if (!window.speechSynthesis) { opts.onEnd?.(); return; }
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/#{1,6}\s*/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, ' ').replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/[>\-|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) { opts.onEnd?.(); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = opts.speed ?? 1.0; u.lang = 'en-GB';
  u.onend = () => opts.onEnd?.(); u.onerror = () => opts.onEnd?.();
  window.speechSynthesis.speak(u);
}
