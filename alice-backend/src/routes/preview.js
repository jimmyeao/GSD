/**
 * Per-container HTTP + WebSocket proxy.
 *
 * Exposes:
 *   - `router` — Express router that proxies HTTP requests
 *       /preview/:containerId/<path>?port=<N>   (port defaults to 6080 for
 *       love-runner images, else 3000)
 *   - `handleUpgrade(req, socket, head)` — call from the server's 'upgrade'
 *       event listener to proxy WebSocket upgrades on the same URL shape.
 *
 * The proxy picks the port based on the container's image so LÖVE runs land
 * on noVNC (6080) without the caller needing to know.
 */

import { Router } from 'express';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import { inspectContainer } from '../services/containerService.js';
import httpProxy from 'http-proxy';

const router = Router();
router.use(expressAuth);

const proxy = httpProxy.createProxyServer({
  // No fixed target — we set it per-request from the container's IP+port.
  changeOrigin: true,
  ws: true,
  xfwd: false,
});

proxy.on('error', (err, req, res) => {
  console.warn('[preview-proxy] error:', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Proxy error: ${err.message}` })); }
    catch { /* ignore */ }
  }
});

/** Given a container DB row, return { ip, port, extraHeaders } to proxy to. */
async function resolveTarget(row, queryPort) {
  const info = await inspectContainer(row.docker_id);
  if (!info.running) throw Object.assign(new Error('Container not running'), { status: 503 });
  // Default port by image: love-runner → 6080 (KasmVNC), else 3000.
  let port;
  if (queryPort) port = parseInt(queryPort, 10);
  else if (row.image === 'alice-love-runner:latest') port = 6080;
  else port = 3000;

  // KasmVNC requires HTTP Basic Auth on its web client. The credentials
  // are baked into the image (kasm/alicelove) and meaningless outside the
  // container. Rather than showing the browser a second auth prompt (the
  // user already authenticated into Alice), inject the header server-side.
  const extraHeaders = {};
  if (row.image === 'alice-love-runner:latest') {
    extraHeaders.Authorization = 'Basic ' + Buffer.from('kasm:alicelove').toString('base64');
  }
  return { ip: info.ip, port, extraHeaders };
}

// Parse "/preview/<id>/..." out of an HTTP path. Returns { containerId, rest }.
function parsePath(url) {
  // url already has the leading "/preview" stripped by express when mounted,
  // but for the upgrade handler (pre-router) we receive the full path.
  const m = String(url || '').match(/^\/?(?:api\/)?(?:preview\/)?(\d+)(\/.*)?$/);
  if (!m) return null;
  return { containerId: m[1], rest: m[2] || '/' };
}

// ── HTTP proxy (mounted at /preview) ──────────────────────────────
router.all('/:containerId', (req, res) => res.redirect(`${req.originalUrl}/`));

router.all('/:containerId/*', async (req, res) => {
  try {
    const row = stmts.getContainer.get(req.params.containerId, req.user.id);
    if (!row) return res.status(404).json({ error: 'Container not found' });
    const { ip, port, extraHeaders } = await resolveTarget(row, req.query.port);
    // Rewrite request URL to strip the /preview/:id/ prefix — the upstream
    // (e.g. websockify on the novnc package) expects plain paths like
    // /vnc.html or /core/rfb.js.
    const stripped = '/' + (req.params[0] || '');
    const query = req._parsedUrl?.search || '';
    req.url = stripped + query;
    // Set authorization on req.headers directly (lowercase, the form Node
    // uses internally). http-proxy's `options.headers` route extends on top
    // of req.headers but is case-sensitive, so a casing collision with any
    // existing `authorization` from the browser silently drops our header.
    if (extraHeaders?.Authorization) req.headers.authorization = extraHeaders.Authorization;
    proxy.web(req, res, { target: `http://${ip}:${port}`, ignorePath: false });
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
});

// ── WebSocket upgrade handler ─────────────────────────────────────
// Called from server.js on httpServer.on('upgrade', ...). The cookie-based
// auth middleware doesn't run here; we validate the session manually.
export function handleUpgrade(req, socket, head, authFn) {
  (async () => {
    try {
      const parsed = parsePath(req.url);
      if (!parsed) return socket.destroy();
      const user = await authFn(req).catch(() => null);
      if (!user) return socket.destroy();
      const row = stmts.getContainer.get(parsed.containerId, user.id);
      if (!row) return socket.destroy();
      const { ip, port, extraHeaders } = await resolveTarget(row, null);
      // Strip /preview/<id> prefix so upstream sees e.g. "/websockify".
      req.url = parsed.rest;
      // Inject auth directly on req.headers — see HTTP route above for why
      // options.headers is unreliable here.
      if (extraHeaders?.Authorization) req.headers.authorization = extraHeaders.Authorization;
      proxy.ws(req, socket, head, { target: `http://${ip}:${port}` });
    } catch (err) {
      console.warn('[preview-proxy upgrade] error:', err.message);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  })();
}

export default router;
