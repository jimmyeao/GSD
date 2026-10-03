/**
 * ComfyUI integration for ImageAgent.
 *
 * Supports three workflows — aspect ratio (square/landscape/portrait, see
 * ASPECT_SIZES below) and an optional RealESRGAN 4K upscale pass apply to
 * all three, not just Flux.2:
 *   1. ERNIE Image Turbo — UNETLoader + CLIPLoader (Ministral 3B) + VAELoader (Flux2)
 *      steps: 8, cfg: 1, scheduler: simple — auto-detected from /object_info.
 *   2. Standard SD     — CheckpointLoaderSimple + KSampler
 *      steps: 20, cfg: 7, scheduler: normal — auto-detected fallback.
 *   3. Flux.2 Dev — UNETLoader + CLIPLoader (Mistral-3-Small) + VAELoader, explicit
 *      request only (via generateImage's imageModel param), not part of
 *      auto-detection — mirrors ComfyUI's official "Text to Image (Flux.2 Dev)"
 *      blueprint at full 20-step quality (no turbo LoRA).
 */

/** Cached workflow config — detected once per process lifetime. */
let _workflowConfig = null;
let _flux2Config = null;

/**
 * Query /object_info and determine the best available workflow.
 * Returns one of:
 *   { type: 'ernie-turbo', unetName, clipName, vaeName }
 *   { type: 'sd',          checkpoint }
 */
async function detectWorkflowConfig(endpoint) {
  if (_workflowConfig) return _workflowConfig;

  try {
    const res = await fetch(`${endpoint}/object_info`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`object_info ${res.status}`);
    const data = await res.json();

    // ── ERNIE Image Turbo detection ──────────────────────────────────
    // Recognise by UNETLoader having an ernie-named model file.
    const unetModels = data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
    const ernieUnet  = unetModels.find(m => /ernie/i.test(m));

    if (ernieUnet) {
      const clipModels = data?.CLIPLoader?.input?.required?.clip_name?.[0] ?? [];
      const vaeModels  = data?.VAELoader?.input?.required?.vae_name?.[0]  ?? [];

      // Ministral text encoder + Flux2 VAE are the paired components
      const ernieClip = clipModels.find(m => /ministral/i.test(m)) ?? clipModels[0];
      const ernieVae  = vaeModels.find(m => /flux2/i.test(m))       ?? vaeModels[0];

      if (ernieClip && ernieVae) {
        console.log(`[ComfyUI] ERNIE Image Turbo — unet: ${ernieUnet}, clip: ${ernieClip}, vae: ${ernieVae}`);
        _workflowConfig = { type: 'ernie-turbo', unetName: ernieUnet, clipName: ernieClip, vaeName: ernieVae };
        return _workflowConfig;
      }
    }

    // ── Standard SD checkpoint fallback ─────────────────────────────
    const checkpoints = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    const checkpoint  = checkpoints[0] ?? 'v1-5-pruned-emaonly.safetensors';
    console.log(`[ComfyUI] SD checkpoint: ${checkpoint}`);
    _workflowConfig = { type: 'sd', checkpoint };
    return _workflowConfig;

  } catch (err) {
    console.warn('[ComfyUI] object_info detection failed, using SD fallback:', err.message);
    _workflowConfig = { type: 'sd', checkpoint: 'v1-5-pruned-emaonly.safetensors' };
    return _workflowConfig;
  }
}

/**
 * Query /object_info for Flux.2 Dev's specific model files. Unlike
 * detectWorkflowConfig (which picks between two workflows by what's
 * available), this only confirms Flux.2's own three files exist — the
 * caller has already explicitly asked for 'flux2', so there's no fallback
 * decision to make here, just a clear error if the files are missing.
 */
async function detectFlux2Config(endpoint) {
  if (_flux2Config) return _flux2Config;

  const res = await fetch(`${endpoint}/object_info`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`object_info ${res.status}`);
  const data = await res.json();

  const unetModels = data?.UNETLoader?.input?.required?.unet_name?.[0] ?? [];
  const clipModels  = data?.CLIPLoader?.input?.required?.clip_name?.[0] ?? [];
  const vaeModels   = data?.VAELoader?.input?.required?.vae_name?.[0]  ?? [];

  const unetName = unetModels.find(m => /flux2.*dev/i.test(m));
  const clipName = clipModels.find(m => /mistral.*flux2/i.test(m));
  const vaeName  = vaeModels.find(m => /full_encoder_small_decoder/i.test(m)) ?? vaeModels.find(m => /flux2/i.test(m));

  if (!unetName || !clipName || !vaeName) {
    throw new Error(`Flux.2 Dev model files not found in ComfyUI (unet: ${unetName ?? 'missing'}, clip: ${clipName ?? 'missing'}, vae: ${vaeName ?? 'missing'})`);
  }

  console.log(`[ComfyUI] Flux.2 Dev — unet: ${unetName}, clip: ${clipName}, vae: ${vaeName}`);
  _flux2Config = { unetName, clipName, vaeName };
  return _flux2Config;
}

