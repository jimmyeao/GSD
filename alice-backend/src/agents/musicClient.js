/**
 * Music generation client for ComfyUI, via ACE-Step 1.5 (turbo).
 * Native ComfyUI core support (comfy_extras/nodes_ace.py) — no custom node
 * install needed. Single-pass, 8-step graph, no crop/guide bookkeeping like
 * the video pipelines. Verified node-for-node against the official bundled
 * template (audio_ace_step1_5_xl_turbo.json) and comfy_extras/nodes_ace.py's
 * exact schemas.
 */

import { monitorProgress } from '../comfyProgress.js';

/**
 * Build an ACE-Step 1.5 turbo API workflow.
 * @param {string} tags    Style/genre description (e.g. "ambient, calm piano, 80 BPM").
 * @param {string} lyrics  Empty string = instrumental (ACE-Step's own convention).
 * @param {number} seconds Target track length.
 */
function buildAceStepWorkflow(tags, lyrics, { seconds = 30, bpm = 120, seed, keyscale = 'C major' } = {}) {
  const noiseSeed = seed ?? Math.floor(Math.random() * 2 ** 32);

  return {
    // ── Model loading ───────────────────────────────────────────
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'acestep_v1.5_xl_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'qwen_0.6b_ace15.safetensors', clip_name2: 'qwen_4b_ace15.safetensors', type: 'ace', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ace_1.5_vae.safetensors' } },
    '4': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },

    // ── Conditioning + latent ─────────────────────────────────────
    '5': {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['2', 0], tags, lyrics, seed: noiseSeed, bpm, duration: seconds,
        timesignature: '4', language: 'en', keyscale,
        generate_audio_codes: true, cfg_scale: 2, temperature: 0.85, top_p: 0.9, top_k: 0, min_p: 0,
      },
    },
    '6': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['5', 0] } },
    '7': { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds, batch_size: 1 } },

    // ── 8-step turbo sampling ────────────────────────────────────
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: noiseSeed, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },

    // ── Decode + save ───────────────────────────────────────────
    '9': { class_type: 'VAEDecodeAudio', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    // SaveAudio/SaveAudioMP3 are both deprecated in this ComfyUI version —
    // SaveAudioAdvanced is the current node (DynamicCombo format, same
    // pattern as SaveVideo's codec param: a flat string still works for the
    // top-level combo value, confirmed against source).
    '10': { class_type: 'SaveAudioAdvanced', inputs: { audio: ['9', 0], filename_prefix: 'alice_music', format: 'flac' } },
  };
}

async function queueWorkflow(endpoint, workflow, clientId) {
  const queueRes = await fetch(`${endpoint}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!queueRes.ok) {
    const text = await queueRes.text();
    throw new Error(`ComfyUI queue failed (${queueRes.status}): ${text.slice(0, 200)}`);
  }

  const { prompt_id } = await queueRes.json();
  return prompt_id;
}

/**
 * Poll ComfyUI history for audio output. Mirrors videoClient.js's
 * pollForVideo, but checks for an `audio` output list (SaveAudio's output
 * shape) instead of `animated: true` video frames.
 */
async function pollForAudio(endpoint, clientId, promptId, timeoutMs, onProgress) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const audioDir = join(__dir, '..', '..', 'data', 'audio');
  mkdirSync(audioDir, { recursive: true });

  const stopMonitor = onProgress
    ? monitorProgress(endpoint, clientId, promptId, onProgress)
    : () => {};

  const deadline = Date.now() + timeoutMs;
  try {
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));

    let histRes;
    try {
      histRes = await fetch(`${endpoint}/history/${promptId}`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch { continue; }
    if (!histRes.ok) continue;

    const history = await histRes.json();
    const entry = history[promptId];
    if (!entry) continue;

    if (entry.status?.status_str === 'error') {
      const msgs = entry.status?.messages || [];
      const errMsg = msgs.find(m => m[0] === 'execution_error');
      throw new Error(errMsg ? JSON.stringify(errMsg[1]).slice(0, 300) : 'ComfyUI execution error');
    }

    const outputs = entry.outputs || {};
    for (const nodeId of Object.keys(outputs)) {
      const nodeOut = outputs[nodeId];
      if (nodeOut.audio?.length) {
        const audio = nodeOut.audio[0];
        console.log(`[musicClient] audio generated: ${audio.filename}`);

        try {
          const viewUrl = `${endpoint}/view?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(audio.subfolder || '')}&type=${encodeURIComponent(audio.type || 'output')}`;
          const audioRes = await fetch(viewUrl, { signal: AbortSignal.timeout(60_000) });
          if (audioRes.ok) {
            writeFileSync(join(audioDir, audio.filename), Buffer.from(await audioRes.arrayBuffer()));
            console.log(`[musicClient] cached locally: ${audio.filename}`);
          }
        } catch (e) {
          console.warn(`[musicClient] failed to cache: ${e.message}`);
        }

        return {
          filename: audio.filename,
          subfolder: audio.subfolder || '',
          type: audio.type || 'output',
        };
      }
    }
  }

  throw new Error('Music generation timed out');
  } finally {
    stopMonitor();
  }
}

/**
 * Generate a music track with ACE-Step 1.5 turbo.
 * @param {string} endpoint  - ComfyUI URL
 * @param {string} tags      - Style/genre description
 * @param {string} lyrics    - Empty = instrumental
 * @param {number} seconds   - Target duration
 * @param {number} timeoutMs
 */
export async function generateMusic(endpoint, tags, lyrics, seconds = 30, timeoutMs = 300_000, onProgress) {
  const clientId = `alice-music-${Date.now()}`;
  const workflow = buildAceStepWorkflow(tags, lyrics, { seconds });
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[musicClient] music queued: ${promptId} (${seconds}s${lyrics ? ', with lyrics' : ', instrumental'})`);
  return pollForAudio(endpoint, clientId, promptId, timeoutMs, onProgress);
}
