/**
 * OpenAI-compatible surface — lets any client that already speaks the
 * OpenAI Chat/Images API (LiteLLM, Open WebUI, the `openai` SDK, Continue,
 * etc.) call Alice directly with zero custom integration code.
 *
 * Routes mount under /v1 (see server.js). Behind NGINX/Cloudflare all
 * client calls go to /api/v1/* — NGINX strips the /api prefix before
 * proxying, same as /agent/* (see agent.js).
 *
 * Auth is requireApiKey (shared secret), same contract as /agent/* — an
 * external caller has no browser session to present. Mounted before the
 * global csrfProtect in server.js for the same reason.
 *
 * Chat (/v1/chat/completions): a thin auth-swapping proxy onto the same
 * LiteLLM gateway config.models.*.endpoint already points at (see
 * llmClient.js) — that gateway already speaks real OpenAI-compat, so this
 * just re-homes auth to ALICE_AGENT_API_KEY instead of the gateway's own
 * key, letting external callers avoid needing direct network access to the
 * internal gateway. Both streaming (SSE passthrough) and non-streaming
 * forward the upstream body/response essentially verbatim — no reshaping
 * needed since the upstream is already OpenAI-shaped.
 *
 * Images (/v1/images/generations): wraps the same ComfyUI pipeline
 * /agent/image uses, but responds synchronously per the OpenAI contract
 * instead of job-polling. NOTE: Flux.2 Dev generation can take several
 * minutes — /agent/image moved to async job-polling specifically because
 * Cloudflare's edge kills proxied responses past ~100-125s (see agent.js
 * header). A synchronous caller hitting this route through that same
 * Cloudflare path will see the identical failure mode for slow generations;
 * this is a deliberate tradeoff for OpenAI-client compatibility, not an
 * oversight — use a direct (non-Cloudflare) network path for large/slow
 * generations if that matters.
 */

import { Router } from 'express';
import { requireApiKey } from '../auth.js';
import { config } from '../config.js';
import { generateImage } from '../agents/comfyClient.js';
import { ensureComfyRunning, freeComfyMemory } from '../comfyManager.js';

const router = Router();
router.use(requireApiKey);

const CHAT_MODELS = ['alice-general', 'alice-coder', 'alice-mail', 'alice-vision'];
const IMAGE_MODELS = ['auto', 'flux2'];

function isOfflineError(err) {
  return err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed');
}

router.get('/models', (_req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const data = [
    ...CHAT_MODELS.map(id => ({ id, object: 'model', created: now, owned_by: 'alice' })),
    ...IMAGE_MODELS.map(id => ({ id: `alice-image-${id}`, object: 'model', created: now, owned_by: 'alice' })),
  ];
  res.json({ object: 'list', data });
});

// ── Chat completions ────────────────────────────────────────────────────

router.post('/chat/completions', async (req, res) => {
  const body = req.body || {};
  if (!body.model || typeof body.model !== 'string') {
    return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages (non-empty array) is required', type: 'invalid_request_error' } });
  }

  // general/coder/mail/vision all point at the same LiteLLM gateway — the
  // caller's `model` field selects the alias, not the endpoint.
  const endpoint = config.models.general.endpoint;
  const upstreamHeaders = { 'Content-Type': 'application/json' };
  if (config.llmGatewayKey) upstreamHeaders.Authorization = `Bearer ${config.llmGatewayKey}`;

  let upstream;
  try {
    upstream = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return res.status(503).json({ error: { message: `LLM backend unavailable: ${err.message}`, type: 'api_error' } });
  }

  if (body.stream) {
    res.status(upstream.status);
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: { message: text || `upstream ${upstream.status}`, type: 'api_error' } } )}\n\n`);
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch (err) {
      console.error('[v1/chat/completions] stream error:', err.message);
    } finally {
      res.end();
    }
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.set('Content-Type', 'application/json');
  res.send(text);
});

// ── Image generations ───────────────────────────────────────────────────

function parseSize(size) {
  if (!size || typeof size !== 'string') return null;
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

router.post('/images/generations', async (req, res) => {
  const {
    prompt,
    model = 'alice-image-auto',
    n = 1,
    size,
    response_format = 'b64_json',
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: { message: 'prompt (string) is required', type: 'invalid_request_error' } });
  }
  const imageModel = typeof model === 'string' && model.startsWith('alice-image-')
    ? model.slice('alice-image-'.length)
    : model;
  if (!IMAGE_MODELS.includes(imageModel)) {
    return res.status(400).json({ error: { message: `model must be one of: ${IMAGE_MODELS.map(m => `alice-image-${m}`).join(', ')}`, type: 'invalid_request_error' } });
  }
  if (response_format !== 'b64_json') {
    // Alice's image gen doesn't persist generated media (see agent.js
    // header) so there's no stable URL to hand back — only b64_json is
    // supported, unlike real OpenAI which defaults to "url".
    return res.status(400).json({ error: { message: 'only response_format "b64_json" is supported', type: 'invalid_request_error' } });
  }
  const count = Math.min(Math.max(parseInt(n, 10) || 1, 1), 4);
  const customSize = parseSize(size);

  try {
    await ensureComfyRunning();
    const timeoutMs = imageModel === 'flux2' ? 600_000 : config.models.comfyui.timeout;
    const images = [];
    // Sequential, not parallel — ComfyUI/the GPU host runs one generation
    // at a time regardless, so parallel requests would just queue anyway.
    for (let i = 0; i < count; i++) {
      const imgData = await generateImage(config.models.comfyui.endpoint, prompt, '', timeoutMs, imageModel, 'square', false, customSize);
      const viewUrl = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
      const imgRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) });
      if (!imgRes.ok) throw new Error(`Failed to fetch generated image from ComfyUI (${imgRes.status})`);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      images.push({ b64_json: buffer.toString('base64') });
    }
    freeComfyMemory();
    res.json({ created: Math.floor(Date.now() / 1000), data: images });
  } catch (err) {
    res.status(isOfflineError(err) ? 503 : 502).json({ error: { message: err.message, type: 'api_error' } });
  }
});

export default router;
