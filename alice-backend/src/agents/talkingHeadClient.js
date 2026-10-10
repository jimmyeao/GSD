/**
 * Talking-head (presenter) clip generation via LTX-2.3 + ID-LoRA.
 *
 * Mirrors ComfyUI's official "LTX-2.3: ID LoRA" template
 * (video_ltx2_3_id_lora.json), node-for-node except the template's
 * dynamic-combo ResizeImageMaskNode pair, replaced by a plain ImageScale
 * (lanczos, center crop) to the target size — same effect, no dynamic combo.
 *
 * NOTE: this is NOT lip-sync to a supplied audio track. LTX-2.3 generates
 * the speech itself (jointly with the video, so lips match by
 * construction), saying the [SPEECH] text. The reference audio only
 * transfers *speaker identity* (voice timbre) — LTXVReferenceAudio's own
 * docs recommend a ~5s clip. The portrait is pinned as the literal first
 * frame (LTXVImgToVideoInplace), so face continuity is strong.
 *
 * Pipeline (two-stage, same as the template):
 *   1. half-res: 8 manual-sigma steps, model = dev + distilled-1.1 LoRA
 *      (0.5) + ID-LoRA, identity guidance from the reference audio,
 *      portrait inplace at strength 0.7
 *   2. latent x2 upscale → 3-step refine with the distilled LoRA only
 *      (no ID-LoRA), portrait inplace at strength 1.0, audio latent
 *      carried over from stage 1
 */

import { uploadMediaToComfy, queueWorkflow, pollForVideo } from './videoClient.js';

// Full BF16 dev rather than the template's fp8 — on this box the BF16 LTX
// checkpoints measured faster than the partially-quantized fp8 ones.
const LTX23_CKPT = 'ltx-2.3-22b-dev.safetensors';
const LTX23_TEXT_ENCODER = 'gemma_3_12B_it_fp4_mixed.safetensors';
const LTX23_UPSCALER = 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors';
const LTX23_DISTILLED_LORA = 'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors';
const LTX23_ID_LORA = 'ltx-2.3-id-lora-talkvid-3k.safetensors';
const FPS = 25;

/**
 * Model files a ComfyUI worker needs for generateTalkingHead (for
 * comfyWorkers.acquireWorker). The checkpoint entry lists alternatives:
 * full BF16 (DGX Spark) or fp8 (24 GB laptop GPU).
 */
export const TALKING_HEAD_NEEDS = [
  [LTX23_CKPT, 'ltx-2.3-22b-dev-fp8.safetensors'],
  LTX23_TEXT_ENCODER, LTX23_UPSCALER, LTX23_DISTILLED_LORA, LTX23_ID_LORA,
];

/** LTX latent frame counts are 8k+1. */
function framesForSeconds(seconds) {
  return Math.max(1, Math.round((seconds * FPS) / 8)) * 8 + 1;
}

/**
 * Build the [VISUAL]/[SPEECH]/[SOUNDS] prompt ID-LoRA was trained on.
 */
export function buildIdLoraPrompt({ visual, speech, sounds }) {
  return `[VISUAL]: ${visual}\n[SPEECH]: ${speech}\n[SOUNDS]: ${sounds}`;
}

