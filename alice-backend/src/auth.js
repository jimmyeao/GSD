import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { stmts } from './db.js';

const TOKEN_EXPIRY = '7d';
const SESSION_COOKIE = 'alice_session';
const CSRF_COOKIE = 'alice_csrf';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Resolve session secret ──────────────────────────────────────────
// Prefer SESSION_SECRET, fall back to JWT_SECRET for backwards compat.
let sessionSecret = config.sessionSecret || config.jwtSecret;
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET (and JWT_SECRET) not set — using random secret. Sessions will not survive server restart.');
}

// ── Cookie helpers ──────────────────────────────────────────────────

function baseCookieOptions() {
  const opts = {
    path: '/',
    secure: true,
    sameSite: 'lax',
  };
  if (config.cookieDomain) opts.domain = config.cookieDomain;
  return opts;
}

function sessionCookieOptions() {
  return {
    ...baseCookieOptions(),
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function csrfCookieOptions() {
  return {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge: SESSION_MAX_AGE_MS,
  };
}

function clearCookieOptions() {
  // Must mirror the attributes used to set the cookie so browsers actually clear it.
  return baseCookieOptions();
}

// ── JWT helpers ─────────────────────────────────────────────────────

export function signSession(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    sessionSecret,
    { expiresIn: TOKEN_EXPIRY },
  );
}

export function verifySession(token) {
  return jwt.verify(token, sessionSecret);
}

// Legacy name kept for any remaining imports — verifies a session JWT.
export function verifyToken(token) {
  return verifySession(token);
}

// ── Session lifecycle ───────────────────────────────────────────────

/** Sign a session JWT and set both session + CSRF cookies. */
export function issueSession(res, user) {
  const token = signSession(user);
  const csrf = randomBytes(32).toString('base64url');
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  res.cookie(CSRF_COOKIE, csrf, csrfCookieOptions());
  return { token, csrf };
}

/** Clear both cookies. */
export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, clearCookieOptions());
  res.clearCookie(CSRF_COOKIE, clearCookieOptions());
}

/** Ensure a CSRF cookie exists, returning the current value. */
export function ensureCsrfCookie(req, res) {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing) return existing;
  const csrf = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, csrf, csrfCookieOptions());
  return csrf;
}

// ── Cookie parsing for Socket.IO (no cookie-parser there) ───────────

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// ── User hydration ──────────────────────────────────────────────────

/**
 * Build the req.user / socket.user shape that downstream code expects.
 * Keeps `id` + `username` (for compat) and adds `email`, `role`, `display_name`.
 */
function hydrateUser(payload) {
  const row = stmts.getUserById.get(payload.sub);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || payload.email || null,
    role: row.role || payload.role || 'user',
    display_name: row.display_name || null,
  };
}

// ── Express middleware ──────────────────────────────────────────────

/**
 * Verify the session cookie and attach req.user.
 * Responds 401 if the cookie is missing or invalid.
 */
export function expressAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = verifySession(token);
    const user = hydrateUser(payload);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/** 403 if the authenticated user is not an admin. Must run after expressAuth. */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  next();
}

/**
 * Double-submit-cookie CSRF protection. Mutating methods require the client
 * to echo the alice_csrf cookie in an X-CSRF-Token header.
 */
export function csrfProtect(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }
  const header = req.get('X-CSRF-Token') || req.get('x-csrf-token');
  const cookie = req.cookies?.[CSRF_COOKIE];
  if (!header || !cookie || header !== cookie) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }
  next();
}

// ── Socket.IO middleware ────────────────────────────────────────────

/**
 * Verify the session cookie from the handshake and attach socket.user.
 * Uses the same cookie contract as the Express middleware.
 */
export function socketAuth(socket, next) {
  try {
    const cookies = parseCookieHeader(socket.handshake?.headers?.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return next(new Error('Authentication required'));
    const payload = verifySession(token);
    const user = hydrateUser(payload);
    if (!user) return next(new Error('User no longer exists'));
    socket.user = user;
    next();
  } catch {
    return next(new Error('Invalid or expired session'));
  }
}

/**
 * Resolve a user from a raw Node request (cookie header only). Returns the
 * hydrated user or null. Used by the server's `upgrade` event handler —
 * WebSocket upgrades don't go through Express middleware so we auth manually.
 */
export function userFromRequest(req) {
  try {
    const cookies = parseCookieHeader(req.headers?.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    const payload = verifySession(token);
    return hydrateUser(payload) || null;
  } catch { return null; }
}

// ── Allowlist check ─────────────────────────────────────────────────

/**
 * Decide whether the given email is allowed to sign in, and with what role.
 * Exact matches (is_domain=0) take precedence over domain matches.
 * Returns `{ allowed: boolean, role: 'user'|'admin' }`.
 */
export function checkAllowlist(email) {
  if (!email || typeof email !== 'string') {
    return { allowed: false, role: 'user' };
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) {
    return { allowed: false, role: 'user' };
  }

  // Exact match wins (role from that row).
  const exact = stmts.findAllowedExact.get(normalized);
  if (exact) return { allowed: true, role: exact.role || 'user' };

  // Domain match: compare `@<domain>` against rows with is_domain=1.
  const domain = '@' + normalized.split('@').pop();
  const rows = stmts.findAllowedDomainAll.all();
  for (const row of rows) {
    if ((row.email || '').toLowerCase() === domain) {
      return { allowed: true, role: row.role || 'user' };
    }
  }
  return { allowed: false, role: 'user' };
}

// Export cookie names so other modules can reference them if needed.
export const COOKIES = {
  session: SESSION_COOKIE,
  csrf: CSRF_COOKIE,
};
