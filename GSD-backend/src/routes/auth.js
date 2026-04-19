import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { stmts } from '../db.js';
import {
  expressAuth,
  issueSession,
  clearSession,
  ensureCsrfCookie,
  checkAllowlist,
  COOKIES,
} from '../auth.js';
import * as microsoft from '../oauth/microsoft.js';
import * as google from '../oauth/google.js';

const router = Router();

const STATE_COOKIE = 'gsd_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function stateCookieOptions() {
  const opts = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: STATE_TTL_MS,
    signed: true,
  };
  if (config.cookieDomain) opts.domain = config.cookieDomain;
  return opts;
}

function clearStateCookieOptions() {
  const opts = {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    signed: true,
  };
  if (config.cookieDomain) opts.domain = config.cookieDomain;
  return opts;
}

function redirectWithError(res, code) {
  const base = (config.publicUrl || '/').replace(/\/+$/, '');
  res.redirect(`${base}/?error=${encodeURIComponent(code)}`);
}

function redirectHome(res) {
  const base = (config.publicUrl || '/').replace(/\/+$/, '');
  res.redirect(`${base}/`);
}

/**
 * Find or create a user for the verified OAuth identity, enforcing the
 * allowlist gate. Returns the user row (hydrated) or null if rejected.
 */
function findOrCreateOAuthUser({ provider, subject, email, displayName }) {
  // 1) Allowlist gate — applied to every login, not just first time.
  const gate = checkAllowlist(email);
  if (!gate.allowed) return null;
  const allowlistRole = gate.role || 'user';

  // 2) Exact provider/subject match — returning user.
  const byProvider = stmts.getUserByProvider.get(provider, subject);
  if (byProvider) {
    if (byProvider.role !== allowlistRole) {
      stmts.updateUserRole.run(allowlistRole, byProvider.id);
    }
    if (displayName && byProvider.display_name !== displayName) {
      stmts.updateUserProvider.run(provider, subject, displayName, byProvider.id);
    }
    return stmts.getUserById.get(byProvider.id);
  }

  // 3) Link an existing user with the same email (e.g. old username/password row).
  const byEmail = email ? stmts.getUserByEmail.get(email) : null;
  if (byEmail) {
    stmts.updateUserProvider.run(provider, subject, displayName || null, byEmail.id);
    if (!byEmail.email) stmts.updateUserEmail.run(email, byEmail.id);
    if (byEmail.role !== allowlistRole) stmts.updateUserRole.run(allowlistRole, byEmail.id);
    return stmts.getUserById.get(byEmail.id);
  }

  // 4) Create a new user. Username slot gets the email; password is empty.
  // Use email as the `username` column, but guard against UNIQUE collisions
  // by appending a random suffix if someone already has that username.
  let username = email;
  try {
    const existing = stmts.getUserByUsername.get(username);
    if (existing) {
      username = `${email}#${randomBytes(3).toString('hex')}`;
    }
  } catch { /* ok */ }

  try {
    const result = stmts.insertOAuthUser.run(
      username,
      email,
      displayName || null,
      allowlistRole,
      provider,
      subject,
    );
    return stmts.getUserById.get(result.lastInsertRowid);
  } catch (err) {
    console.warn('[auth] failed to create OAuth user:', err.message);
    return null;
  }
}

// ── Routes ──────────────────────────────────────────────────────────

/** Tell the frontend which providers are configured. */
router.get('/providers', (_req, res) => {
  res.json({
    microsoft: !!config.oauth.microsoft.clientId,
    google: !!config.oauth.google.clientId,
  });
});

/** Return the current CSRF token, creating one if missing. */
router.get('/csrf', (req, res) => {
  const csrf = ensureCsrfCookie(req, res);
  res.json({ csrf });
});

/** Return the authenticated user's profile. */
router.get('/me', expressAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    role: req.user.role,
    display_name: req.user.display_name,
    username: req.user.username,
  });
});

/** Logout — clear cookies. CSRF middleware validated the request. */
router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// ── Microsoft ───────────────────────────────────────────────────────

router.get('/microsoft/start', (_req, res) => {
  if (!config.oauth.microsoft.clientId) {
    return res.status(503).json({ error: 'Microsoft sign-in is not configured' });
  }
  const state = randomBytes(24).toString('base64url');
  res.cookie(STATE_COOKIE, state, stateCookieOptions());
  res.redirect(microsoft.authUrl(state));
});

router.get('/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.signedCookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, clearStateCookieOptions());

  if (!code || !state || !expected || state !== expected) {
    return redirectWithError(res, 'invalid_state');
  }

  try {
    const tokens = await microsoft.exchangeCode(code);
    if (!tokens.id_token) return redirectWithError(res, 'no_id_token');

    const claims = await microsoft.verifyIdToken(tokens.id_token);
    // Microsoft often omits email_verified; only reject if it's explicitly false.
    if (claims.email_verified === false) {
      return redirectWithError(res, 'email_unverified');
    }
    if (!claims.email) return redirectWithError(res, 'no_email');

    const user = findOrCreateOAuthUser({
      provider: 'microsoft',
      subject: claims.sub,
      email: claims.email,
      displayName: claims.name,
    });
    if (!user) {
      clearSession(res);
      return redirectWithError(res, 'not_authorized');
    }

    issueSession(res, user);
    return redirectHome(res);
  } catch (err) {
    console.warn('[auth] microsoft callback failed:', err.message);
    return redirectWithError(res, 'oauth_failed');
  }
});

// ── Google ──────────────────────────────────────────────────────────

router.get('/google/start', (_req, res) => {
  if (!config.oauth.google.clientId) {
    return res.status(503).json({ error: 'Google sign-in is not configured' });
  }
  const state = randomBytes(24).toString('base64url');
  res.cookie(STATE_COOKIE, state, stateCookieOptions());
  res.redirect(google.authUrl(state));
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.signedCookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, clearStateCookieOptions());

  if (!code || !state || !expected || state !== expected) {
    return redirectWithError(res, 'invalid_state');
  }

  try {
    const tokens = await google.exchangeCode(code);
    if (!tokens.id_token) return redirectWithError(res, 'no_id_token');

    const claims = await google.verifyIdToken(tokens.id_token);
    if (claims.email_verified === false) {
      return redirectWithError(res, 'email_unverified');
    }
    if (!claims.email) return redirectWithError(res, 'no_email');

    const user = findOrCreateOAuthUser({
      provider: 'google',
      subject: claims.sub,
      email: claims.email,
      displayName: claims.name,
    });
    if (!user) {
      clearSession(res);
      return redirectWithError(res, 'not_authorized');
    }

    issueSession(res, user);
    return redirectHome(res);
  } catch (err) {
    console.warn('[auth] google callback failed:', err.message);
    return redirectWithError(res, 'oauth_failed');
  }
});

export default router;

// Exported for tests / internal reuse.
export { COOKIES };
