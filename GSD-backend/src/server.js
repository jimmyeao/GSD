import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { getAgent } from './agents/registry.js';
import { streamCompletion, complete, LLMUnavailableError } from './agents/llmClient.js';
import { generateImage } from './agents/comfyClient.js';
import { generateVideo, generateI2V } from './agents/videoClient.js';
import { ensureComfyRunning, freeComfyMemory } from './comfyManager.js';
import { routeByKeyword, routeWithLLM } from './router.js';
import { buildPptx, parseSlideResponse } from './agents/slideBuilder.js';
import { resolveVisuals } from './orchestrator.js';
import { stmts } from './db.js';
import { socketAuth } from './auth.js';
import authRoutes from './routes/auth.js';
import convRoutes from './routes/conversations.js';
import assetsRoutes from './routes/assets.js';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: config.cors,
  // Qwen3 thinking phase can be silent for minutes — keep socket alive
  pingTimeout: 600_000,
  pingInterval: 25_000,
  // Allow large payloads for image attachments (20MB)
  maxHttpBufferSize: 20 * 1024 * 1024,
});

// ── Middleware ──────────────────────────────────────────────────────
app.use(cors(config.cors));
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: Object.keys(config.models), demoMode: config.demoMode });
});
app.use('/auth', authRoutes);
app.use('/conversations', convRoutes);
app.use('/assets', assetsRoutes);

