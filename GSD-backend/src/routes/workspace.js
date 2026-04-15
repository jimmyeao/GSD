import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync,
  rmSync, statSync, existsSync, renameSync,
} from 'node:fs';

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

// ── File tree ──────────────────────────────────────────────────────

router.get('/:projectId/tree', (req, res) => {
  if (!requireProject(req, res)) return;
  const root = workspaceRoot(req.user.id, req.params.projectId);
  mkdirSync(root, { recursive: true });
  res.json({ tree: buildTree(root) });
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

export default router;
