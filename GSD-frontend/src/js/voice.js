/**
 * Voice utilities — speech recognition (input) and synthesis (output).
 * Uses browser-native Web Speech API — works in Chrome, Edge, Safari.
 */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Kill any orphaned audio from previous sessions on load
window.speechSynthesis?.cancel();

// Track ALL audio elements created by TTS so we can always stop them
const _allAudioElements = new Set();
window.addEventListener('beforeunload', () => {
  _allAudioElements.forEach(a => { try { a.pause(); a.src = ''; } catch {} });
});

/** Check if voice features are supported. */
export function isSupported() {
  return { recognition: !!SpeechRecognition, synthesis: !!window.speechSynthesis };
}

/**
 * Create a speech recognition session.
 * @param {object} opts
 * @param {function} opts.onResult - called with final transcript string
 * @param {function} opts.onInterim - called with interim transcript while speaking
 * @param {function} opts.onEnd - called when recognition stops
 * @param {function} opts.onError - called with error message
 * @param {string} opts.lang - language code (default 'en-GB')
 * @returns {{ start, stop, isActive }} controller
 */
export function createRecognition(opts = {}) {
  if (!SpeechRecognition) {
    return { start() { opts.onError?.('Speech recognition not supported in this browser'); }, stop() {}, get isActive() { return false; } };
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = opts.lang || 'en-GB';
  recognition.maxAlternatives = 1;
  let active = false;
  let fullTranscript = '';

  recognition.onresult = (event) => {
    let final = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += transcript;
      else interim += transcript;
    }
    if (interim) opts.onInterim?.(interim);
    if (final) { fullTranscript += final; opts.onResult?.(final); }
  };

  recognition.onend = () => {
    active = false;
    // Auto-send: when recognition ends naturally (silence), fire onComplete with full transcript
    if (fullTranscript.trim()) {
      opts.onComplete?.(fullTranscript.trim());
    }
    fullTranscript = '';
    opts.onEnd?.();
  };
  recognition.onerror = (e) => {
    active = false;
    fullTranscript = '';
    if (e.error !== 'aborted' && e.error !== 'no-speech') {
      opts.onError?.(e.error === 'not-allowed' ? 'Microphone access denied' : `Speech error: ${e.error}`);
    }
    opts.onEnd?.();
  };

  return {
    start() { if (!active) { active = true; fullTranscript = ''; recognition.start(); } },
    stop() { if (active) { recognition.stop(); } },
    get isActive() { return active; },
  };
}

/**
 * Speak text using backend Piper TTS.
 * Falls back to browser speechSynthesis if backend is unavailable.
 * @param {string} text - text to speak
 * @param {object} opts
 * @param {string} opts.backendUrl - backend base URL (required for Piper)
 * @param {function} opts.onEnd - called when speech finishes
 * @param {number} opts.speed - speech speed multiplier (default 1.0)
 * @returns {{ cancel }} controller
 */
let _defaultBackendUrl = '';
let _activeAudio = null;
let _activeAbort = null;

/** Set the default backend URL for TTS. Call once at startup. */
export function setTTSBackend(url) { _defaultBackendUrl = url; }

/** Whether Alice is currently speaking. */
export function isSpeaking() { return !!_activeAudio && !_activeAudio.paused; }

/**
 * Speak text using Kokoro TTS via backend.
 * Falls back to browser speechSynthesis if unavailable.
 */
export function speak(text, opts = {}) {
  // Stop any current speech first
  stopSpeaking();

  if (!text?.trim()) { opts.onEnd?.(); return { cancel() { stopSpeaking(); } }; }

  const backendUrl = opts.backendUrl || _defaultBackendUrl;

  if (backendUrl) {
    _activeAbort = new AbortController();

    fetch(`${backendUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, speed: opts.speed }),
      signal: _activeAbort.signal,
    })
    .then(res => {
      if (!res.ok) throw new Error('TTS failed');
      return res.blob();
    })
    .then(blob => {
      if (!_activeAbort) return; // was cancelled
      const url = URL.createObjectURL(blob);
      _activeAudio = new Audio(url);
      _allAudioElements.add(_activeAudio);
      _activeAudio.onended = () => { _allAudioElements.delete(_activeAudio); _cleanup(url); opts.onEnd?.(); };
      _activeAudio.onerror = () => { _allAudioElements.delete(_activeAudio); _cleanup(url); _fallbackSpeak(text, opts); };
      _activeAudio.play();
    })
    .catch(() => {
      if (_activeAbort) _fallbackSpeak(text, opts);
    });
  } else {
    _fallbackSpeak(text, opts);
  }

  return { cancel() { stopSpeaking(); } };
}

/** Stop any current speech immediately. */
export function stopSpeaking() {
  if (_activeAbort) { _activeAbort.abort(); _activeAbort = null; }
  if (_activeAudio) { _activeAudio.pause(); _activeAudio.src = ''; _activeAudio = null; }
  // Kill ALL tracked audio elements (catches orphans)
  _allAudioElements.forEach(a => { try { a.pause(); a.src = ''; } catch {} });
  _allAudioElements.clear();
  window.speechSynthesis?.cancel();
}

function _cleanup(url) {
  if (url) URL.revokeObjectURL(url);
  _activeAudio = null;
  _activeAbort = null;
}

/** Browser speechSynthesis fallback */
function _fallbackSpeak(text, opts = {}) {
  if (!window.speechSynthesis) { opts.onEnd?.(); return; }

  const clean = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, ' image ')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/[>\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) { opts.onEnd?.(); return; }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.rate = opts.speed ?? 1.0;
  utterance.lang = opts.lang || 'en-GB';
  utterance.onend = () => opts.onEnd?.();
  utterance.onerror = () => opts.onEnd?.();
  window.speechSynthesis.speak(utterance);
}
