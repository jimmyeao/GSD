/**
 * HyperFrames Studio (the browser editor) for explainer projects, exposed at
 * its own origin — STUDIO_PUBLIC_URL (https://studio.alice.deviousweb.com),
 * routed by the edge proxy to STUDIO_PORT (5010) on this box.
 *
 * Why a separate origin: Studio is a single-page app that calls its own
 * API at root-absolute /api/… — it can't live under Alice's /api prefix.
 *
 * Security model (Studio can edit project files and start renders, so it
 * must never be reachable unauthenticated):
 *   1. Alice's chat handler mints a short-lived signed link
 *      (studioLink → /__alice/open?t=<jwt>, 10 min, single-use) for a
 *      project the logged-in user owns.
 *   2. This proxy verifies it, sets its own HttpOnly/Secure cookie scoped
 *      to that one project (8h), and redirects to "/".
 *   3. Every request is cookie-checked, then proxied to that project's
 *      Studio instance on 127.0.0.1 (started on demand, stopped when idle).
 * One project per browser at a time — opening another project's link
 * re-scopes the cookie.
 *
 * Studio streams live updates with Server-Sent Events (no WebSockets), so
 * responses carry X-Accel-Buffering: no for the NGINX in front.
 */

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import httpProxy from 'http-proxy';
import { config } from '../../config.js';
import { projectDir } from './pipeline.js';
import { HYPERFRAMES_CLI_ARGS, hyperframesEnv, NODE22 } from './hyperframesCli.js';

export const STUDIO_PORT = Number(process.env.STUDIO_PORT ?? 5010);
export const STUDIO_PUBLIC_URL = (process.env.STUDIO_PUBLIC_URL ?? 'https://studio.alice.deviousweb.com').replace(/\/$/, '');
const STUDIO_HOST = process.env.STUDIO_HOST ?? process.env.HOST ?? '127.0.0.1';
const INTERNAL_PORTS = [3470, 3471, 3472, 3473, 3474, 3475];
const IDLE_MS = 30 * 60_000;
const LINK_TTL = '10m';
const COOKIE = 'alice_studio';
const COOKIE_MAX_AGE_S = 8 * 3600;

const secret = () => {
  const s = config.sessionSecret || config.jwtSecret;
  if (!s) throw new Error('SESSION_SECRET/JWT_SECRET is required for Studio links');
  return `${s}:studio`; // distinct key space from Alice's own session JWTs
};

/** Signed one-time-ish link to open `projectId` in Studio for `userId`. */
export function studioLink(projectId, userId) {
  const t = jwt.sign({ p: projectId, u: userId, k: 'open', n: randomUUID() }, secret(), { expiresIn: LINK_TTL });
  return `${STUDIO_PUBLIC_URL}/__alice/open?t=${encodeURIComponent(t)}`;
}

// ── Studio instances ─────────────────────────────────────────────────────

const instances = new Map(); // projectId -> { port, proc, lastUsed, ready: Promise }
const usedLinks = new Map();  // link nonce -> expiry (ms) — links are single-use

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); Date.now() > deadline ? reject(new Error('Studio did not start')) : setTimeout(tryOnce, 500); });
    };
    tryOnce();
  });
}

function stopInstance(projectId) {
  const inst = instances.get(projectId);
  if (!inst) return;
  instances.delete(projectId);
  try { inst.proc.kill('SIGTERM'); } catch { /* already gone */ }
  console.log(`[studio] stopped ${projectId}`);
}

