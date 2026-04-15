/**
 * Video generation client for ComfyUI.
 * Supports text-to-video (LTX-2 19B Distilled) and image-to-video (LTX-2.3 22B).
 */

import { monitorProgress } from '../comfyProgress.js';

/**
 * Upload an image to ComfyUI's input folder.
 * @param {string} endpoint - ComfyUI base URL
 * @param {string} dataUrl  - Base64 data URL (data:image/png;base64,...)
 * @param {string} filename - Target filename
 * @returns {Promise<string>} The filename as stored by ComfyUI
 */
async function uploadImageToComfy(endpoint, dataUrl, filename) {
  // Strip the data URL prefix to get raw base64
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  // Build multipart form data manually
  const boundary = `----GSDUpload${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(`${endpoint}/upload/image`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Image upload failed: ${res.status}`);
  const data = await res.json();
  console.log(`[videoClient] uploaded image: ${data.name}`);
  return data.name; // ComfyUI returns the stored filename
}

/**
 * Build a LTX-2 distilled text-to-video API workflow.
 */
function buildT2VWorkflow(prompt) {
  const seed = Math.floor(Math.random() * 2 ** 32);

  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-2-19b-distilled.safetensors' } },
    '2': { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: 'gemma_3_12B_it_fp4_mixed.safetensors', ckpt_name: 'ltx-2-19b-distilled.safetensors', device: 'default' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, watermark, text overlay, still frame', clip: ['2', 0] } },
    '5': { class_type: 'LTXVConditioning', inputs: { positive: ['3', 0], negative: ['4', 0], frame_rate: 24 } },
    '6': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: 768, height: 512, length: 193, batch_size: 1 } },
    '7': { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: 'ltx-2-19b-distilled.safetensors' } },
    '8': { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: 193, frame_rate: 24, batch_size: 1, audio_vae: ['7', 0] } },
    '9': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['6', 0], audio_latent: ['8', 0] } },
    '10': { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive: ['5', 0], negative: ['5', 1], cfg: 1 } },
    '11': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    '12': { class_type: 'ManualSigmas', inputs: { sigmas: '1., 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    '13': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '14': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['13', 0], guider: ['10', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['9', 0] } },
    '15': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['14', 0] } },
    '16': { class_type: 'VAEDecodeTiled', inputs: { samples: ['15', 0], vae: ['1', 2], tile_size: 512, overlap: 64, temporal_size: 4096, temporal_overlap: 8 } },
    '17': { class_type: 'CreateVideo', inputs: { images: ['16', 0], fps: 24 } },
    '18': { class_type: 'SaveVideo', inputs: { video: ['17', 0], filename_prefix: 'gsd_video', format: 'mp4', codec: 'h264' } },
  };
}

/**
 * Build a LTX-2.3 image-to-video API workflow (two-pass with latent upscaling).
 * Faithfully reproduces the video_ltx2_3_i2v subgraph:
 *   Pass 1: image inject (0.7) → 8-step distilled sample (LoRA + euler_ancestral_cfg_pp)
 *   Upscale: LTXVLatentUpsampler
 *   Pass 2: image inject (1.0) → 4-step refine (euler_cfg_pp)
 *   Decode: video + audio → CreateVideo → SaveVideo
 */
