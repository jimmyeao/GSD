import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync,
  rmSync, statSync, existsSync, renameSync,
} from 'node:fs';
import archiver from 'archiver';
import {
  buildLoveImage,
  loveImageExists,
  startLoveContainer,
  stopLoveContainer,
  getLoveContainerStatus,
} from '../services/loveRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = join(__dirname, '..', '..', 'data', 'workspaces');

const router = Router();
router.use(expressAuth);

// ── Helpers ────────────────────────────────────────────────────────

/** Return the workspace root dir for a user + project. */
function workspaceRoot(userId, projectId) {
  return join(WORKSPACES_ROOT, String(userId), String(projectId));
}

/** Sanitise the `path` query-param against directory traversal. */
function safePath(root, rawPath, res) {
  if (!rawPath || rawPath.includes('..')) {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  const cleaned = rawPath.split('/').filter(Boolean).join(sep);
  const resolved = resolve(root, cleaned);
  if (!resolved.startsWith(root)) {
    res.status(400).json({ error: 'Invalid path' });
    return null;
  }
  return resolved;
}

/** Verify project ownership; returns project row or sends 404. */
function requireProject(req, res) {
  const project = stmts.getProject.get(req.params.projectId, req.user.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  return project;
}

/** Build a recursive file-tree array for a directory. */
function buildTree(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.map((e) => {
    if (e.isDirectory()) {
      return { name: e.name, type: 'dir', children: buildTree(join(dir, e.name)) };
    }
    return { name: e.name, type: 'file' };
  });
}

// ── Project CRUD ───────────────────────────────────────────────────

router.get('/projects', (req, res) => {
  const rows = stmts.listProjects.all(req.user.id);
  res.json({ projects: rows });
});

router.post('/projects', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = stmts.insertProject.run(req.user.id, name.slice(0, 120));
  const project = stmts.getProject.get(result.lastInsertRowid, req.user.id);
  // Create workspace dir eagerly
  mkdirSync(workspaceRoot(req.user.id, project.id), { recursive: true });
  res.status(201).json({ project });
});

router.delete('/projects/:id', (req, res) => {
  const changes = stmts.deleteProject.run(req.params.id, req.user.id);
  if (changes.changes === 0) return res.status(404).json({ error: 'Project not found' });
  // Remove workspace dir
  const root = workspaceRoot(req.user.id, req.params.id);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
  res.json({ deleted: true });
});

// ── Project env vars ──────────────────────────────────────────────

router.get('/projects/:id/env', (req, res) => {
  const project = stmts.getProject.get(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const env = JSON.parse(project.env_vars || '{}');
    res.json({ env });
  } catch { res.json({ env: {} }); }
});

router.put('/projects/:id/env', (req, res) => {
  const project = stmts.getProject.get(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const env = req.body?.env;
  if (!env || typeof env !== 'object') return res.status(400).json({ error: 'env object required' });
  stmts.updateProjectEnv.run(JSON.stringify(env), req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Project type detection ─────────────────────────────────────────

router.get('/:projectId/detect', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  mkdirSync(root, { recursive: true });

  const has = (f) => existsSync(join(root, f));

  // Priority: compose > dockerfile > detected runtime
  if (has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yml') || has('compose.yaml')) {
    return res.json({ type: 'compose' });
  }
  if (has('Dockerfile')) {
    return res.json({ type: 'dockerfile' });
  }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
      const start = pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : 'node index.js';
      return res.json({ type: 'node', image: 'node:20-slim', install: 'npm install', start });
    } catch { return res.json({ type: 'node', image: 'node:20-slim', install: 'npm install', start: 'node index.js' }); }
  }
  // LÖVE: main.lua is the standard entry point. Confirm by either having
  // conf.lua (the LÖVE config file) OR spotting a love.* call in main.lua.
  if (has('main.lua')) {
    let looksLikeLove = has('conf.lua');
    if (!looksLikeLove) {
      try {
        const main = readFileSync(join(root, 'main.lua'), 'utf-8');
        looksLikeLove = /\blove\.(load|update|draw|keypressed|mousepressed)\b/.test(main);
      } catch { /* ignore */ }
    }
    if (looksLikeLove) {
      return res.json({
        type: 'love',
        start: 'love .',
        export: '.love',
        note: 'LÖVE games render a native window — run the exported .love locally. The IDE gives you syntax, editing, and git.',
      });
    }
    // Plain Lua script
    return res.json({ type: 'lua', image: 'nickblah/lua:5.4', install: '', start: 'lua main.lua' });
  }
  if (has('requirements.txt')) {
    return res.json({ type: 'python', image: 'python:3.12-slim', install: 'pip install -r requirements.txt', start: 'python main.py' });
  }
  if (has('go.mod')) {
    return res.json({ type: 'go', image: 'golang:1.22-alpine', install: '', start: 'go run .' });
  }
  res.json({ type: 'unknown', image: 'node:20-slim' });
});

// ── File tree ──────────────────────────────────────────────────────

router.get('/:projectId/tree', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  mkdirSync(root, { recursive: true });
  res.json({ tree: buildTree(root) });
});

// ── Project export (ZIP) ──────────────────────────────────────────
// Streams the whole workspace dir as a ZIP. Excludes heavy/sensitive dirs
// (node_modules, .git, dist/build) and any .env* files so secrets never
// end up in a shared archive.
router.get('/:projectId/zip', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  if (!existsSync(root)) return res.status(404).json({ error: 'Workspace not found' });

  const safeName = String(project.name || `project-${project.id}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || `project-${project.id}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[workspace zip] warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[workspace zip] error:', err.message);
    // If headers are already out we can't send JSON — just cut the stream.
    if (!res.headersSent) res.status(500).json({ error: 'zip failed' });
    else try { res.end(); } catch { /* ignore */ }
  });
  // Abort the archive if the client disconnects so we don't waste I/O.
  req.on('close', () => { try { archive.abort(); } catch { /* ignore */ } });

  archive.pipe(res);
  archive.glob('**/*', {
    cwd: root,
    dot: true,
    ignore: [
      'node_modules/**',
      '.git/**',
      'dist/**',
      'build/**',
      '.next/**',
      '.cache/**',
      '**/.env',
      '**/.env.*',
    ],
  });
  archive.finalize();
});

