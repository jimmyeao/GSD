/**
 * Git routes — per-project git operations for the CoderAgent workspace.
 *
 * Mounts under /git. All paths scope to a project the authenticated user
 * owns; the actual git repo lives inside data/workspaces/{userId}/{projectId}.
 *
 * Backed by simple-git. Keeps the surface small and opinionated:
 *   - Status / diff / log / branches: always safe, read-only.
 *   - Stage / unstage / commit / checkout / branch create / remote config:
 *     mutating but local-only. No confirmation required.
 *   - Push / pull: require the caller to have configured a remote with a
 *     credential-embedded URL (https://token@host/repo.git) or a working
 *     SSH key on disk. No credential storage here in v1.
 *
 * Destructive ops NOT exposed in v1: reset --hard, clean -fd, push --force,
 * rebase. Those need explicit confirmation UX and a much more careful guard.
 */

import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import simpleGit from 'simple-git';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = join(__dirname, '..', '..', 'data', 'workspaces');

const router = Router();
router.use(expressAuth);

function workspaceRoot(userId, projectId) {
  return join(WORKSPACES_ROOT, String(userId), String(projectId));
}

function requireProject(req, res) {
  const project = stmts.getProject.get(req.params.projectId, req.user.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  return project;
}

/**
 * Build a simple-git client for the project workspace. If the workspace
 * directory doesn't exist yet, create it (matches other workspace routes).
 * Note: this does NOT call `git init` — that's the explicit /init route.
 */
function gitFor(req) {
  const root = workspaceRoot(req.user.id, req.params.projectId);
  mkdirSync(root, { recursive: true });
  return { git: simpleGit({ baseDir: root, maxConcurrentProcesses: 2 }), root };
}

async function isRepo(git) {
  try { return await git.checkIsRepo(); } catch { return false; }
}

/** Standard error shape — never leaks full stack / env to the client. */
function sendGitError(res, err, fallback = 'git command failed') {
  const msg = (err && err.message) || fallback;
  // simple-git surfaces the git stderr in .message; scrub anything that
  // looks like an absolute filesystem path so the client can't map layout.
  const safe = String(msg).replace(/\/[^ \n]*data\/workspaces\/[^ \n]*/g, '<workspace>');
  res.status(500).json({ error: safe.slice(0, 400) });
}

// ── Init ──────────────────────────────────────────────────────────

router.post('/:projectId/init', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  try {
    if (await isRepo(git)) return res.json({ initialised: true, alreadyInit: true });
    await git.init();
    // Set a default branch name + identity so the first commit works out
    // of the box. Users can override via `/config` later if we add one.
    try { await git.raw(['config', 'user.name', req.user.username || 'GSD User']); } catch { /* non-fatal */ }
    try { await git.raw(['config', 'user.email', req.user.email || 'user@gsd.local']); } catch { /* non-fatal */ }
    try { await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch { /* non-fatal */ }
    res.json({ initialised: true });
  } catch (err) { sendGitError(res, err, 'git init failed'); }
});

// ── Status ────────────────────────────────────────────────────────
// Returns lists of {path, indexState, workingState} per file + current branch.
router.get('/:projectId/status', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false });
  try {
    const s = await git.status();
    const files = s.files.map(f => ({
      path: f.path,
      index: f.index,    // ' ', 'M', 'A', 'D', 'R', '?' for index state
      working: f.working_dir,
      staged: f.index !== ' ' && f.index !== '?',
      unstaged: f.working_dir !== ' ' && f.working_dir !== '?',
      untracked: f.index === '?' && f.working_dir === '?',
    }));
    res.json({
      repo: true,
      branch: s.current,
      tracking: s.tracking,
      ahead: s.ahead,
      behind: s.behind,
      detached: s.detached,
      files,
      hasUnstaged: files.some(f => f.unstaged || f.untracked),
      hasStaged: files.some(f => f.staged),
    });
  } catch (err) { sendGitError(res, err, 'git status failed'); }
});