function buildI2VWorkflow(prompt, imageName) {
  const seed1 = Math.floor(Math.random() * 2 ** 32);
  const seed2 = Math.floor(Math.random() * 2 ** 32);

  // First pass is half-res, upscaled 2x by LTXVLatentUpsampler
  const latentW = 480;   // → 960 after upscale
  const latentH = 272;   // → 544 after upscale
  const frames = 193;    // ~8 seconds at 24fps (24*8+1)
  const fps = 24;

  return {
    // ── Model loading ───────────────────────────────────────────
    '1':  { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx-2.3-22b-dev-fp8.safetensors' } },
    '2':  { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: 'gemma_3_12B_it_fp4_mixed.safetensors', ckpt_name: 'ltx-2.3-22b-dev-fp8.safetensors', device: 'default' } },
    '3':  { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: 'ltx-2.3-22b-dev-fp8.safetensors' } },
    '4':  { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors' } },
    '5':  { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'ltx-2.3-22b-distilled-lora-384.safetensors', strength_model: 0.5 } },

    // ── Text encoding ───────────────────────────────────────────
    '6':  { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '7':  { class_type: 'CLIPTextEncode', inputs: { text: 'pc game, console game, video game, cartoon, childish, ugly', clip: ['2', 0] } },
    '8':  { class_type: 'LTXVConditioning', inputs: { positive: ['6', 0], negative: ['7', 0], frame_rate: fps } },

    // ── Image loading + preprocessing ───────────────────────────
    '9':  { class_type: 'LoadImage', inputs: { image: imageName } },
    '10': { class_type: 'ResizeImagesByLongerEdge', inputs: { images: ['9', 0], longer_edge: 1536 } },
    '11': { class_type: 'LTXVPreprocess', inputs: { image: ['10', 0], img_compression: 18 } },

    // ── Pass 1: initial latent + image injection at 0.7 ─────────
    '12': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: latentW, height: latentH, length: frames, batch_size: 1 } },
    '13': { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ['3', 0] } },
    '14': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['11', 0], latent: ['12', 0], strength: 0.7, bypass: false } },
    '15': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['14', 0], audio_latent: ['13', 0] } },

    // ── Pass 1: 8-step distilled sampling ────────────────────────
    '16': { class_type: 'CFGGuider', inputs: { model: ['5', 0], positive: ['8', 0], negative: ['8', 1], cfg: 1 } },
    '17': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral_cfg_pp' } },
    '18': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    '19': { class_type: 'RandomNoise', inputs: { noise_seed: seed1 } },
    '20': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['19', 0], guider: ['16', 0], sampler: ['17', 0], sigmas: ['18', 0], latent_image: ['15', 0] } },
    '21': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['20', 0] } },

    // ── Latent upscale + image re-inject at 1.0 ─────────────────
    '22': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['21', 0], upscale_model: ['4', 0], vae: ['1', 2] } },
    '23': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['11', 0], latent: ['22', 0], strength: 1.0, bypass: false } },
    '24': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['23', 0], audio_latent: ['21', 1] } },

    // ── Pass 2: 4-step refinement ────────────────────────────────
    '25': { class_type: 'CFGGuider', inputs: { model: ['5', 0], positive: ['8', 0], negative: ['8', 1], cfg: 1 } },
    '26': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_cfg_pp' } },
    '27': { class_type: 'ManualSigmas', inputs: { sigmas: '0.85, 0.7250, 0.4219, 0.0' } },
    '28': { class_type: 'RandomNoise', inputs: { noise_seed: seed2 } },
    '29': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['28', 0], guider: ['25', 0], sampler: ['26', 0], sigmas: ['27', 0], latent_image: ['24', 0] } },
    '30': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['29', 0] } },

    // ── Decode + save ───────────────────────────────────────────
    '31': { class_type: 'VAEDecodeTiled', inputs: { samples: ['30', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } },
    '32': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['30', 1], audio_vae: ['3', 0] } },
    '33': { class_type: 'CreateVideo', inputs: { images: ['31', 0], audio: ['32', 0], fps } },
    '34': { class_type: 'SaveVideo', inputs: { video: ['33', 0], filename_prefix: 'gsd_i2v', format: 'mp4', codec: 'h264' } },
  };
}

/**
 * Poll ComfyUI history for video output.
 * When found, immediately downloads and caches the video locally
 * (so ComfyUI can be safely killed after this returns).
 */
async function pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const videosDir = join(__dir, '..', '..', 'data', 'videos');
  mkdirSync(videosDir, { recursive: true });

  // Start WebSocket progress monitor
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
    } catch { continue; } // ComfyUI might be busy, retry
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
      if (nodeOut.images?.length && nodeOut.animated?.[0] === true) {
        const vid = nodeOut.images[0];
        console.log(`[videoClient] video generated: ${vid.filename}`);

        // Immediately cache locally before returning (so ComfyUI can be killed safely)
        try {
          const viewUrl = `${endpoint}/view?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder || '')}&type=${encodeURIComponent(vid.type || 'output')}`;
          const vidRes = await fetch(viewUrl, { signal: AbortSignal.timeout(120_000) });
          if (vidRes.ok) {
            writeFileSync(join(videosDir, vid.filename), Buffer.from(await vidRes.arrayBuffer()));
            console.log(`[videoClient] cached locally: ${vid.filename}`);
          }
        } catch (e) {
          console.warn(`[videoClient] failed to cache: ${e.message}`);
        }

        return {
          filename: vid.filename,
          subfolder: vid.subfolder || '',
          type: vid.type || 'output',
        };
      }
    }
  }

  throw new Error('Video generation timed out');
  } finally {
    stopMonitor();
  }
}

/**
 * Generate a text-to-video.
 */
export async function generateVideo(endpoint, prompt, timeoutMs = 300_000) {
  const clientId = `gsd-video-${Date.now()}`;
  const workflow = buildT2VWorkflow(prompt);

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
  console.log(`[videoClient] t2v queued: ${prompt_id}`);
  return pollForVideo(endpoint, prompt_id, timeoutMs);
}

/**
 * Generate an image-to-video.
 * @param {string} endpoint  - ComfyUI URL
 * @param {string} prompt    - Text prompt describing the video motion
 * @param {object} imageData - { name: string, dataUrl: string } base64 image
 * @param {number} timeoutMs - Timeout
 */
export async function generateI2V(endpoint, prompt, imageData, timeoutMs = 300_000) {
  const clientId = `gsd-i2v-${Date.now()}`;

  // Upload the reference image to ComfyUI
  const imageName = await uploadImageToComfy(endpoint, imageData.dataUrl, imageData.name);

  const workflow = buildI2VWorkflow(prompt, imageName);

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
  console.log(`[videoClient] i2v queued: ${prompt_id} (image: ${imageName})`);
  return pollForVideo(endpoint, prompt_id, timeoutMs);
}
