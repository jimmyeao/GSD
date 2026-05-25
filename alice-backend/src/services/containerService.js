import Docker from 'dockerode';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const ALICE_NETWORK = 'alice-net';

/** Ensure the shared Alice bridge network exists. */
async function ensureNetwork() {
  try {
    await docker.getNetwork(ALICE_NETWORK).inspect();
  } catch {
    await docker.createNetwork({ Name: ALICE_NETWORK, Driver: 'bridge' });
  }
}

/** Pull an image if it doesn't exist locally. */
async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
  } catch {
    console.log(`[docker] Pulling image ${image}...`);
    const stream = await docker.pull(image);
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
    });
    console.log(`[docker] Pulled ${image}`);
  }
}

/**
 * Build a Docker image from a Dockerfile in the workspace.
 * @param {string} contextPath - absolute path to build context (workspace dir)
 * @param {string} tag - image tag (e.g. 'alice-user-2-proj-1:latest')
 * @param {function} onProgress - callback({stream: string}) for build log lines
 * @returns {Promise<string>} image ID
 */
export async function buildImage(contextPath, tag, onProgress = () => {}) {
  const stream = await docker.buildImage(
    { context: contextPath, src: ['.'] },
    { t: tag, nocache: false, labels: { 'alice.managed': 'true' } }
  );

  return new Promise((resolve, reject) => {
    // Build steps can fail without the transport throwing — Docker emits
    // them as {error, errorDetail} events. Capture the first and reject
    // at the end so callers don't get a silent success on a broken build.
    let buildError = null;
    docker.modem.followProgress(stream, (err, output) => {
      if (err) return reject(err);
      if (buildError) return reject(new Error(buildError));
      const aux = output.find(o => o.aux?.ID);
      resolve(aux?.aux?.ID || tag);
    }, (event) => {
      if (event.stream) onProgress({ stream: event.stream });
      if (event.error && !buildError) {
        buildError = String(event.error).slice(0, 300);
        onProgress({ error: event.error });
      }
    });
  });
}

/**
 * List Alice-managed Docker images.
 * @returns {Promise<Array<{id, tags, size, created}>>}
 */
export async function listImages() {
  const images = await docker.listImages({ filters: { label: ['alice.managed=true'] } });
  return images.map(i => ({ id: i.Id, tags: i.RepoTags, size: i.Size, created: i.Created }));
}

/**
 * Create a new container for a project workspace.
 * @param {string} image - Docker image name (e.g. 'node:20-slim')
 * @param {string} workspacePath - Absolute host path to bind-mount
 * @param {object} opts - { memoryLimit, cpus, name, env, exposedPorts }
 * @returns {Promise<string>} Docker container ID
 */
export async function createContainer(image, workspacePath, opts = {}) {
  const {
    memoryLimit = 512 * 1024 * 1024,
    cpus = 1,
    name,
    env,
    exposedPorts,
  } = opts;

  await ensureImage(image);
  await ensureNetwork();

  // Build ExposedPorts and PortBindings from the exposedPorts array
  const exposed = {};
  const portBindings = {};
  if (Array.isArray(exposedPorts)) {
    for (const p of exposedPorts) {
      const key = `${p}/tcp`;
      exposed[key] = {};
      portBindings[key] = [{ HostPort: '' }]; // random host port
    }
  }

  const container = await docker.createContainer({
    Image: image,
    name,
    Hostname: name || undefined,
    WorkingDir: '/workspace',
    Cmd: ['sleep', 'infinity'],
    Env: env || [],
    ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
    Labels: { 'alice.managed': 'true' },
    HostConfig: {
      Binds: [`${workspacePath}:/workspace`],
      Memory: memoryLimit,
      NanoCpus: cpus * 1e9,
      AutoRemove: false,
      NetworkMode: ALICE_NETWORK,
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
    },
  });

  return container.id;
}

/**
 * Start a container by Docker ID.
 */
export async function startContainer(dockerId) {
  const container = docker.getContainer(dockerId);
  await container.start();
}

/**
 * Stop a container by Docker ID (10s grace period).
 */
export async function stopContainer(dockerId) {
  const container = docker.getContainer(dockerId);
  await container.stop({ t: 10 });
}

/**
 * Remove a container by Docker ID (force).
 */
export async function removeContainer(dockerId) {
  const container = docker.getContainer(dockerId);
  await container.remove({ force: true });
}

/**
 * Get container inspect info.
 * @returns {Promise<{status: string, running: boolean, ip: string}>}
 */
export async function inspectContainer(dockerId) {
  const container = docker.getContainer(dockerId);
  const info = await container.inspect();
  const ip = info.NetworkSettings?.Networks?.[ALICE_NETWORK]?.IPAddress || '';
  return {
    status: info.State.Status,
    running: info.State.Running,
    ip,
    name: info.Name?.replace(/^\//, '') || '',
  };
}

/**
 * Get port mappings for a container.
 * @returns {Promise<Array<{container, host, protocol}>>}
 */
export async function getPortMappings(dockerId) {
  const container = docker.getContainer(dockerId);
  const info = await container.inspect();
  const networkPorts = info.NetworkSettings?.Ports || {};
  const ports = [];
  for (const [key, bindings] of Object.entries(networkPorts)) {
    const [port, protocol] = key.split('/');
    if (bindings && bindings.length) {
      for (const b of bindings) {
        ports.push({ container: parseInt(port), host: parseInt(b.HostPort), protocol });
      }
    }
  }
  return ports;
}

/**
 * Stream container logs. Returns a readable stream.
 */
export async function streamLogs(dockerId, opts = {}) {
  const { follow = true, tail = 100 } = opts;
  const container = docker.getContainer(dockerId);
  return container.logs({ follow, stdout: true, stderr: true, tail });
}

/**
 * Execute a command in a running container.
 */
export async function execInContainer(dockerId, cmd) {
  const container = docker.getContainer(dockerId);

  const exec = await container.exec({
    Cmd: ['sh', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  const output = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });

  const inspection = await exec.inspect();

  return {
    exitCode: inspection.ExitCode,
    output,
  };
}