// ── Diff ──────────────────────────────────────────────────────────
// ?path=… limits to one file; ?staged=1 shows the staged diff.
router.get('/:projectId/diff', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false, diff: '' });
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  if (path.includes('..')) return res.status(400).json({ error: 'invalid path' });
  const args = [];
  if (req.query.staged === '1' || req.query.staged === 'true') args.push('--cached');
  if (path) args.push('--', path);
  try {
    const diff = await git.diff(args);
    res.json({ repo: true, diff });
  } catch (err) { sendGitError(res, err, 'git diff failed'); }
});

// Helper: sanitise paths coming in via request body. Paths are relative to
// the workspace root; we forbid absolute paths and ".." traversal.
function sanitisePaths(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const p of raw) {
    if (typeof p !== 'string') return null;
    const trimmed = p.trim();
    if (!trimmed || trimmed.includes('..') || trimmed.startsWith('/')) return null;
    out.push(trimmed);
  }
  return out;
}

// ── Stage / unstage ───────────────────────────────────────────────
router.post('/:projectId/stage', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo — run init first' });
  const paths = req.body?.paths;
  try {
    if (paths === 'all') await git.add(['.']);
    else {
      const clean = sanitisePaths(paths);
      if (!clean || !clean.length) return res.status(400).json({ error: 'paths: array of paths or "all"' });
      await git.add(clean);
    }
    res.json({ ok: true });
  } catch (err) { sendGitError(res, err, 'git add failed'); }
});

router.post('/:projectId/unstage', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const paths = req.body?.paths;
  try {
    if (paths === 'all') await git.reset(['HEAD', '--']);
    else {
      const clean = sanitisePaths(paths);
      if (!clean || !clean.length) return res.status(400).json({ error: 'paths: array of paths or "all"' });
      await git.reset(['HEAD', '--', ...clean]);
    }
    res.json({ ok: true });
  } catch (err) { sendGitError(res, err, 'git reset failed'); }
});

// ── Commit ────────────────────────────────────────────────────────
router.post('/:projectId/commit', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'commit message required' });
  if (message.length > 2000) return res.status(400).json({ error: 'message too long' });
  try {
    const result = await git.commit(message);
    res.json({ ok: true, commit: result.commit, summary: result.summary });
  } catch (err) { sendGitError(res, err, 'git commit failed'); }
});

// ── Log ───────────────────────────────────────────────────────────
router.get('/:projectId/log', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false, commits: [] });
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
  try {
    const log = await git.log({ maxCount: limit });
    const commits = log.all.map(c => ({
      hash: c.hash,
      short: c.hash.slice(0, 7),
      date: c.date,
      message: c.message,
      author: c.author_name,
      email: c.author_email,
    }));
    res.json({ repo: true, commits });
  } catch (err) { sendGitError(res, err, 'git log failed'); }
});

// ── Branches ──────────────────────────────────────────────────────
router.get('/:projectId/branches', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false, branches: [], current: null });
  try {
    const b = await git.branchLocal();
    res.json({
      repo: true,
      current: b.current,
      branches: Object.values(b.branches).map(br => ({
        name: br.name,
        commit: br.commit,
        current: br.current,
      })),
    });
  } catch (err) { sendGitError(res, err, 'git branch failed'); }
});

router.post('/:projectId/branch', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const name = String(req.body?.name || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,80}$/.test(name)) return res.status(400).json({ error: 'invalid branch name' });
  const from = req.body?.from ? String(req.body.from).trim() : undefined;
  try {
    if (from) await git.checkoutBranch(name, from);
    else await git.checkoutLocalBranch(name);
    res.json({ ok: true, name });
  } catch (err) { sendGitError(res, err, 'git branch failed'); }
});

