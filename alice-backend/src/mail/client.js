/**
 * High-level helper that binds together the DB row, token crypto, the OAuth
 * refresh flow, and the provider adapters. Provides:
 *
 *   await withAccount(accountId, userId, async (provider, accessToken, account) => {
 *     return mailProvider.listMessages(accessToken, { ... });
 *   });
 *
 *   - Proactively refreshes if the stored token expires within 60s.
 *   - Catches TokenExpiredError thrown by the provider → refreshes once → retries.
 *   - If refresh fails, sets status='needs_reconnect' and rethrows.
 *   - Uses a per-account Promise lock so two concurrent requests share a single
 *     refresh call instead of racing and blowing away each other's tokens.
 */

import { stmts } from '../db.js';
import { encryptToken, decryptToken } from './tokens.js';
import { refreshAccessToken } from './oauth.js';
import * as microsoft from './providers/microsoft.js';
import * as google from './providers/google.js';

// Union of both providers' TokenExpiredError classes — we detect by name.
function isTokenExpired(err) {
  return err && (err.name === 'TokenExpiredError' || err instanceof microsoft.TokenExpiredError || err instanceof google.TokenExpiredError);
}

/** In-process refresh lock: one pending refresh Promise per account id. */
const _refreshLocks = new Map();

export function getProviderAdapter(provider) {
  if (provider === 'microsoft') return microsoft;
  if (provider === 'google') return google;
  throw new Error(`Unknown provider: ${provider}`);
}

/** Marks the account as needing reconnect and returns a short user-facing error. */
function markNeedsReconnect(accountId, message) {
  try {
    stmts.updateMailAccountStatus.run('needs_reconnect', message || 'refresh_failed', accountId);
  } catch { /* ignore */ }
  const err = new Error('Mail account needs to be reconnected');
  err.code = 'NEEDS_RECONNECT';
  return err;
}

/** Refresh the account's access token. Persists the new tokens and returns plaintext access_token. */
async function performRefresh(account) {
  if (!account.refresh_token_enc) {
    throw markNeedsReconnect(account.id, 'no refresh token');
  }
  let refreshTokenPlain;
  try {
    refreshTokenPlain = decryptToken(account.refresh_token_enc);
  } catch {
    throw markNeedsReconnect(account.id, 'refresh token decrypt failed');
  }

  let tokens;
  try {
    tokens = await refreshAccessToken(account.provider, refreshTokenPlain);
  } catch (err) {
    throw markNeedsReconnect(account.id, err.message || 'refresh failed');
  }

  const newAccess = tokens.access_token;
  if (!newAccess) throw markNeedsReconnect(account.id, 'no access_token in refresh response');
  const newRefresh = tokens.refresh_token || refreshTokenPlain; // Google may omit
  const expiresAt = tokens.expires_in
    ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in)
    : null;

  const accessEnc = encryptToken(newAccess);
  const refreshEnc = encryptToken(newRefresh);
  stmts.updateMailAccountTokens.run(accessEnc, refreshEnc, expiresAt, account.id);

  return newAccess;
}

/** Returns a fresh access token, using the lock to coalesce concurrent refreshes. */
async function ensureFreshAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  const needsRefresh = !account.expires_at || account.expires_at < now + 60;
  if (!needsRefresh) {
    return decryptToken(account.access_token_enc);
  }
  let pending = _refreshLocks.get(account.id);
  if (!pending) {
    pending = performRefresh(account).finally(() => {
      _refreshLocks.delete(account.id);
    });
    _refreshLocks.set(account.id, pending);
  }
  return pending;
}

/** Refresh once after a mid-flight 401, then reload the row so we have the new tokens. */
async function refreshAndReload(accountId, userId) {
  const fresh = stmts.getMailAccount.get(accountId, userId);
  if (!fresh) throw new Error('Mail account not found');
  await ensureFreshAccessToken(fresh);
  const reloaded = stmts.getMailAccount.get(accountId, userId);
  if (!reloaded) throw new Error('Mail account disappeared');
  return decryptToken(reloaded.access_token_enc);
}

/**
 * Load the mail account, ensure a fresh access token, and invoke fn.
 * Retries once on TokenExpiredError after refreshing.
 */
export async function withAccount(accountId, userId, fn) {
  const account = stmts.getMailAccount.get(accountId, userId);
  if (!account) {
    const err = new Error('Mail account not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  let accessToken;
  try {
    accessToken = await ensureFreshAccessToken(account);
  } catch (err) {
    // Refresh failure surfaces as NEEDS_RECONNECT
    throw err;
  }

  try {
    return await fn(account.provider, accessToken, account);
  } catch (err) {
    if (!isTokenExpired(err)) throw err;
    // Mid-flight expiry — refresh once and retry.
    try {
      accessToken = await refreshAndReload(accountId, userId);
    } catch (refreshErr) {
      throw refreshErr;
    }
    return fn(account.provider, accessToken, account);
  }
}
