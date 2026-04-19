import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer as createHttpServer } from 'node:http';
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
import { stmts, expireStaleApprovals } from './db.js';
import { runMailAgent, executeApprovedAction, summariseExecution, isCompoundRequest } from './agents/mailAgent.js';
import { socketAuth, csrfProtect } from './auth.js';
import authRoutes from './routes/auth.js';
import convRoutes from './routes/conversations.js';
import assetsRoutes from './routes/assets.js';
import workspaceRoutes from './routes/workspace.js';
import sandboxRoutes from './routes/sandbox.js';
import previewRoutes from './routes/preview.js';
import adminRoutes from './routes/admin.js';
import mailRoutes from './routes/mail.js';
import { isTokenKeyValid } from './mail/tokens.js';
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';

const app = express();
// Backend runs behind NGINX which terminates TLS; always bind plain HTTP.
app.set('trust proxy', 'loopback');
const httpServer = createHttpServer(app);

// CORS config shared by Express and Socket.IO — origin-locked for credentials.
const corsOrigin = config.publicUrl || config.cors.origin || true;
const corsConfig = {
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
};

const io = new Server(httpServer, {
  cors: corsConfig,
  // Qwen3 thinking phase can be silent for minutes — keep socket alive
  pingTimeout: 600_000,
  pingInterval: 25_000,
  // Allow large payloads for image attachments (20MB)
  maxHttpBufferSize: 20 * 1024 * 1024,
});

// ── Middleware ──────────────────────────────────────────────────────
// cookieParser must run before csrfProtect / routes that read cookies.
// The secret enables signed cookies (used for the OAuth state cookie).
app.use(cookieParser(config.sessionSecret || config.jwtSecret || 'gsd-unsigned'));
app.use(cors(corsConfig));
app.use(express.json({ limit: '10mb' }));
// Double-submit-cookie CSRF — checked on mutating requests only.
app.use(csrfProtect);

// ── Routes ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: Object.keys(config.models), demoMode: config.demoMode });
});
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/conversations', convRoutes);
app.use('/assets', assetsRoutes);
app.use('/workspace', workspaceRoutes);
app.use('/sandbox', sandboxRoutes);
app.use('/preview', previewRoutes);
app.use('/mail', mailRoutes);

