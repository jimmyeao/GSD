/**
 * LÖVE runner — builds a dedicated container image that streams LÖVE games
 * to the browser over noVNC.
 *
 * Image: `gsd-love-runner:latest`, built from ./docker/love-runner.
 * Container: bind-mounts the user's workspace at /workspace and exposes
 * the noVNC port. The backend proxies browser → container.
 */

import Docker from 'dockerode';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import {
  buildImage,
  stopContainer,
  removeContainer,
  inspectContainer,
  getPortMappings,
} from './containerService.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE_CONTEXT = join(__dirname, '..', '..', 'docker', 'love-runner');

export const LOVE_IMAGE_TAG = 'gsd-love-runner:latest';
const INTERNAL_NOVNC_PORT = 6080;
// Must match the network name in containerService.js — the preview proxy's
// inspectContainer() reads the container's IP from this network.
const GSD_NETWORK = 'gsd-net';

async function ensureNetwork() {
  try { await docker.getNetwork(GSD_NETWORK).inspect(); }
  catch { await docker.createNetwork({ Name: GSD_NETWORK, Driver: 'bridge' }); }
}

/** True if the love-runner image is already built locally. */
export async function loveImageExists() {
  try { await docker.getImage(LOVE_IMAGE_TAG).inspect(); return true; }
  catch { return false; }
}

/**
 * Build the love-runner image. First run pulls Ubuntu base + apt packages,
 * so expect ~60 s on arm64 with decent bandwidth. Subsequent rebuilds are
 * near-instant due to layer caching.
 *
 * @param {(event: {stream?: string, error?: string}) => void} onProgress
 */
export async function buildLoveImage(onProgress = () => {}) {
  return buildImage(DOCKERFILE_CONTEXT, LOVE_IMAGE_TAG, onProgress);
}

/**
 * Start a LÖVE-runner container for the given workspace. Returns the
 * Docker container ID and the host port websockify is listening on.
 *
 * @param {string} workspacePath - absolute path to the project
 * @param {string} name - friendly container name (e.g. "love-u2-p5")
 * @returns {Promise<{dockerId: string, hostPort: number}>}
 */
export async function startLoveContainer(workspacePath, name) {
  // Sanity: the image must already exist locally. We build it explicitly
  // via buildLoveImage() before calling this — never fall back to `docker
  // pull` (there's no remote registry for gsd-love-runner).
  if (!(await loveImageExists())) {
    throw new Error(`Image ${LOVE_IMAGE_TAG} not found locally — build failed?`);
  }
  await ensureNetwork();

  const bindMount = `${workspacePath}:/workspace`;
  const container = await docker.createContainer({
    Image: LOVE_IMAGE_TAG,
    name,
    Hostname: name,
    // DON'T override Cmd — we want the image's default CMD (start.sh) to run.
    Labels: { 'gsd.managed': 'true', 'gsd.love': 'true' },
    ExposedPorts: { [`${INTERNAL_NOVNC_PORT}/tcp`]: {} },
    HostConfig: {
      Binds: [bindMount],
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 2 * 1e9,
      AutoRemove: false,
      // Attach to the shared GSD network so the preview proxy can find the
      // container's IP via inspectContainer(). Without this the proxy would
      // see an empty IP and fail with ENOTFOUND.
      NetworkMode: GSD_NETWORK,
      PortBindings: { [`${INTERNAL_NOVNC_PORT}/tcp`]: [{ HostPort: '' }] },
    },
  });
  await container.start();

  // Grab the randomly-assigned host port from the port map.
  const info = await container.inspect();
  const binding = info.NetworkSettings?.Ports?.[`${INTERNAL_NOVNC_PORT}/tcp`]?.[0];
  const hostPort = binding ? parseInt(binding.HostPort, 10) : null;
  if (!hostPort) throw new Error('love container started but no port mapping found');

  // Wait for websockify to actually listen before returning — otherwise the
  // first iframe load races ahead and the preview proxy hits ECONNREFUSED.
  // Typically ready within 500ms of container start; cap at 15s.
  const ip = info.NetworkSettings?.Networks?.[GSD_NETWORK]?.IPAddress;
  if (ip) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ready = await new Promise((resolve) => {
        const req = httpRequest({ host: ip, port: INTERNAL_NOVNC_PORT, path: '/', method: 'HEAD', timeout: 1000 }, (r) => {
          r.resume();
          resolve(r.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
      if (ready) break;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  return { dockerId: container.id, hostPort };
}

/** Stop + remove a LÖVE container. Safe to call on already-stopped ones. */
export async function stopLoveContainer(dockerId) {
  try { await stopContainer(dockerId); } catch { /* already stopped */ }
  try { await removeContainer(dockerId); } catch { /* already removed */ }
}

/** Inspect a LÖVE container. Returns null if gone. */
export async function getLoveContainerStatus(dockerId) {
  try {
    const info = await inspectContainer(dockerId);
    const ports = await getPortMappings(dockerId);
    const novnc = ports.find(p => p.container === INTERNAL_NOVNC_PORT);
    return { ...info, hostPort: novnc?.host ?? null };
  } catch { return null; }
}
