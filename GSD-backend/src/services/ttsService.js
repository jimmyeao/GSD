import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_BIN = process.env.KOKORO_PYTHON || '/home/jimmy/piper-env/bin/python3';
const KOKORO_MODEL = process.env.KOKORO_MODEL || '/home/jimmy/kokoro-voices/kokoro-v1.0.onnx';
const KOKORO_VOICES = process.env.KOKORO_VOICES || '/home/jimmy/kokoro-voices/voices-v1.0.bin';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bf_alice';

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

/**
 * Convert text to speech using Kokoro. Returns a WAV buffer.
 * @param {string} text
 * @param {object} opts - { speed, voice }
 * @returns {Promise<Buffer>} WAV audio data
 */
export function textToSpeech(text, opts = {}) {
  const clean = cleanText(text);
  if (!clean) return Promise.resolve(Buffer.alloc(0));

  const voice = opts.voice || KOKORO_VOICE;
  const speed = opts.speed ?? 1.0;

  // Run Kokoro via a small inline Python script that writes WAV to stdout
  const script = `
import sys, io
from kokoro_onnx import Kokoro
import soundfile as sf

kokoro = Kokoro('${KOKORO_MODEL}', '${KOKORO_VOICES}')
samples, sr = kokoro.create(sys.stdin.read(), voice='${voice}', speed=${speed})
buf = io.BytesIO()
sf.write(buf, samples, sr, format='WAV')
sys.stdout.buffer.write(buf.getvalue())
`;

  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', () => {}); // ignore onnxruntime warnings
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`Kokoro TTS exited with code ${code}`));
      else resolve(Buffer.concat(chunks));
    });
    proc.on('error', reject);

    proc.stdin.write(clean);
    proc.stdin.end();
  });
}