async function ensureInstance(projectId) {
  const existing = instances.get(projectId);
  if (existing) { existing.lastUsed = Date.now(); await existing.ready; return existing; }
  if (instances.size >= INTERNAL_PORTS.length) {
    // Evict the least recently used project.
    const [oldest] = [...instances.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    stopInstance(oldest);
  }
  const used = new Set([...instances.values()].map(i => i.port));
  let port;
  for (const p of INTERNAL_PORTS) if (!used.has(p) && await portFree(p)) { port = p; break; }
  if (!port) throw new Error('no free Studio port');

  const dir = projectDir(projectId);
  const proc = spawn(NODE22, [...HYPERFRAMES_CLI_ARGS, 'preview', '--no-open', '--foreground', '--force-new', '--port', String(port)], { cwd: dir, env: hyperframesEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => { const l = d.toString().trim(); if (/error/i.test(l)) console.warn(`[studio ${projectId}] ${l.slice(0, 300)}`); });
  proc.on('exit', () => { if (instances.get(projectId)?.proc === proc) instances.delete(projectId); });
  const inst = { port, proc, lastUsed: Date.now(), ready: waitForPort(port) };
  instances.set(projectId, inst);
  console.log(`[studio] starting ${projectId} on 127.0.0.1:${port}`);
  try { await inst.ready; } catch (err) { stopInstance(projectId); throw err; }
  return inst;
}

setInterval(() => {
  for (const [id, inst] of instances) if (Date.now() - inst.lastUsed > IDLE_MS) stopInstance(id);
}, 60_000).unref();
process.on('exit', () => { for (const inst of instances.values()) try { inst.proc.kill('SIGTERM'); } catch { /* ignore */ } });

// ── Auth + proxy server ─────────────────────────────────────────────────

function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  if (!m) return null;
  try { return jwt.verify(decodeURIComponent(m[1]), secret()); } catch { return null; }
}

function deny(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><title>Alice Studio</title><body style="font-family:sans-serif;padding:3em;background:#111;color:#ddd"><h2>${msg}</h2><p>Open the video from its Alice conversation and use the <b>Open in Studio</b> link.</p></body>`);
}

/**
 * @param {(userId:number, projectId:string)=>boolean} canAccess  ownership check
 */
export function startStudioProxy(canAccess) {
  const proxy = httpProxy.createProxyServer({ ws: false, xfwd: false, proxyTimeout: 0, timeout: 0 });
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    proxyRes.headers['x-accel-buffering'] = 'no'; // keep SSE live through NGINX
    delete proxyRes.headers['access-control-allow-origin'];
    // Node only sends headers with the first body chunk; an idle SSE stream
    // has none, so the browser's EventSource would hang. http-proxy sets the
    // headers right after this event — flush them on the next tick.
    if (/text\/event-stream/i.test(proxyRes.headers['content-type'] ?? '')) setImmediate(() => { try { res.flushHeaders(); } catch { /* closed */ } });
  });
  proxy.on('error', (err, _req, res) => {
    if (res && !res.headersSent) deny(res, 502, `Studio is not responding (${err.message})`);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://studio.local');
      if (url.pathname === '/__alice/open') {
        let claims;
        try { claims = jwt.verify(url.searchParams.get('t') ?? '', secret()); } catch { return deny(res, 401, 'This Studio link has expired'); }
        if (claims.k !== 'open' || !canAccess(claims.u, claims.p)) return deny(res, 403, 'Not your project');
        if (!claims.n || usedLinks.has(claims.n)) return deny(res, 401, 'This Studio link has already been used');
        usedLinks.set(claims.n, claims.exp * 1000);
        for (const [n, exp] of usedLinks) if (exp < Date.now()) usedLinks.delete(n);
        const session = jwt.sign({ p: claims.p, u: claims.u, k: 'session' }, secret(), { expiresIn: COOKIE_MAX_AGE_S });
        res.writeHead(302, {
          'Set-Cookie': `${COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`,
          Location: '/', 'Cache-Control': 'no-store',
        });
        return res.end();
      }
      const claims = readCookie(req);
      if (!claims || claims.k !== 'session' || !canAccess(claims.u, claims.p)) return deny(res, 401, 'Please open Studio from Alice');
      const inst = await ensureInstance(claims.p);
      inst.lastUsed = Date.now();
      delete req.headers.cookie; // Studio has no use for Alice's cookies
      proxy.web(req, res, { target: `http://127.0.0.1:${inst.port}` });
    } catch (err) {
      console.error('[studio] proxy error:', err.message);
      if (!res.headersSent) deny(res, 500, `Studio error: ${err.message}`);
    }
  });
  server.listen(STUDIO_PORT, STUDIO_HOST, () => console.log(`[studio] proxy on http://${STUDIO_HOST}:${STUDIO_PORT} → ${STUDIO_PUBLIC_URL}`));
  return server;
}