// ── Aspect ratio + upscale helpers (shared by all three workflows) ─────────────

// ERNIE Turbo shares Flux.2's own VAE/latent space (see detectWorkflowConfig's
// ernieVae pairing), so the same base resolutions that suit Flux.2 Dev suit
// it too. SD's much older/smaller architecture keeps its original landscape
// default (768×512) rather than jumping to the same ~2MP range.
const ASPECT_SIZES = {
  flux2: {
    square:    { width: 1024, height: 1024 },
    landscape: { width: 1920, height: 1080 },
    portrait:  { width: 1080, height: 1920 },
  },
  sd: {
    square:    { width: 512, height: 512 },
    landscape: { width: 768, height: 512 },
    portrait:  { width: 512, height: 768 },
  },
};

/**
 * Resolve the target size: an explicit {width,height} always wins (e.g. the
 * external agent API's literal width/height fields — see routes/agent.js),
 * falling back to the aspect-keyword lookup otherwise.
 */
function resolveSize(sizeMap, aspect, customSize) {
  if (customSize?.width && customSize?.height) {
    return { width: Math.round(customSize.width), height: Math.round(customSize.height) };
  }
  return sizeMap[aspect] ?? sizeMap.square ?? Object.values(sizeMap)[0];
}

/**
 * Append a RealESRGAN 2x upscale pass after the given image link, returning
 * the new final-image link — or the original link unchanged if disabled.
 * Mutates `nodes` in place. Node ids 14/15 are reserved for this across all
 * three workflow builders (none of them use those ids for anything else).
 */
function appendUpscale4k(nodes, imageLink, enabled) {
  if (!enabled) return imageLink;
  nodes['14'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x2plus.pth' } };
  nodes['15'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['14', 0], image: imageLink } };
  return ['15', 0];
}

// ── Workflow builders ─────────────────────────────────────────────────────────

/**
 * ERNIE Image Turbo workflow.
 * Architecture: UNETLoader + Ministral-3B CLIP + Flux2 VAE + EmptyFlux2LatentImage
 * Settings derived from the official ComfyUI ERNIE workflow:
 *   steps=8, cfg=1, sampler=euler, scheduler=simple
 * Negative conditioning is zeroed-out (ERNIE doesn't use a text negative).
 */
