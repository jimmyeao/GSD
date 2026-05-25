/**
 * TTS service — proxies to the persistent Kokoro TTS server.
 * Falls back to Piper CLI if Kokoro server is unavailable.
 */

const KOKORO_URL = process.env.KOKORO_URL || 'http://localhost:5100';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bf_alice';

/**
 * Convert text to speech. Returns a WAV buffer.
 * @param {string} text
 * @param {object} opts - { speed, voice }
 * @returns {Promise<Buffer>} WAV audio data
 */
export async function textToSpeech(text, opts = {}) {
  const clean = cleanText(text);
  if (!clean) return Buffer.alloc(0);

  const res = await fetch(KOKORO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: clean,
      voice: opts.voice || KOKORO_VOICE,
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
    .replace(/[>\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
