import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import * as containerService from '../services/containerService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = join(__dirname, '..', '..', 'data', 'workspaces');
const MAX_CONTAINERS_PER_USER = 3;

const router = Router();
router.use(expressAuth);

// ── Create container ───────────────────────────────────────────────

router.post('/', async (req, res) => {
  try {
    const { projectId, image, ports } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const project = stmts.getProject.get(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Clean up any stale containers (docker_id is null = failed creation)
    stmts.cleanStaleContainers?.run?.(req.user.id);

    // Enforce per-user container limit
    const { count } = stmts.countUserContainers.get(req.user.id);
    if (count >= MAX_CONTAINERS_PER_USER) {
      return res.status(429).json({ error: `Maximum ${MAX_CONTAINERS_PER_USER} active containers per user` });
    }

    const containerImage = image || 'node:20-slim';
    const workspacePath = join(WORKSPACES_ROOT, String(req.user.id), String(projectId));
    mkdirSync(workspacePath, { recursive: true });

    const containerName = `gsd-${req.user.id}-${projectId}-${Date.now()}`;

    // Read project env vars and convert to Docker format
    const envVars = JSON.parse(project.env_vars || '{}');
    const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

    // Default expose common dev ports if none specified
    const exposedPorts = Array.isArray(ports) && ports.length ? ports : [3000, 3001, 5000, 5173, 8000, 8080];

    // Create Docker container first, only save to DB if it succeeds
    const dockerId = await containerService.createContainer(containerImage, workspacePath, { name: containerName, env, exposedPorts });
    const result = stmts.insertContainer.run(projectId, req.user.id, containerImage);
    const containerId = result.lastInsertRowid;
    stmts.updateContainerStatus.run('created', dockerId, containerId);

    const container = stmts.getContainer.get(containerId, req.user.id);
    res.status(201).json({ container: { ...container, name: containerName } });
  } catch (err) {
    console.error('[sandbox] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start container ────────────────────────────────────────────────

router.post('/:id/start', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    await containerService.startContainer(container.docker_id);
    stmts.updateContainerStatus.run('running', container.docker_id, container.id);

    res.json({ status: 'running' });
  } catch (err) {
    console.error('[sandbox] start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stop container ─────────────────────────────────────────────────

router.post('/:id/stop', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    await containerService.stopContainer(container.docker_id);
    stmts.updateContainerStatus.run('stopped', container.docker_id, container.id);

    res.json({ status: 'stopped' });
  } catch (err) {
    console.error('[sandbox] stop error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Container status ───────────────────────────────────────────────

router.get('/:id/status', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    const info = await containerService.inspectContainer(container.docker_id);
    res.json({ id: container.id, dockerId: container.docker_id, image: container.image, ...info });
  } catch (err) {
    console.error('[sandbox] status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Build image ───────────────────────────────────────────────────

router.post('/build', async (req, res) => {
  try {
    const { projectId, tag } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const project = stmts.getProject.get(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const workspacePath = join(WORKSPACES_ROOT, String(req.user.id), String(projectId));
    const imageTag = tag || `gsd-${req.user.id}-${projectId}:latest`;

    const imageId = await containerService.buildImage(workspacePath, imageTag);
    res.json({ tag: imageTag, imageId });
  } catch (err) {
    console.error('[sandbox] build error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Container ports ───────────────────────────────────────────────

router.get('/:id/ports', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    const ports = await containerService.getPortMappings(container.docker_id);
    res.json({ ports });
  } catch (err) {
    console.error('[sandbox] ports error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Execute command ────────────────────────────────────────────────

router.post('/:id/exec', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    const { cmd } = req.body || {};
    if (!cmd) return res.status(400).json({ error: 'cmd is required' });

    const result = await containerService.execInContainer(container.docker_id, cmd);
    res.json(result);
  } catch (err) {
    console.error('[sandbox] exec error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Remove container ───────────────────────────────────────────────

router.delete('/:id', async (req, res) => {
  try {
    const container = stmts.getContainer.get(req.params.id, req.user.id);
    if (!container) return res.status(404).json({ error: 'Container not found' });

    await containerService.removeContainer(container.docker_id);
    stmts.updateContainerStatus.run('removed', container.docker_id, container.id);

    res.json({ deleted: true });
  } catch (err) {
    console.error('[sandbox] remove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Docker Compose ────────────────────────────────────────────────

import { findComposeFile, composeUp, composeDown, composePs } from '../services/composeService.js';

router.post('/compose/up', async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const project = stmts.getProject.get(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const workspacePath = join(WORKSPACES_ROOT, String(req.user.id), String(projectId));
    const composeFile = findComposeFile(workspacePath);
    if (!composeFile) {
      return res.status(400).json({ error: 'No docker-compose.yml found in project. Create one first.' });
    }

    const projectName = `gsd-${req.user.id}-${projectId}`;
    const envVars = JSON.parse(project.env_vars || '{}');

    // Run compose up (non-streaming — for streaming use socket event)
    const result = await composeUp(workspacePath, projectName, { env: envVars });
    res.json({ ok: true, exitCode: result.code, projectName });
  } catch (err) {
    console.error('[compose] up error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compose/down', async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const project = stmts.getProject.get(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const workspacePath = join(WORKSPACES_ROOT, String(req.user.id), String(projectId));
    const projectName = `gsd-${req.user.id}-${projectId}`;

    await composeDown(workspacePath, projectName);
    res.json({ ok: true });
  } catch (err) {
    console.error('[compose] down error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compose/status', async (req, res) => {
  try {
    const projectId = req.query.projectId;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const project = stmts.getProject.get(projectId, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const workspacePath = join(WORKSPACES_ROOT, String(req.user.id), String(projectId));
    const projectName = `gsd-${req.user.id}-${projectId}`;

    const services = await composePs(workspacePath, projectName);
    res.json({ services, projectName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