function buildErnieTurboWorkflow(positivePrompt, unetName, clipName, vaeName, aspect = 'square', upscale4k = false, customSize = null) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const { width, height } = resolveSize(ASPECT_SIZES.flux2, aspect, customSize);
  const nodes = {
    '1': { class_type: 'UNETLoader',           inputs: { unet_name: unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader',            inputs: { clip_name: clipName, type: 'flux2' } },
    '3': { class_type: 'VAELoader',             inputs: { vae_name: vaeName } },
    '4': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '5': { class_type: 'CLIPTextEncode',        inputs: { text: positivePrompt, clip: ['2', 0] } },
    '6': { class_type: 'ConditioningZeroOut',   inputs: { conditioning: ['5', 0] } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model:        ['1', 0],
        positive:     ['5', 0],
        negative:     ['6', 0],
        latent_image: ['4', 0],
        seed,
        steps:        8,
        cfg:          1,
        sampler_name: 'euler',
        scheduler:    'simple',
        denoise:      1,
      },
    },
    '8': { class_type: 'VAEDecode',  inputs: { samples: ['7', 0], vae: ['3', 0] } },
  };
  const finalImage = appendUpscale4k(nodes, ['8', 0], upscale4k);
  nodes['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'alice', images: finalImage } };
  return nodes;
}

/**
 * Standard Stable Diffusion KSampler workflow.
 */
function buildSdWorkflow(positivePrompt, negativePrompt, checkpoint, aspect = 'landscape', upscale4k = false, customSize = null) {
  const { width, height } = resolveSize(ASPECT_SIZES.sd, aspect, customSize);
  const nodes = {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed:         Math.floor(Math.random() * 2 ** 32),
        steps:        20,
        cfg:          7,
        sampler_name: 'euler',
        scheduler:    'normal',
        denoise:      1,
        model:        ['4', 0],
        positive:     ['6', 0],
        negative:     ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage',        inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode',          inputs: { text: positivePrompt,  clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode',          inputs: { text: negativePrompt,  clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode',               inputs: { samples: ['3', 0], vae: ['4', 2] } },
  };
  const finalImage = appendUpscale4k(nodes, ['8', 0], upscale4k);
  nodes['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'alice', images: finalImage } };
  return nodes;
}

/**
 * Flux.2 Dev workflow — matches ComfyUI's official "Text to Image (Flux.2 Dev)"
 * blueprint's non-turbo path (no LoRA switch): RandomNoise + KSamplerSelect
 * (euler) + Flux2Scheduler (20 steps) + SamplerCustomAdvanced, FluxGuidance
 * at the documented default of 4.
 * @param {string} aspect 'square'|'landscape'|'portrait' — see ASPECT_SIZES.flux2
 *   below. landscape/portrait sit right at Flux.2's practical native ceiling
 *   (~2MP, same territory as its own 1024×1024 default), and a clean 2x
 *   RealESRGAN pass from either lands exactly on true 4K (3840×2160 /
 *   2160×3840). Square has no "4K" analog by convention, but 2x from 1024²
 *   still gives a real quality bump.
 * @param {boolean} upscale4k  Adds a RealESRGAN 2x pass after decode. Fine to
 *   do per-image (unlike video's per-frame cost — see videoClient.js's header
 *   comment on why the same upscaler was rejected there): a single frame at
 *   ~2s per RealESRGAN pass is negligible next to the sampling time.
 */
function buildFlux2DevWorkflow(positivePrompt, unetName, clipName, vaeName, aspect = 'square', upscale4k = false, customSize = null) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  const { width, height } = resolveSize(ASPECT_SIZES.flux2, aspect, customSize);
  const steps = 20;
  const nodes = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: clipName, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: vaeName } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: positivePrompt, clip: ['2', 0] } },
    '5': { class_type: 'FluxGuidance', inputs: { conditioning: ['4', 0], guidance: 4 } },
    '6': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '8': { class_type: 'Flux2Scheduler', inputs: { steps, width, height } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '10': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '11': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['6', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['10', 0] } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
  };

  const finalImage = appendUpscale4k(nodes, ['12', 0], upscale4k);
  nodes['13'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'alice_flux2', images: finalImage } };

  return nodes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an image via ComfyUI.
 * Returns { filename, subfolder, type } for the caller to build a proxy URL.
 */
export async function generateImage(endpoint, positivePrompt, negativePrompt = '', timeoutMs = 120_000, imageModel = 'auto', imageAspect = 'square', upscale4k = false, customSize = null) {
  let workflow;
  if (imageModel === 'flux2') {
    const flux2Config = await detectFlux2Config(endpoint);
    workflow = buildFlux2DevWorkflow(positivePrompt, flux2Config.unetName, flux2Config.clipName, flux2Config.vaeName, imageAspect, upscale4k, customSize);
  } else {
    const config = await detectWorkflowConfig(endpoint);
    workflow = config.type === 'ernie-turbo'
      ? buildErnieTurboWorkflow(positivePrompt, config.unetName, config.clipName, config.vaeName, imageAspect, upscale4k, customSize)
      : buildSdWorkflow(positivePrompt, negativePrompt, config.checkpoint, imageAspect, upscale4k, customSize);
  }

  const clientId = `alice-${Date.now()}`;

  const queueRes = await fetch(`${endpoint}/prompt`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal:  AbortSignal.timeout(10_000),
  });

  if (!queueRes.ok) {
    const body = await queueRes.text().catch(() => '');
    throw new Error(`ComfyUI queue error ${queueRes.status}: ${body.slice(0, 200)}`);
  }

  const { prompt_id: promptId } = await queueRes.json();

  // Poll history until the job completes
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const histRes = await fetch(`${endpoint}/history/${promptId}`, { signal: AbortSignal.timeout(5_000) });
    if (!histRes.ok) continue;

    const history = await histRes.json();
    const job = history[promptId];
    if (!job) continue;

    for (const output of Object.values(job.outputs ?? {})) {
      if (output.images?.length > 0) {
        const img = output.images[0];
        return { filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' };
      }
    }
  }

  throw new Error('ComfyUI timed out waiting for image generation.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