// ── Text-to-speech via Piper ──────────────────────────────────────
app.post('/tts', express.json(), async (req, res) => {
  const text = req.body?.text;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const { textToSpeech } = await import('./services/ttsService.js');
    const wav = await textToSpeech(text, { speed: req.body.speed });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(wav);
  } catch (err) {
    console.error('[tts] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

    // ── MailAgent → tool-calling + approval flow ───────────────────
    if (agentId === 'MailAgent') {
      await runMailAgent({ socket, user: socket.user, content, history, convId });
      return;
    }

    // ── LLM streaming ─────────────────────────────────────────────
    const modelCfg = config.models[agentDef.model];
    const messages = buildMessages(agentDef.systemPrompt, history, content);

    let fullResponse = '';
    const streamAbort = new AbortController();
    const onStop = () => streamAbort.abort();
    socket.once('stop:stream', onStop);

    try {
      const stream = streamCompletion(
        modelCfg.endpoint,
        modelCfg.model,
        messages,
        {
          signal: streamAbort.signal,
          onThinking: () => socket.emit('thinking', {}),
          noThink: agentDef.noThink ?? false,
        },
      );

      for await (const token of stream) {
        if (streamAbort.signal.aborted) break;
        fullResponse += token;
        socket.emit('token', { token });
      }

      // Persist whatever we got (even if stopped early)
      if (fullResponse) {
        stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
        stmts.touchConversation.run(convId);
      }

      socket.emit('done', { agent: agentId });
      console.log(`[${agentId}] stream complete${streamAbort.signal.aborted ? ' (stopped by user)' : ''}`);
    } catch (err) {
      // If user stopped, still save what we have and emit done
      if (streamAbort.signal.aborted) {
        if (fullResponse) {
          stmts.insertMessage.run(convId, 'assistant', agentId, fullResponse);
          stmts.touchConversation.run(convId);
        }
        socket.emit('done', { agent: agentId });
      } else if (err instanceof LLMUnavailableError) {
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

  // ── Mail approval response (approve/reject a pending mutation) ──
  socket.on('mail:approval_response', async ({ approvalId, decision }) => {
    try {
      if (!Number.isFinite(Number(approvalId))) {
        socket.emit('mail:approval_error', { approvalId, error: 'invalid approvalId' });
        return;
      }
      if (decision !== 'approve' && decision !== 'reject') {
        socket.emit('mail:approval_error', { approvalId, error: 'invalid decision' });
        return;
      }
      // Sweep expired rows first so a stale approval is caught cleanly.
      expireStaleApprovals();

      const approval = stmts.getApproval.get(Number(approvalId), socket.user.id);
      if (!approval) {
        socket.emit('mail:approval_error', { approvalId, error: 'not_found' });
        return;
      }
      if (approval.status !== 'pending') {
        socket.emit('mail:approval_error', { approvalId, error: `already_${approval.status}` });
        return;
      }
      // Expiry check (race with the periodic sweeper).
      const now = new Date();
      const expires = new Date(approval.expires_at.replace(' ', 'T') + 'Z');
      if (!isNaN(expires.getTime()) && expires < now) {
        stmts.updateApprovalStatus.run('expired', null, 'expired', approval.id);
        socket.emit('mail:approval_error', { approvalId, error: 'expired' });
        return;
      }

      const convId = approval.conversation_id;

      if (decision === 'reject') {
        stmts.updateApprovalStatus.run('rejected', null, null, approval.id);
        socket.emit('mail:approval_resolved', { approvalId, status: 'rejected' });

        const msg = `Action rejected — nothing was sent or changed.`;
        // Stream chunks so it renders inline in the chat.
        for (let i = 0; i < msg.length; i += 4) {
          socket.emit('token', { token: msg.slice(i, i + 4) });
        }
        if (convId) {
          stmts.insertMessage.run(convId, 'assistant', 'MailAgent', msg);
          stmts.touchConversation.run(convId);
        }
        socket.emit('done', { agent: 'MailAgent' });
        return;
      }

      // decision === 'approve'
      const { ok, result, error } = await executeApprovedAction(socket.user, approval);
      if (ok) {
        stmts.updateApprovalStatus.run('executed', JSON.stringify(result ?? {}), null, approval.id);
        socket.emit('mail:approval_resolved', { approvalId, status: 'executed', result });
        const summary = summariseExecution(approval, result);
        for (let i = 0; i < summary.length; i += 4) {
          socket.emit('token', { token: summary.slice(i, i + 4) });
        }
        if (convId) {
          stmts.insertMessage.run(convId, 'assistant', 'MailAgent', summary);
          stmts.touchConversation.run(convId);
        }
        socket.emit('done', { agent: 'MailAgent' });
        // Auto-continue MailAgent for compound asks once all approvals in this
        // conversation have resolved (e.g. "unsubscribe then trash" — after the
        // last unsub resolves, re-invoke so the agent can emit trash calls).
        maybeAutoContinueMailAgent(socket, convId, summary).catch(err => {
          console.error('[mail:auto-continue] error:', err?.message || err);
        });
      } else {
        stmts.updateApprovalStatus.run('failed', null, String(error || 'failed'), approval.id);
        socket.emit('mail:approval_resolved', { approvalId, status: 'failed', error: String(error || 'failed') });
        const msg = `Action failed: ${error || 'unknown error'}.`;
        for (let i = 0; i < msg.length; i += 4) {
          socket.emit('token', { token: msg.slice(i, i + 4) });
        }
        if (convId) {
          stmts.insertMessage.run(convId, 'assistant', 'MailAgent', msg);
          stmts.touchConversation.run(convId);
        }
        socket.emit('done', { agent: 'MailAgent' });
      }
    } catch (err) {
      console.error('[mail:approval_response] error:', err?.message || err);
      socket.emit('mail:approval_error', { approvalId, error: err?.message || 'failed' });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[ws] disconnected: ${socket.id} (${reason})`);
  });

  // ── Code-mode: CoderAgent with auto-save ──────────────────────────
  socket.on('code:message', async ({ content, projectId, conversationId, history = [] }) => {
    if (!content?.trim() || !projectId) return;
    try {
      const project = stmts.getProject.get(projectId, socket.user.id);
      if (!project) { socket.emit('code:error', { message: 'Project not found' }); return; }

      const wsRoot = join(__dirname, '..', 'data', 'workspaces', String(socket.user.id), String(projectId));
      mkdirSync(wsRoot, { recursive: true });

      // Build file tree
      function buildFileList(dir, prefix = '') {
        let result = '';
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            if (e.isDirectory()) {
              result += `${prefix}${e.name}/\n` + buildFileList(join(dir, e.name), prefix + '  ');
            } else {
              result += `${prefix}${e.name}\n`;
            }
          }
        } catch { /* empty or unreadable dir */ }
        return result;
      }
      const fileTreeString = buildFileList(wsRoot) || '(empty project)';

      const systemPrompt = `You are CoderAgent, an expert software engineer integrated with an IDE.
You write production-quality code and directly create/modify files in the user's project.

CURRENT PROJECT FILES:
${fileTreeString}

IMPORTANT: When writing or modifying code, ALWAYS use filename-tagged code blocks:
\`\`\`language:path/to/file.ext
code here
\`\`\`

For example:
\`\`\`javascript:src/index.js
console.log('hello');
\`\`\`

Every filename-tagged code block will be automatically saved to the project.
Use regular (untagged) code blocks for examples or snippets that shouldn't be saved.
When modifying existing files, include the COMPLETE file content, not just changes.`;

      // Resolve or create conversation
      let convId = conversationId;
      if (convId) { if (!stmts.getConversation.get(convId, socket.user.id)) convId = null; }
      if (!convId) {
        const title = content.slice(0, 80).replace(/\n/g, ' ').trim() || 'Code Session';
        const result = stmts.insertConversation.run(socket.user.id, title, 'CoderAgent');
        convId = result.lastInsertRowid;
        socket.emit('conversation:created', { id: convId, title, agent_id: 'CoderAgent' });
      }
      stmts.insertMessage.run(convId, 'user', null, content);

      // Demo mode
      if (config.demoMode) { await streamDemo(socket, 'CoderAgent', content, undefined, convId); return; }

      const modelCfg = config.models.coder;
      const messages = buildMessages(systemPrompt, history, content);
      let fullResponse = '';

      const stream = streamCompletion(modelCfg.endpoint, modelCfg.model, messages, {
        signal: AbortSignal.timeout(modelCfg.timeout),
        onThinking: () => socket.emit('thinking', {}),
      });

      for await (const token of stream) {
        fullResponse += token;
        socket.emit('code:token', { token });
      }

      // Parse and save tagged code blocks
      const codeBlockRe = /```(\w+):([^\n]+)\n([\s\S]*?)```/g;
      let match;
      while ((match = codeBlockRe.exec(fullResponse)) !== null) {
        const [, language, filePath, code] = match;
        const safePath = filePath.replace(/\.\./g, '').replace(/^\//, '');
        const absPath = join(wsRoot, safePath);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, code);
        socket.emit('code:file-written', { path: safePath, language });
        console.log(`[CoderAgent] wrote ${safePath}`);
      }

      stmts.insertMessage.run(convId, 'assistant', 'CoderAgent', fullResponse);
      stmts.touchConversation.run(convId);
      socket.emit('code:done', {});
    } catch (err) {
      console.error('[CoderAgent code:message] error:', err.message);
      socket.emit('code:error', { message: err.message });
    }
  });

  // ── Docker image build ────────────────────────────────────────────
  socket.on('build:start', async ({ projectId }) => {
    try {
      const project = stmts.getProject.get(projectId, socket.user.id);
      if (!project) {
        socket.emit('build:error', { error: 'Project not found' });
        return;
      }

      const { buildImage } = await import('./services/containerService.js');
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');

      const workspacePath = join(__dirname, '..', 'data', 'workspaces', String(socket.user.id), String(projectId));

      // Check for Dockerfile
      if (!existsSync(join(workspacePath, 'Dockerfile'))) {
        socket.emit('build:error', { error: 'No Dockerfile found in project root. Create a Dockerfile first.' });
        return;
      }

      const tag = `gsd-${socket.user.id}-${projectId}:latest`;
      socket.emit('build:log', { data: `Building image ${tag}...\n` });

      const imageId = await buildImage(workspacePath, tag, ({ stream, error }) => {
        if (stream) socket.emit('build:log', { data: stream });
        if (error) socket.emit('build:log', { data: `ERROR: ${error}\n` });
      });

      socket.emit('build:done', { tag, imageId });
      console.log(`[build] ${tag} complete: ${imageId}`);
    } catch (err) {
      console.error('[build] error:', err.message);
      socket.emit('build:error', { error: err.message });
    }
  });

  // ── Docker Compose streaming ──────────────────────────────────────
  socket.on('compose:up', async ({ projectId }) => {
    try {
      const project = stmts.getProject.get(projectId, socket.user.id);
      if (!project) { socket.emit('compose:error', { error: 'Project not found' }); return; }

      const { findComposeFile, composeUp } = await import('./services/composeService.js');
      const workspacePath = join(__dirname, '..', 'data', 'workspaces', String(socket.user.id), String(projectId));

      const composeFile = findComposeFile(workspacePath);
      if (!composeFile) {
        socket.emit('compose:error', { error: 'No docker-compose.yml found. Create one first.' });
        return;
      }

      const projectName = `gsd-${socket.user.id}-${projectId}`;
      const envVars = JSON.parse(project.env_vars || '{}');

      socket.emit('compose:log', { data: `Starting compose stack: ${projectName}...\n` });

      const result = await composeUp(workspacePath, projectName, {
        onOutput: (line) => socket.emit('compose:log', { data: line + '\n' }),
        env: envVars,
      });

      if (result.code === 0) {
        // Get service status
        const { composePs } = await import('./services/composeService.js');
        const services = await composePs(workspacePath, projectName);
        socket.emit('compose:done', { projectName, services });
      } else {
        socket.emit('compose:error', { error: `Compose exited with code ${result.code}` });
      }
    } catch (err) {
      socket.emit('compose:error', { error: err.message });
    }
  });

  socket.on('compose:down', async ({ projectId }) => {
    try {
      const project = stmts.getProject.get(projectId, socket.user.id);
      if (!project) { socket.emit('compose:error', { error: 'Project not found' }); return; }

      const { composeDown } = await import('./services/composeService.js');
      const workspacePath = join(__dirname, '..', 'data', 'workspaces', String(socket.user.id), String(projectId));
      const projectName = `gsd-${socket.user.id}-${projectId}`;

      socket.emit('compose:log', { data: 'Stopping compose stack...\n' });

      await composeDown(workspacePath, projectName, {
        onOutput: (line) => socket.emit('compose:log', { data: line + '\n' }),
      });

      socket.emit('compose:stopped', { projectName });
    } catch (err) {
      socket.emit('compose:error', { error: err.message });
    }
  });

  socket.on('compose:logs', async ({ projectId }) => {
    try {
      const project = stmts.getProject.get(projectId, socket.user.id);
      if (!project) return;

      const { composeLogs } = await import('./services/composeService.js');
      const workspacePath = join(__dirname, '..', 'data', 'workspaces', String(socket.user.id), String(projectId));
      const projectName = `gsd-${socket.user.id}-${projectId}`;

      const proc = composeLogs(workspacePath, projectName);

      proc.stdout.on('data', (data) => socket.emit('compose:log', { data: data.toString() }));
      proc.stderr.on('data', (data) => socket.emit('compose:log', { data: data.toString() }));
      proc.on('close', () => socket.emit('compose:log', { data: '[logs ended]\n' }));

      socket.on('disconnect', () => { try { proc.kill(); } catch {} });
    } catch (err) {
      socket.emit('compose:error', { error: err.message });
    }
  });

  // ── Container log streaming ──────────────────────────────────────
  socket.on('container:logs', async ({ containerId }) => {
    try {
      const container = stmts.getContainer.get(containerId, socket.user.id);
      if (!container) {
        socket.emit('container:error', { containerId, error: 'Container not found' });
        return;
      }
      const { streamLogs } = await import('./services/containerService.js');
      const stream = await streamLogs(container.docker_id, { follow: true, tail: 100 });
      stream.on('data', (chunk) => {
        socket.emit('container:output', { containerId, data: chunk.toString() });
      });
      stream.on('end', () => {
        socket.emit('container:output', { containerId, data: '\n[stream ended]\n' });
      });
      stream.on('error', (err) => {
        socket.emit('container:error', { containerId, error: err.message });
      });
      // Clean up stream when socket disconnects
      socket.on('disconnect', () => { try { stream.destroy(); } catch {} });
    } catch (err) {
      socket.emit('container:error', { containerId, error: err.message });
    }
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

function assetUrl(_socket, assetId) {
  // Behind NGINX: browser calls /api/assets/... with the session cookie attached.
  // Use a relative URL so the frontend's origin is always preserved.
  return `/api/assets/${assetId}/file`;
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
      // Fallback to proxy URL if caching fails — relative path served via NGINX.
      imgUrl = `/api/comfy-image?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
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
      // Fallback to flat URL — relative path served via NGINX.
      videoUrl = `/api/videos/${encodeURIComponent(vidData.filename)}`;
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
      // Fallback — relative path served via NGINX.
      downloadUrl = `/api/slides/${filename}`;
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

// ── Mail token key validation ───────────────────────────────────────
// Fail closed: if any mail OAuth client is configured but MAIL_TOKEN_KEY is
// missing or invalid, refuse to start. Encrypting tokens with an ephemeral
// (random) key would silently break refresh after every restart.
{
  const mailExpected = !!config.oauth.microsoft.clientId || !!config.oauth.google.clientId;
  const keyValid = isTokenKeyValid();
  if (mailExpected && !keyValid) {
    console.error('[FATAL] MAIL_TOKEN_KEY is missing or invalid but a mail OAuth provider is configured.');
    console.error('        Generate one:   openssl rand -base64 32');
    console.error('        Then add to .env as  MAIL_TOKEN_KEY=<value>  and restart.');
    process.exit(1);
  }
  console.log(`Mail OAuth: MS=${!!config.oauth.microsoft.clientId}, Google=${!!config.oauth.google.clientId}, tokenKey=${keyValid ? 'OK' : 'MISSING'}`);
}

// ── Mail continuation state ─────────────────────────────────────────
// Tracks how many times we've auto-re-invoked MailAgent for a conversation
// after an approval resolved. Capped per-conv to prevent runaway loops.
const _mailContinuationDepth = new Map(); // convId → count
const MAX_MAIL_CONTINUATION_DEPTH = 3;

async function maybeAutoContinueMailAgent(socket, convId, lastSummary) {
  if (!convId) return;
  // If another approval for this conversation is still pending, the agent
  // isn't ready to move to the next phase yet — wait for those to resolve.
  const remaining = stmts.listPendingApprovals.all(socket.user.id)
    .filter(a => a.conversation_id === convId).length;
  if (remaining > 0) return;

  // Original request must be a compound ask, else nothing to continue.
  const msgs = stmts.listMessages.all(convId);
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  if (!lastUser || !isCompoundRequest(lastUser.content)) return;

  const depth = _mailContinuationDepth.get(convId) || 0;
  if (depth >= MAX_MAIL_CONTINUATION_DEPTH) return;
  _mailContinuationDepth.set(convId, depth + 1);

  // Fetch the REAL executed actions for this conversation so the continuation
  // sees concrete message IDs to operate on. Without this, the model will
  // hallucinate IDs (they aren't carried in the assistant-message history).
  const resolved = stmts.listResolvedApprovalsByConv.all(convId, socket.user.id);
  const resolvedSummary = _formatResolvedForContinuation(resolved);

  socket.emit('mail:continuation_start', { conversationId: convId });

  // Pruned history: always include the original (first) user message so the
  // agent can see the full compound ask, plus the most recent context. If we
  // just sliced the tail, 20+ per-approval summaries would push the original
  // user request out of the window — and the continuation would have no idea
  // what phase 2 is.
  const firstUser = msgs.find(m => m.role === 'user');
  const tail = msgs.slice(-10);
  const seen = new Set();
  const history = [firstUser, ...tail]
    .filter(m => m && !seen.has(m.id) && seen.add(m.id))
    .map(m => ({ role: m.role, content: m.content }));

  const originalRequest = firstUser?.content || lastUser.content;

  try {
    await runMailAgent({
      socket,
      user: socket.user,
      content: '(continue — execute the next phase of the original request using the ids listed in the continuation block)',
      history,
      convId,
      continuation: `ORIGINAL USER REQUEST: """${originalRequest}"""

ACTIONS ALREADY EXECUTED in this conversation (use these EXACT ids when targeting the same items — NEVER invent ids):
${resolvedSummary || '(none)'}

Now pick up where you left off. If the original request was compound ("unsubscribe from X then trash them", "reply to A and forward to B"), the earlier phase is done — emit plan_mutations NOW for the next phase, targeting the SAME items by their exact message_id / account_id from the list above. If the original request is fully complete, say so in one short sentence and stop. Do not re-emit actions that are already in the executed list.`,
    });
  } finally {
    // Reset depth once no further continuations fire — we cap runaway loops
    // but we don't want a stale counter blocking future compound asks.
    setTimeout(() => {
      const d = _mailContinuationDepth.get(convId) || 0;
      if (d <= depth + 1) _mailContinuationDepth.delete(convId);
    }, 60_000);
  }
}

function _formatResolvedForContinuation(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const lines = [];
  for (const r of rows) {
    if (r.status !== 'executed') continue;
    let p = {};
    try { p = JSON.parse(r.payload); } catch { /* ignore */ }
    const bits = [`action=${r.action_type}`, `account_id=${r.account_id}`];
    if (p.message_id) bits.push(`message_id="${p.message_id}"`);
    if (p.event_id) bits.push(`event_id="${p.event_id}"`);
    if (p.subject) bits.push(`subject=${JSON.stringify(p.subject)}`);
    if (p.sender?.email) bits.push(`from=${p.sender.email}`);
    lines.push(`- ${bits.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Mail approval expiry sweeper ────────────────────────────────────
// Runs once on boot and every 5 minutes to retire stale pending approvals.
try { expireStaleApprovals(); } catch { /* ignore */ }
const _approvalSweeper = setInterval(() => {
  try { expireStaleApprovals(); } catch { /* ignore */ }
}, 5 * 60 * 1000);
if (typeof _approvalSweeper.unref === 'function') _approvalSweeper.unref();

// ── Start ────────────────────────────────────────────────────────────
// Default bind is loopback; set HOST=0.0.0.0 (or a specific IP) when NGINX
// runs on a separate host and needs to reach the backend over the network.
const bindHost = process.env.HOST || '127.0.0.1';
httpServer.listen(config.port, bindHost, () => {
  console.log(`GSD backend listening on http://${bindHost}:${config.port}`);
  console.log(`Public URL:  ${config.publicUrl}`);
  console.log(`Demo mode:   ${config.demoMode ? 'ON' : 'OFF'}`);
  console.log(`General LLM: ${config.models.general.endpoint}`);
  console.log(`Coder LLM:   ${config.models.coder.endpoint}`);
  console.log(`ComfyUI:     ${config.models.comfyui.endpoint}`);
});

export { io, app, httpServer };