// LÖVE export — a .love file is literally a zip of the project renamed to
// .love, with main.lua at the archive root. We enforce that main.lua exists
// so the download is actually runnable by the love binary.
router.get('/:projectId/love', (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  if (!existsSync(root)) return res.status(404).json({ error: 'Workspace not found' });
  if (!existsSync(join(root, 'main.lua'))) {
    return res.status(400).json({ error: 'No main.lua found — LÖVE needs main.lua at the project root.' });
  }
  const safeName = String(project.name || `project-${project.id}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || `project-${project.id}`;
  res.setHeader('Content-Type', 'application/x-love-game');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.love"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[workspace love] warning:', err.message);
  });
  archive.on('error', (err) => {
    console.error('[workspace love] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'love export failed' });
    else try { res.end(); } catch { /* ignore */ }
  });
  req.on('close', () => { try { archive.abort(); } catch { /* ignore */ } });

  archive.pipe(res);
  // main.lua MUST be at archive root for LÖVE to find it — same glob as
  // /zip but with tighter ignores since .love files don't want dev cruft.
  archive.glob('**/*', {
    cwd: root,
    dot: false,
    ignore: [
      'node_modules/**',
      '.git/**',
      'dist/**',
      'build/**',
      '.cache/**',
      '.vscode/**',
      '.idea/**',
      '**/.env',
      '**/.env.*',
      '*.love',
    ],
  });
  archive.finalize();
});

// ── File read ──────────────────────────────────────────────────────

router.get('/:projectId/file', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  const target = safePath(root, req.query.path, res);
  if (!target) return;
  if (!existsSync(target)) return res.status(404).json({ error: 'File not found' });
  try {
    const content = readFileSync(target, 'utf-8');
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File write (update) ────────────────────────────────────────────

router.put('/:projectId/file', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  const target = safePath(root, req.query.path, res);
  if (!target) return;
  if (typeof req.body?.content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, req.body.content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File/dir create ────────────────────────────────────────────────

router.post('/:projectId/file', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  const target = safePath(root, req.query.path, res);
  if (!target) return;
  const type = req.body?.type;
  if (type !== 'file' && type !== 'dir') {
    return res.status(400).json({ error: 'type must be "file" or "dir"' });
  }
  try {
    if (type === 'dir') {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, req.body.content ?? '', 'utf-8');
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File/dir rename ───────────────────────────────────────────────

router.patch('/:projectId/file', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  const source = safePath(root, req.query.path, res);
  if (!source) return;
  const newName = req.body?.newName?.trim();
  if (!newName || newName.includes('/') || newName.includes('..')) {
    return res.status(400).json({ error: 'Invalid new name' });
  }
  if (!existsSync(source)) return res.status(404).json({ error: 'File not found' });
  try {
    const dest = join(dirname(source), newName);
    if (!dest.startsWith(root)) return res.status(400).json({ error: 'Invalid path' });
    renameSync(source, dest);
    res.json({ ok: true, newName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── File/dir delete ────────────────────────────────────────────────

router.delete('/:projectId/file', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  const target = safePath(root, req.query.path, res);
  if (!target) return;
  if (!existsSync(target)) return res.status(404).json({ error: 'File not found' });
  try {
    const st = statSync(target);
    if (st.isDirectory()) {
      rmSync(target, { recursive: true, force: true });
    } else {
      rmSync(target);
    }
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LÖVE in-browser runner ────────────────────────────────────────
// Starts a container that runs the LÖVE game under Xvfb + noVNC and
// returns a preview URL the frontend can drop into an iframe. One
// love container per project at a time.

router.post('/:projectId/love/run', async (req, res) => {
  const project = requireProject(req, res);
  if (!project) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  if (!existsSync(join(root, 'main.lua'))) {
    return res.status(400).json({ error: 'main.lua not found at project root' });
  }

  try {
    // Build the runner image on first use. Subsequent runs skip this.
    if (!(await loveImageExists())) {
      console.log('[love] building alice-love-runner image (first run, ~60s expected)');
      await buildLoveImage((evt) => { if (evt.stream) process.stdout.write(evt.stream); });
    }

    // Reserve a DB row so the /preview route can look up by containerId.
    const ins = stmts.insertContainer.run(req.params.projectId, req.user.id, 'alice-love-runner:latest');
    const containerId = ins.lastInsertRowid;
    const friendlyName = `love-u${req.user.id}-p${req.params.projectId}-${containerId}`;

    const { dockerId, hostPort } = await startLoveContainer(root, friendlyName);
    stmts.updateContainerStatus.run('running', dockerId, containerId);

    res.json({
      containerId,
      dockerId,
      hostPort,
      // The frontend embeds this in an iframe. The proxy handles HTTP
      // (static noVNC assets) AND the websocket upgrade to /websockify.
      // KasmVNC web client. The `path` MUST be prefixed with `api/` so
      // the upgrade goes through the NGINX /api/ block that forwards WS
      // headers. `username`/`password` are the fixed credentials baked
      // into the image (safe because container is behind our session auth).
      url: `/api/preview/${containerId}/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=api/preview/${containerId}/websockify&username=kasm&password=alicelove`,
    });
  } catch (err) {
    console.error('[love/run] error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'love run failed' });
  }
});

router.post('/:projectId/love/stop', async (req, res) => {
  if (!requireProject(req, res)) return;
  try {
    const id = req.body?.containerId;
    if (!id) return res.status(400).json({ error: 'containerId required' });
    const row = stmts.getContainer.get(id, req.user.id);
    if (row && row.docker_id) {
      await stopLoveContainer(row.docker_id).catch(() => {});
      stmts.updateContainerStatus.run('stopped', row.docker_id, row.id);
    }
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'stop failed' });
  }
});

router.get('/:projectId/love/status', async (req, res) => {
  if (!requireProject(req, res)) return;
  const id = req.query.containerId;
  if (!id) return res.status(400).json({ error: 'containerId required' });
  const row = stmts.getContainer.get(id, req.user.id);
  if (!row || !row.docker_id) return res.json({ running: false });
  const info = await getLoveContainerStatus(row.docker_id);
  res.json({ running: !!info?.running, info });
});

export default router;
