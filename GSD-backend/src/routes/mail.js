/**
 * Mail + calendar routes (Phase 2 — read-only).
 *
 * Routes mount under /mail (see server.js). Behind NGINX all client calls
 * go to /api/mail/* — NGINX strips the /api prefix before proxying.
 *
 * All routes require expressAuth. Mutating methods are CSRF-checked by the
 * global middleware. OAuth GET callbacks are allowed through (safe methods).
 */

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { stmts } from '../db.js';
import { expressAuth } from '../auth.js';
import {
  buildAuthUrl,
  exchangeCode,
  extractEmailFromIdToken,
} from '../mail/oauth.js';
import { encryptToken } from '../mail/tokens.js';
import { withAccount, getProviderAdapter } from '../mail/client.js';

const router = Router();

const STATE_COOKIE = 'gsd_mail_state';
const STATE_TTL_MS = 10 * 60 * 1000;

const VALID_PROVIDERS = new Set(['microsoft', 'google']);
const VALID_FOLDERS = new Set(['inbox', 'sent', 'drafts', 'trash']);

// ── Helpers ────────────────────────────────────────────────────────

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

function mailRedirectUri(provider) {
  const base = (config.publicUrl || '').replace(/\/+$/, '');
  // NGINX strips /api — the actual backend path is /mail/<provider>/callback
  return `${base}/api/mail/${provider}/callback`;
}

function redirectSuccess(res, provider) {
  const base = (config.publicUrl || '/').replace(/\/+$/, '');
  res.redirect(`${base}/?mail_connected=${encodeURIComponent(provider)}`);
}

function redirectFail(res, slug) {
  const base = (config.publicUrl || '/').replace(/\/+$/, '');
  res.redirect(`${base}/?mail_error=${encodeURIComponent(slug)}`);
}

function friendlyError(err, res) {
  if (err?.code === 'NOT_FOUND') return res.status(404).json({ error: 'Mail account not found' });
  if (err?.code === 'NEEDS_RECONNECT') return res.status(401).json({ error: 'needs_reconnect' });
  console.warn('[mail] error:', err?.message || err);
  return res.status(502).json({ error: err?.message || 'Upstream error' });
}

// ── Rate limiting (in-memory token bucket per user) ────────────────

const RATE_LIMIT = 30;        // requests
const RATE_WINDOW_MS = 60_000; // per minute
const _buckets = new Map();    // userId -> { tokens, updated }

function rateLimit(req, res, next) {
  const userId = req.user?.id;
  if (!userId) return next();
  const now = Date.now();
  let b = _buckets.get(userId);
  if (!b) {
    b = { tokens: RATE_LIMIT, updated: now };
    _buckets.set(userId, b);
  }
  const elapsed = now - b.updated;
  const refill = (elapsed / RATE_WINDOW_MS) * RATE_LIMIT;
  b.tokens = Math.min(RATE_LIMIT, b.tokens + refill);
  b.updated = now;
  if (b.tokens < 1) {
    const retryAfter = Math.ceil((1 - b.tokens) / RATE_LIMIT * RATE_WINDOW_MS / 1000);
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  b.tokens -= 1;
  next();
}

// ── All routes require auth ─────────────────────────────────────────
router.use(expressAuth);

// ── Account management ─────────────────────────────────────────────

router.get('/accounts', (req, res) => {
  const accounts = stmts.listMailAccounts.all(req.user.id);
  res.json({ accounts });
});

router.get('/connect/:provider/start', (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'Invalid provider' });
  }
  if (provider === 'microsoft' && !config.oauth.microsoft.clientId) {
    return res.status(503).json({ error: 'Microsoft OAuth not configured' });
  }
  if (provider === 'google' && !config.oauth.google.clientId) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }

  // Bind state to the authenticated user so a stolen state from another session
  // can't be used to plant tokens on someone else's account.
  const state = `${req.user.id}.${randomBytes(24).toString('base64url')}`;
  res.cookie(STATE_COOKIE, state, stateCookieOptions());

  try {
    const url = buildAuthUrl(provider, state, mailRedirectUri(provider));
    res.redirect(url);
  } catch (err) {
    console.warn('[mail] connect start failed:', err.message);
    return res.status(500).json({ error: 'Failed to build auth URL' });
  }
});

router.get('/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.has(provider)) return redirectFail(res, 'invalid_provider');

  const { code, state } = req.query;
  const expected = req.signedCookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, clearStateCookieOptions());

  if (!code || !state || !expected || state !== expected) {
    return redirectFail(res, 'invalid_state');
  }

  // Bind to user: state was "<userId>.<rand>"
  const userIdFromState = parseInt(String(state).split('.')[0], 10);
  if (!userIdFromState || userIdFromState !== req.user.id) {
    return redirectFail(res, 'user_mismatch');
  }

  try {
    const tokens = await exchangeCode(provider, code, mailRedirectUri(provider));
    if (!tokens.access_token) return redirectFail(res, 'no_access_token');

    // Verify ID token and pull the trustworthy email
    let identity;
    try {
      identity = await extractEmailFromIdToken(provider, tokens.id_token);
    } catch (err) {
      console.warn('[mail] id_token verify failed:', err.message);
      return redirectFail(res, 'id_token_invalid');
    }

    const expiresAt = tokens.expires_in
      ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in)
      : null;
    const accessEnc = encryptToken(tokens.access_token);
    const refreshEnc = tokens.refresh_token ? encryptToken(tokens.refresh_token) : null;

    // Upsert semantics: if same (user_id, provider, email) exists, update tokens.
    const existing = stmts.findMailAccountByEmail.get(req.user.id, provider, identity.email);
    if (existing) {
      // If this connect didn't produce a refresh_token (e.g. Google reconnect
      // where the user already granted consent), keep the existing one.
      const refreshToStore = refreshEnc || existing.refresh_token_enc;
      stmts.updateMailAccountTokens.run(accessEnc, refreshToStore, expiresAt, existing.id);
    } else {
      stmts.insertMailAccount.run(
        req.user.id,
        provider,
        identity.email,
        identity.name || null,
        accessEnc,
        refreshEnc,
        expiresAt,
        provider === 'microsoft'
          ? 'Mail.ReadWrite Mail.Send Calendars.ReadWrite offline_access'
          : 'gmail.modify gmail.send calendar',
        identity.sub || null,
      );
    }

    return redirectSuccess(res, provider);
  } catch (err) {
    console.warn('[mail] callback failed:', err.message);
    return redirectFail(res, 'oauth_failed');
  }
});