// ── ComfyUI image proxy ──────────────────────────────────────────────
// Fetches the image from the local ComfyUI instance and re-serves it so
// remote clients (Tailscale, etc.) don't need direct access to port 8188.
app.get('/comfy-image', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (!filename) { res.status(400).json({ error: 'filename required' }); return; }

  const upstream_url = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  try {
    const upstream = await fetch(upstream_url, { signal: AbortSignal.timeout(15_000) });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(value);
    }
  } catch (err) {
    console.error('[comfy-image proxy]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── ComfyUI video proxy ─────────────────────────────────────────────
app.get('/comfy-video', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (!filename) { res.status(400).json({ error: 'filename required' }); return; }

  const upstream_url = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  try {
    const upstream = await fetch(upstream_url, { signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok) { res.status(upstream.status).end(); return; }
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(value);
    }
  } catch (err) {
    console.error('[comfy-video proxy]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Generated slides download ───────────────────────────────────────
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLIDES_DIR = join(__dirname, '..', 'data', 'slides');

app.get('/slides/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!filename.endsWith('.pptx')) { res.status(400).json({ error: 'Invalid file' }); return; }
  const filepath = join(SLIDES_DIR, filename);
  if (!existsSync(filepath)) { res.status(404).json({ error: 'File not found' }); return; }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filepath);
});

// ── Generated videos download ───────────────────────────────────────
const VIDEOS_DIR = join(__dirname, '..', 'data', 'videos');

app.get('/videos/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!filename.endsWith('.mp4')) { res.status(400).json({ error: 'Invalid file' }); return; }
  const filepath = join(VIDEOS_DIR, filename);
  if (!existsSync(filepath)) { res.status(404).json({ error: 'File not found' }); return; }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(filepath);
});

// ── Socket.IO auth middleware ───────────────────────────────────────
io.use(socketAuth);

// ── Socket.IO connection handler ────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[ws] connected: ${socket.id} (user: ${socket.user.username})`);

  socket.on('message', async ({ agent: requestedAgent, content, history = [], conversationId, imageData }) => {
    if (!content?.trim()) return;

    let agentId = requestedAgent;

    // ── Routing ────────────────────────────────────────────────────
    if (!agentId || agentId === 'RouterAgent') {
      agentId = await routeWithLLM(
        content,
        config.models.general.endpoint,
        config.models.general.model,
      );
      socket.emit('routed', { agent: agentId });
      console.log(`[router] "${content.slice(0, 60)}…" → ${agentId}`);
    }

    // ── Persist: resolve or create conversation ────────────────────
    let convId = conversationId;
    if (convId) {
      const conv = stmts.getConversation.get(convId, socket.user.id);
      if (!conv) { convId = null; } // invalid — create new
    }
    if (!convId) {
      const title = content.slice(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
      const result = stmts.insertConversation.run(socket.user.id, title, agentId);
      convId = result.lastInsertRowid;
      socket.emit('conversation:created', { id: convId, title, agent_id: agentId });
    }

    // Save user message
    stmts.insertMessage.run(convId, 'user', null, content);

    const agentDef = getAgent(agentId);

    // ── Demo mode ──────────────────────────────────────────────────
    if (config.demoMode) {
      await streamDemo(socket, agentId, content, undefined, convId);
      return;
    }

    // ── ImageAgent via ComfyUI ─────────────────────────────────────
    if (agentId === 'ImageAgent') {
      await handleImageAgent(socket, content, convId, agentId);
      return;
    }

    // ── VideoAgent via ComfyUI (LTX-2) ───────────────────────────
    if (agentId === 'VideoAgent') {
      await handleVideoAgent(socket, content, convId, imageData);
      return;
    }

    // ── SlideAgent → PowerPoint generation ─────────────────────────
    if (agentId === 'SlideAgent') {
      await handleSlideAgent(socket, content, history, convId);
      return;
    }

    // ── LLM streaming ─────────────────────────────────────────────
    const modelCfg = config.models[agentDef.model];
    const messages = buildMessages(agentDef.systemPrompt, history, content);

    let fullResponse = '';
    try {
      const stream = streamCompletion(
        modelCfg.endpoint,
        modelCfg.model,
        messages,
        {
          signal: AbortSignal.timeout(modelCfg.timeout),
          onThinking: () => socket.emit('thinking', {}),
          noThink: agentDef.noThink ?? false,
        },
      );

      for await (const token of stream) {
        fullResponse += token;
        socket.emit('token', { token });
      }

      // Persist assistant response
      stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
      stmts.touchConversation.run(convId);

      socket.emit('done', { agent: agentId });
      console.log(`[${agentId}] stream complete`);
    } catch (err) {
      if (err instanceof LLMUnavailableError) {
        await streamDemo(socket, agentId, content, modelCfg.endpoint, convId);
      } else {
        console.error(`[${agentId}] error:`, err.message);
        socket.emit('error', { message: err.message });
      }
    }
  });

  // ── Prompt optimisation ────────────────────────────────────────────
  socket.on('optimise', async ({ content, agent }) => {
    if (!content?.trim()) return;
    try {
      const result = agent === 'ImageAgent'
        ? await enhanceImagePrompt(content)
        : await enhanceGeneralPrompt(content);
      socket.emit('optimised', { positive: result.positive, negative: result.negative ?? '' });
    } catch (err) {
      socket.emit('error', { message: `Prompt optimisation failed: ${err.message}` });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[ws] disconnected: ${socket.id} (${reason})`);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function buildMessages(systemPrompt, history, userContent) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const h of history.slice(-10)) {
    if (h.role && h.content) messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

const DEFAULT_NEGATIVE = [
  'extra fingers', 'missing fingers', 'six fingers', 'four fingers', 'fused fingers',
  'deformed hands', 'mutated hands', 'malformed hands', 'missing hands', 'extra hands',
  'bad anatomy', 'wrong anatomy', 'extra limbs', 'missing limbs', 'floating limbs',
  'deformed face', 'ugly', 'disfigured', 'mutation', 'blurry', 'out of focus',
  'low quality', 'low resolution', 'jpeg artifacts', 'watermark', 'signature',
].join(', ');

async function enhanceGeneralPrompt(userPrompt) {
  const messages = [
    {
      role: 'system',
      content: 'You are an expert at writing clear, effective prompts. Rewrite the given prompt to be more specific, detailed and likely to produce a high-quality response. Preserve the original intent exactly — do NOT change the subject matter. Return only the improved prompt text, no explanation, no quotes, no preamble.',
    },
    { role: 'user', content: userPrompt },
  ];
  try {
    const enhanced = await complete(
      config.models.general.endpoint,
      config.models.general.model,
      messages,
      { signal: AbortSignal.timeout(30_000), numPredict: 500 },
    );
    return { positive: enhanced.trim() || userPrompt };
  } catch {
    return { positive: userPrompt };
  }
}

async function enhanceImagePrompt(userPrompt) {
  const messages = [
    {
      role: 'system',
      content: `You are an expert Stable Diffusion prompt engineer. Given a short description, produce an optimised prompt.

Return ONLY a JSON object — no markdown, no explanation:
{"positive":"...","negative":"..."}

Rules for positive: expand the description with subject detail, realistic skin and anatomy, perfect hands with correct finger count, natural pose, cinematic lighting, photorealistic, 8k uhd, high detail.
Rules for negative: always include anatomy issues (extra fingers, missing fingers, deformed hands, bad anatomy) plus any artefacts relevant to the subject.`,
    },
    { role: 'user', content: userPrompt },
  ];
  try {
    const raw = await complete(
      config.models.general.endpoint,
      config.models.general.model,
      messages,
      { signal: AbortSignal.timeout(30_000), numPredict: 500 },
    );
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.positive) {
        return {
          positive: parsed.positive.trim(),
          negative: (parsed.negative || DEFAULT_NEGATIVE).trim(),
        };
      }
    }
    // Plain text fallback (no JSON returned)
    return { positive: raw.trim() || userPrompt, negative: DEFAULT_NEGATIVE };
  } catch {
    return { positive: userPrompt, negative: DEFAULT_NEGATIVE };
  }
}

/** Save a generated file as a per-user asset. Returns the asset URL. */
function saveAsset(userId, convId, type, filename, buffer, title) {
  const userDir = join(__dirname, '..', 'data', 'assets', String(userId));
  mkdirSync(userDir, { recursive: true });
  const filepath = join(userDir, filename);
  writeFileSync(filepath, buffer);
  const sizeBytes = buffer.length;
  const result = stmts.insertAsset.run(userId, convId, type, filename, null, title, sizeBytes);
  return result.lastInsertRowid;
}

function assetUrl(socket, assetId) {
  const scheme = socket.handshake.secure ? 'https' : 'http';
  const host = socket.handshake.headers.host || `localhost:${config.port}`;
  const token = socket.handshake.auth?.token || '';
  return `${scheme}://${host}/assets/${assetId}/file?token=${encodeURIComponent(token)}`;
}

async function handleImageAgent(socket, prompt, convId, agentId) {
  let fullResponse = '';
  // Try ComfyUI first
  try {
    socket.emit('token', { token: `Starting ComfyUI and generating image…\n\n` });
    fullResponse += `Generating image…\n\n`;
    await ensureComfyRunning();
    const imgData = await generateImage(config.models.comfyui.endpoint, prompt, DEFAULT_NEGATIVE, config.models.comfyui.timeout);

    // Cache image locally as a per-user asset
    let imgUrl;
    try {
      const viewUrl = `${config.models.comfyui.endpoint}/view?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
      const imgRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) });
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const assetId = saveAsset(socket.user.id, convId, 'image', imgData.filename, buffer, prompt.slice(0, 80));
      imgUrl = assetUrl(socket, assetId);
    } catch {
      // Fallback to proxy URL if caching fails
      const scheme = socket.handshake.secure ? 'https' : 'http';
      const host = socket.handshake.headers.host || `localhost:${config.port}`;
      imgUrl = `${scheme}://${host}/comfy-image?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
    }

    freeComfyMemory();

    const imgMarkdown = `![Generated image](${imgUrl})`;
    fullResponse += imgMarkdown;
    socket.emit('token', { token: imgMarkdown });

    if (convId) {
      stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
      stmts.touchConversation.run(convId);
    }
    socket.emit('done', { agent: 'ImageAgent' });
    return;
  } catch (err) {
    const isOffline = err.code === 'ECONNREFUSED'
      || err.cause?.code === 'ECONNREFUSED'
      || err.message.includes('fetch failed');

    if (!isOffline) {
      socket.emit('error', { message: `ComfyUI error: ${err.message}` });
      return;
    }
    console.log('[ImageAgent] ComfyUI offline, falling back to LLM visual concepts');
  }

  // LLM fallback
  const agentDef = getAgent('ImageAgent');
  const modelCfg = config.models.general;
  const messages = [
    { role: 'system', content: agentDef.systemPrompt },
    { role: 'user', content: prompt },
  ];

  try {
    const prefix = `> ComfyUI is not running — generating visual concept instead.\n> Install ComfyUI on port 8188 for real image generation.\n\n`;
    socket.emit('token', { token: prefix });
    fullResponse = prefix;

    const stream = streamCompletion(modelCfg.endpoint, modelCfg.model, messages, {
      signal: AbortSignal.timeout(modelCfg.timeout),
      onThinking: () => socket.emit('thinking', {}),
      noThink: true,
    });

    for await (const token of stream) {
      fullResponse += token;
      socket.emit('token', { token });
    }

    if (convId) {
      stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
      stmts.touchConversation.run(convId);
    }
    socket.emit('done', { agent: 'ImageAgent' });
  } catch (llmErr) {
    socket.emit('error', { message: `ImageAgent LLM fallback failed: ${llmErr.message}` });
  }
}

async function handleVideoAgent(socket, prompt, convId, imageData) {
  let fullResponse = '';
  const isI2V = !!imageData;
  try {
    const mode = isI2V ? 'image-to-video with LTX-2.3' : 'text-to-video with LTX-2';
    const msg1 = `Starting ComfyUI and generating ${mode}... This may take a few minutes.\n\n`;
    socket.emit('token', { token: msg1 });
    fullResponse += msg1;

    await ensureComfyRunning();
    const vidData = isI2V
      ? await generateI2V(config.models.comfyui.endpoint, prompt, imageData, 1_200_000) // 20 min for two-pass i2v
      : await generateVideo(config.models.comfyui.endpoint, prompt, 900_000);          // 15 min for t2v

    // Move cached video to per-user assets directory
    const cachedPath = join(__dirname, '..', 'data', 'videos', vidData.filename);
    let videoUrl;
    try {
      const { readFileSync } = await import('node:fs');
      const buffer = readFileSync(cachedPath);
      const assetId = saveAsset(socket.user.id, convId, 'video', vidData.filename, buffer, prompt.slice(0, 80));
      videoUrl = assetUrl(socket, assetId);
      try { unlinkSync(cachedPath); } catch { /* ignore */ }
    } catch {
      // Fallback to old flat URL
      const scheme = socket.handshake.secure ? 'https' : 'http';
      const host = socket.handshake.headers.host || `localhost:${config.port}`;
      videoUrl = `${scheme}://${host}/videos/${encodeURIComponent(vidData.filename)}`;
    }

    freeComfyMemory();

    const msg2 = `Video generated successfully!\n\n[Download video](${videoUrl})\n\n<video controls width="640" src="${videoUrl}"></video>`;
    socket.emit('token', { token: msg2 });
    fullResponse += msg2;

    if (convId) {
      stmts.insertMessage.run(convId, 'assistant', 'VideoAgent', fullResponse);
      stmts.touchConversation.run(convId);
    }
    socket.emit('done', { agent: 'VideoAgent' });
    console.log(`[VideoAgent] generated ${vidData.filename}`);
  } catch (err) {
    freeComfyMemory(); // ensure VRAM is freed on error too
    const isOffline = err.code === 'ECONNREFUSED'
      || err.cause?.code === 'ECONNREFUSED'
      || err.message.includes('fetch failed');

    if (isOffline) {
      socket.emit('token', { token: '> ComfyUI is not running. Start ComfyUI with the LTX-2 model to generate videos.\n' });
      socket.emit('done', { agent: 'VideoAgent' });
    } else {
      console.error('[VideoAgent] error:', err.message);
      socket.emit('error', { message: `VideoAgent error: ${err.message}` });
    }
  }
}

async function handleSlideAgent(socket, prompt, history, convId) {
  const agentDef = getAgent('SlideAgent');
  const modelCfg = config.models[agentDef.model];
  const messages = buildMessages(agentDef.systemPrompt, history, prompt);

  socket.emit('token', { token: 'Generating presentation...\n\n' });

  try {
    // Use complete() to get full JSON response (not streaming)
    const raw = await complete(
      modelCfg.endpoint,
      modelCfg.model,
      messages,
      { signal: AbortSignal.timeout(modelCfg.timeout), numPredict: 4096 },
    );

    // Parse the response into structured slide data
    const deckData = parseSlideResponse(raw);

    if (!deckData.slides?.length) {
      const fallback = `Could not generate structured slides. Here's the raw content:\n\n${raw}`;
      socket.emit('token', { token: fallback });
      if (convId) {
        stmts.insertMessage.run(convId, 'assistant', 'SlideAgent', fallback);
        stmts.touchConversation.run(convId);
      }
      socket.emit('done', { agent: 'SlideAgent' });
      return;
    }

    // Resolve visual assets (images/diagrams) if any slides request them
    const hasVisuals = deckData.slides.some(s => s.image);
    if (hasVisuals) {
      socket.emit('token', { token: '\nGenerating visuals for slides...\n' });
      await resolveVisuals(deckData, {
        onProgress: (msg) => socket.emit('token', { token: `> ${msg}\n` }),
        config,
      });
      socket.emit('token', { token: '\nBuilding PowerPoint...\n\n' });
    }

    // Build the PowerPoint file
    const filename = await buildPptx(deckData);

    // Save as per-user asset
    const slidesPath = join(__dirname, '..', 'data', 'slides', filename);
    let downloadUrl;
    try {
      const buffer = readFileSync(slidesPath);
      const assetId = saveAsset(socket.user.id, convId, 'slide', filename, buffer, deckData.title || 'Presentation');
      downloadUrl = assetUrl(socket, assetId);
      try { unlinkSync(slidesPath); } catch { /* ignore */ }
    } catch {
      const scheme = socket.handshake.secure ? 'https' : 'http';
      const host = socket.handshake.headers.host || `localhost:${config.port}`;
      downloadUrl = `${scheme}://${host}/slides/${filename}`;
    }

    // Stream a summary to the user
    let summary = `**${deckData.title}**\n\n`;
    summary += `${deckData.slides.length} slides generated:\n\n`;
    deckData.slides.forEach((s, i) => {
      summary += `${i + 1}. **${s.title}**`;
      if (s.bullets?.length) summary += ` — ${s.bullets.length} points`;
      summary += '\n';
    });
    summary += `\n[Download PowerPoint](${downloadUrl})\n`;

    socket.emit('token', { token: summary });

    if (convId) {
      stmts.insertMessage.run(convId, 'assistant', 'SlideAgent', 'Generating presentation...\n\n' + summary);
      stmts.touchConversation.run(convId);
    }
    socket.emit('done', { agent: 'SlideAgent' });
    console.log(`[SlideAgent] generated ${filename} (${deckData.slides.length} slides)`);
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      await streamDemo(socket, 'SlideAgent', prompt, modelCfg.endpoint, convId);
    } else {
      console.error('[SlideAgent] error:', err.message);
      socket.emit('error', { message: `SlideAgent error: ${err.message}` });
    }
  }
}

async function streamDemo(socket, agentId, prompt, offlineEndpoint, convId) {
  const lines = buildDemoResponse(agentId, prompt, offlineEndpoint);
  let fullResponse = '';
  for (const chunk of lines) {
    fullResponse += chunk;
    socket.emit('token', { token: chunk });
    await sleep(18);
  }
  if (convId) {
    stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
    stmts.touchConversation.run(convId);
  }
  socket.emit('done', { agent: agentId });
}

function buildDemoResponse(agentId, prompt, endpoint) {
  const endpointNote = endpoint
    ? `\n\n> **Model offline** — \`${endpoint}\` is not reachable. Start your local model and reconnect.\n`
    : '';

  const body = DEMO_RESPONSES[agentId]?.(prompt) ?? DEMO_RESPONSES.AssistantAgent(prompt);
  return tokenise(body + endpointNote);
}

/** Split a string into small chunks to simulate token streaming. */
function tokenise(text, chunkSize = 4) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Demo responses (shown when LLM backends are offline) ─────────────
const DEMO_RESPONSES = {
  AssistantAgent: (p) => `**AssistantAgent** — demo response\n\nYou asked: *"${p}"*\n\nThis is a demo response. Connect a General LLM backend on port 8001 to get real answers.`,
  CoderAgent: (p) => `**CoderAgent** — demo response\n\nYou asked: *"${p}"*\n\n\`\`\`python\n# Example script\ndef hello():\n    print("Hello from CoderAgent!")\n\nif __name__ == "__main__":\n    hello()\n\`\`\`\n\nConnect **Qwen3-Coder 80B** on port 8000 for real code generation.`,
  DiagramAgent: (p) => `**DiagramAgent** — demo response\n\n\`\`\`mermaid\ngraph TD\n    A[Browser] -->|Socket.IO| B[GSD Server]\n    B -->|/v1/chat| C[General LLM :8001]\n    B -->|/v1/chat| D[Qwen3-Coder :8000]\n    B -->|HTTP| E[ComfyUI :8188]\n\`\`\`\n\nConnect a General LLM backend to generate real diagrams.`,
  ImageAgent: () => `**ImageAgent** — demo response\n\nComfyUI is not running on port 8188. Start ComfyUI and reconnect to generate images.\n\nExpected response format when online:\n\n![Generated image](http://localhost:8188/view?filename=gsd_00001.png)`,
  ReviewAgent: (p) => `**ReviewAgent** — demo response\n\nYou asked: *"${p}"*\n\n| Severity | Finding | Suggestion |\n|----------|---------|------------|\n| Major | Demo mode active | Connect Qwen3-Coder 80B on port 8000 |\n| Minor | No real analysis | Submit actual code for review |\n`,
  ArchitectAgent: (p) => `**ArchitectAgent** — demo response\n\nYou asked: *"${p}"*\n\n## Architecture Overview\n\n- **Frontend**: Static SPA → Socket.IO → GSD Backend\n- **Routing**: RouterAgent → Specialist agents\n- **Models**: General LLM (port 8001) · Qwen3-Coder 80B (port 8000) · ComfyUI (port 8188)\n\nStart your model backends for real architectural analysis.`,
};

// Add remaining agents that map to general/coder demo
for (const id of ['AlertAgent','AnalystAgent','ClientBriefAgent','DemoAgent','DeployAgent',
  'DocAgent','GitAgent','HealthAgent','InfraAgent','LogWatchAgent','ProposalAgent',
  'ResearchAgent','SlideAgent','TestAgent','VideoScriptAgent']) {
  if (!DEMO_RESPONSES[id]) {
    DEMO_RESPONSES[id] = (p) => `**${id}** — demo response\n\nYou asked: *"${p}"*\n\nThis agent uses the General LLM backend. Start the model on port 8001 to get real responses.`;
  }
}

// ── Start ────────────────────────────────────────────────────────────
httpServer.listen(config.port, () => {
  console.log(`GSD backend listening on http://localhost:${config.port}`);
  console.log(`Demo mode: ${config.demoMode ? 'ON' : 'OFF'}`);
  console.log(`General LLM: ${config.models.general.endpoint}`);
  console.log(`Coder LLM:   ${config.models.coder.endpoint}`);
  console.log(`ComfyUI:     ${config.models.comfyui.endpoint}`);
});

export { io, app, httpServer };