function buildIdLoraWorkflow(prompt, imageName, refAudioName, {
  seconds = 8, width = 1280, height = 720, seed = Math.floor(Math.random() * 2 ** 32), ckpt = LTX23_CKPT,
  negativePrompt = 'pc game, console game, video game, cartoon, childish, ugly',
  identityGuidance = 3,
} = {}) {
  const frames = framesForSeconds(seconds);
  return {
    // ── Loaders ─────────────────────────────────────────────────
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: LTX23_TEXT_ENCODER, ckpt_name: ckpt, device: 'default' } },
    '3': { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: ckpt } },
    '4': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: LTX23_UPSCALER } },
    '5': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: LTX23_DISTILLED_LORA, strength_model: 0.5 } },
    '6': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['5', 0], lora_name: LTX23_ID_LORA, strength_model: 1 } },

    // ── Inputs ──────────────────────────────────────────────────
    '7': { class_type: 'LoadImage', inputs: { image: imageName } },
    '8': { class_type: 'ImageScale', inputs: { image: ['7', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
    '9': { class_type: 'LTXVPreprocess', inputs: { image: ['8', 0], img_compression: 18 } },
    '10': { class_type: 'LoadAudio', inputs: { audio: refAudioName } },

    // ── Conditioning (+ ID-LoRA speaker identity) ─────────────────
    '11': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: prompt } },
    '12': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: negativePrompt } },
    '13': {
      class_type: 'LTXVReferenceAudio',
      inputs: { model: ['6', 0], positive: ['11', 0], negative: ['12', 0], reference_audio: ['10', 0], audio_vae: ['3', 0], identity_guidance_scale: identityGuidance, start_percent: 0, end_percent: 1 },
    },
    '14': { class_type: 'LTXVConditioning', inputs: { positive: ['13', 1], negative: ['13', 2], frame_rate: FPS } },

    // ── Stage 1: half-res sample ─────────────────────────────────
    '15': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: Math.round(width / 2), height: Math.round(height / 2), length: frames, batch_size: 1 } },
    '16': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['9', 0], latent: ['15', 0], strength: 0.7, bypass: false } },
    '17': { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: frames, frame_rate: FPS, batch_size: 1, audio_vae: ['3', 0] } },
    '18': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['16', 0], audio_latent: ['17', 0] } },
    '19': { class_type: 'CFGGuider', inputs: { model: ['13', 0], positive: ['14', 0], negative: ['14', 1], cfg: 1 } },
    '20': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '21': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' } },
    '22': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '23': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['22', 0], guider: ['19', 0], sampler: ['20', 0], sigmas: ['21', 0], latent_image: ['18', 0] } },
    '24': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['23', 0] } },

    // ── Stage 2: x2 upscale + refine (distilled LoRA only) ────────
    '25': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['24', 0], upscale_model: ['4', 0], vae: ['1', 2] } },
    '26': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['1', 2], image: ['9', 0], latent: ['25', 0], strength: 1, bypass: false } },
    '27': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['26', 0], audio_latent: ['24', 1] } },
    '28': { class_type: 'LTXVCropGuides', inputs: { positive: ['14', 0], negative: ['14', 1], latent: ['24', 0] } },
    '29': { class_type: 'CFGGuider', inputs: { model: ['5', 0], positive: ['28', 0], negative: ['28', 1], cfg: 1 } },
    '30': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '31': { class_type: 'ManualSigmas', inputs: { sigmas: '0.85, 0.7250, 0.4219, 0.0' } },
    '32': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
    '33': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['32', 0], guider: ['29', 0], sampler: ['30', 0], sigmas: ['31', 0], latent_image: ['27', 0] } },
    '34': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['33', 0] } },

    // ── Decode + save ───────────────────────────────────────────
    '35': { class_type: 'VAEDecodeTiled', inputs: { samples: ['34', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } },
    '36': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['34', 1], audio_vae: ['3', 0] } },
    '37': { class_type: 'CreateVideo', inputs: { images: ['35', 0], audio: ['36', 0], fps: FPS, bit_depth: 8 } },
    '38': { class_type: 'SaveVideo', inputs: { video: ['37', 0], filename_prefix: 'alice_talkinghead', format: 'auto', codec: 'auto' } },
  };
}

/**
 * Generate one presenter clip.
 * @param {string} endpoint  ComfyUI URL
 * @param {object} opts
 *   portrait   {name, dataUrl}  presenter image — pinned as the first frame
 *   voiceRef   {name, dataUrl}  ~5s speech sample whose voice is cloned
 *   visual / speech / sounds   prompt sections (see buildIdLoraPrompt)
 *   seconds, width, height, seed, timeoutMs, onProgress
 *   unreachableMs  remote workers: fail fast if the worker stops answering
 *   ckpt   LTX-2.3 checkpoint file (default full BF16; the 24 GB laptop
 *          worker uses ltx-2.3-22b-dev-fp8.safetensors)
 * @returns {Promise<{filename, subfolder, type}>} same shape as videoClient's generators
 */
export async function generateTalkingHead(endpoint, {
  portrait, voiceRef, visual, speech, sounds,
  seconds = 8, width = 1280, height = 720, seed, timeoutMs = 1_800_000, onProgress, ckpt, unreachableMs,
}) {
  const imageName = await uploadMediaToComfy(endpoint, portrait.dataUrl, portrait.name);
  const refAudioName = await uploadMediaToComfy(endpoint, voiceRef.dataUrl, voiceRef.name);
  const prompt = buildIdLoraPrompt({ visual, speech, sounds });
  const workflow = buildIdLoraWorkflow(prompt, imageName, refAudioName, { seconds, width, height, ...(seed !== undefined ? { seed } : {}), ...(ckpt ? { ckpt } : {}) });

  const clientId = `alice-talkinghead-${Date.now()}`;
  const promptId = await queueWorkflow(endpoint, workflow, clientId);
  console.log(`[talkingHead] queued: ${promptId} (${seconds}s, ${width}x${height})`);
  return pollForVideo(endpoint, clientId, promptId, timeoutMs, onProgress, undefined, { unreachableMs });
}