router.delete('/accounts/:id', async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'Invalid id' });
  const account = stmts.getMailAccount.get(accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Not found' });

  // Best-effort provider-side revoke (do not block on it).
  try {
    if (account.provider === 'google' && account.refresh_token_enc) {
      // Lazy import so we don't pull crypto into this path for MS-only deletes.
      const { decryptToken } = await import('../mail/tokens.js');
      let refreshPlain = null;
      try { refreshPlain = decryptToken(account.refresh_token_enc); } catch { /* ignore */ }
      if (refreshPlain) {
        // Fire-and-forget with a tight timeout
        fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshPlain)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(3_000),
        }).catch(() => { /* ignore revoke errors */ });
      }
    }
    // Microsoft revokeSignInSessions needs User.ReadWrite.All which we don't request — skip.
  } catch { /* ignore */ }

  stmts.deleteMailAccount.run(accountId, req.user.id);
  return res.status(204).end();
});

// ── Mail / calendar reads ──────────────────────────────────────────

router.get('/accounts/:id/messages', rateLimit, async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'Invalid id' });

  const folder = String(req.query.folder || 'inbox').toLowerCase();
  if (!VALID_FOLDERS.has(folder)) return res.status(400).json({ error: 'Invalid folder' });

  const limitRaw = parseInt(String(req.query.limit ?? '25'), 10);
  const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 25));
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  try {
    const messages = await withAccount(accountId, req.user.id, async (provider, accessToken) => {
      const adapter = getProviderAdapter(provider);
      return adapter.listMessages(accessToken, { limit, folder, q });
    });
    res.json({ messages });
  } catch (err) {
    return friendlyError(err, res);
  }
});

router.get('/accounts/:id/messages/:msgId', rateLimit, async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'Invalid id' });
  const { msgId } = req.params;
  if (!msgId) return res.status(400).json({ error: 'msgId required' });

  try {
    const message = await withAccount(accountId, req.user.id, async (provider, accessToken) => {
      const adapter = getProviderAdapter(provider);
      return adapter.getMessage(accessToken, msgId);
    });
    // Log only the shape, not the body, when large — never the body content.
    const bodyLen = (message.body_html || '').length + (message.body_text || '').length;
    if (bodyLen > 2 * 1024 * 1024) {
      console.warn(`[mail] large message body ${bodyLen} bytes (msg ${msgId})`);
    }
    res.json({ message });
  } catch (err) {
    return friendlyError(err, res);
  }
});

router.get('/accounts/:id/events', rateLimit, async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'Invalid id' });

  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : now.toISOString();
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : weekFromNow.toISOString();

  // Basic ISO validation
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return res.status(400).json({ error: 'from/to must be ISO 8601' });
  }

  try {
    const events = await withAccount(accountId, req.user.id, async (provider, accessToken) => {
      const adapter = getProviderAdapter(provider);
      return adapter.listEvents(accessToken, { from, to });
    });
    res.json({ events });
  } catch (err) {
    return friendlyError(err, res);
  }
});

// ── Mail action approvals (Phase 3) ────────────────────────────────
// Returns the list of pending approvals for the current user so the Mail UI
// can re-hydrate outstanding approval cards on reload.
router.get('/approvals', (req, res) => {
  const rows = stmts.listPendingApprovals.all(req.user.id);
  const approvals = rows.map(r => {
    let payload = null;
    try { payload = JSON.parse(r.payload); } catch { /* leave null */ }
    return {
      id: r.id,
      account_id: r.account_id,
      conversation_id: r.conversation_id,
      action: r.action_type,
      preview: r.preview,
      payload,
      status: r.status,
      created_at: r.created_at,
      expires_at: r.expires_at,
    };
  });
  res.json({ approvals });
});

router.get('/accounts/:id/events/:eventId', rateLimit, async (req, res) => {
  const accountId = parseInt(req.params.id, 10);
  if (!Number.isFinite(accountId)) return res.status(400).json({ error: 'Invalid id' });
  const { eventId } = req.params;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    const event = await withAccount(accountId, req.user.id, async (provider, accessToken) => {
      const adapter = getProviderAdapter(provider);
      return adapter.getEvent(accessToken, eventId);
    });
    res.json({ event });
  } catch (err) {
    return friendlyError(err, res);
  }
});

export default router;
