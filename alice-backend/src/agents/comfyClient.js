/**
 * ComfyUI integration for ImageAgent.
 *
 * Supports two workflows, auto-detected from /object_info:
 *   1. ERNIE Image Turbo — UNETLoader + CLIPLoader (Ministral 3B) + VAELoader (Flux2)
 *      steps: 8, cfg: 1, scheduler: simple, 1024×1024
 *   2. Standard SD     — CheckpointLoaderSimple + KSampler
 *      steps: 20, cfg: 7, scheduler: normal, 768×512
 */

/** Cached workflow config — detected once per process lifetime. */
let _workflowConfig = null;

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

// ── Workflow builders ─────────────────────────────────────────────────────────

/**
 * ERNIE Image Turbo workflow.
 * Architecture: UNETLoader + Ministral-3B CLIP + Flux2 VAE + EmptyFlux2LatentImage
 * Settings derived from the official ComfyUI ERNIE workflow:
 *   steps=8, cfg=1, sampler=euler, scheduler=simple, 1024×1024
 * Negative conditioning is zeroed-out (ERNIE doesn't use a text negative).
 */
function buildErnieTurboWorkflow(positivePrompt, unetName, clipName, vaeName) {
  const seed = Math.floor(Math.random() * 2 ** 32);
  return {
    '1': { class_type: 'UNETLoader',           inputs: { unet_name: unetName, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader',            inputs: { clip_name: clipName, type: 'flux2' } },
    '3': { class_type: 'VAELoader',             inputs: { vae_name: vaeName } },
    '4': { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
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
    '9': { class_type: 'SaveImage',  inputs: { filename_prefix: 'alice', images: ['8', 0] } },
  };
}

/**
 * Standard Stable Diffusion KSampler workflow.
 */
function buildSdWorkflow(positivePrompt, negativePrompt, checkpoint) {
  return {
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
    '5': { class_type: 'EmptyLatentImage',        inputs: { width: 768, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode',          inputs: { text: positivePrompt,  clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode',          inputs: { text: negativePrompt,  clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode',               inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage',               inputs: { filename_prefix: 'alice', images: ['8', 0] } },
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate an image via ComfyUI.
 * Returns { filename, subfolder, type } for the caller to build a proxy URL.
 */
export async function generateImage(endpoint, positivePrompt, negativePrompt = '', timeoutMs = 120_000) {
  const config = await detectWorkflowConfig(endpoint);

  const workflow = config.type === 'ernie-turbo'
    ? buildErnieTurboWorkflow(positivePrompt, config.unetName, config.clipName, config.vaeName)
    : buildSdWorkflow(positivePrompt, negativePrompt, config.checkpoint);

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