router.post('/:projectId/checkout', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const ref = String(req.body?.ref || '').trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) return res.status(400).json({ error: 'invalid ref' });
  try {
    await git.checkout(ref);
    res.json({ ok: true, ref });
  } catch (err) { sendGitError(res, err, 'git checkout failed'); }
});

// ── Remotes ───────────────────────────────────────────────────────
router.get('/:projectId/remotes', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false, remotes: [] });
  try {
    const remotes = await git.getRemotes(true);
    // Scrub anything that looks like an embedded token in the URL so the
    // secret never round-trips back to the client once saved.
    const scrub = (u) => u ? u.replace(/:\/\/[^@/]+@/, '://<auth>@') : u;
    res.json({
      repo: true,
      remotes: remotes.map(r => ({
        name: r.name,
        fetch: scrub(r.refs?.fetch),
        push: scrub(r.refs?.push),
      })),
    });
  } catch (err) { sendGitError(res, err, 'git remote list failed'); }
});

router.post('/:projectId/remote', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const name = String(req.body?.name || 'origin').trim();
  const url = String(req.body?.url || '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) return res.status(400).json({ error: 'invalid remote name' });
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url) || url.length > 500) return res.status(400).json({ error: 'invalid remote url' });
  try {
    const existing = await git.getRemotes();
    if (existing.some(r => r.name === name)) {
      await git.remote(['set-url', name, url]);
    } else {
      await git.addRemote(name, url);
    }
    res.json({ ok: true, name });
  } catch (err) { sendGitError(res, err, 'git remote failed'); }
});

// ── Push / pull ───────────────────────────────────────────────────
// Both rely on the user's existing auth (SSH key or URL-embedded token).
// We do NOT support force-push; callers asking for it need to drop to a terminal.
router.post('/:projectId/push', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const remote = String(req.body?.remote || 'origin').trim();
  const branch = req.body?.branch ? String(req.body.branch).trim() : undefined;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(remote)) return res.status(400).json({ error: 'invalid remote' });
  if (branch && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return res.status(400).json({ error: 'invalid branch' });
  try {
    const args = branch ? [remote, branch] : [remote];
    const result = await git.push(args);
    res.json({ ok: true, result });
  } catch (err) { sendGitError(res, err, 'git push failed'); }
});

router.post('/:projectId/pull', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.status(400).json({ error: 'not a git repo' });
  const remote = String(req.body?.remote || 'origin').trim();
  const branch = req.body?.branch ? String(req.body.branch).trim() : undefined;
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(remote)) return res.status(400).json({ error: 'invalid remote' });
  if (branch && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return res.status(400).json({ error: 'invalid branch' });
  try {
    const result = branch ? await git.pull(remote, branch) : await git.pull();
    res.json({ ok: true, result });
  } catch (err) { sendGitError(res, err, 'git pull failed'); }
});

// ── Show file at a ref (used by the diff viewer for "before" content) ──
router.get('/:projectId/show', async (req, res) => {
  if (!requireProject(req, res)) return;
  const { git } = gitFor(req);
  if (!(await isRepo(git))) return res.json({ repo: false, content: '' });
  const path = typeof req.query.path === 'string' ? req.query.path : '';
  const ref = typeof req.query.ref === 'string' && req.query.ref ? req.query.ref : 'HEAD';
  if (!path || path.includes('..') || path.startsWith('/')) return res.status(400).json({ error: 'invalid path' });
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref)) return res.status(400).json({ error: 'invalid ref' });
  try {
    const content = await git.show([`${ref}:${path}`]);
    res.json({ repo: true, content });
  } catch (err) {
    // File may be new (no HEAD version) — return empty content so the
    // diff viewer renders a clean "added file" side.
    if (/exists on disk, but not in|does not exist in|unknown revision|bad object/i.test(err?.message || '')) {
      return res.json({ repo: true, content: '' });
    }
    sendGitError(res, err, 'git show failed');
  }
});

export default router;
