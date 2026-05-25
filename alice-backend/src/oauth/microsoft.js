import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { config } from '../config.js';

const SCOPES = 'openid email profile';

function tenant() {
  return config.oauth.microsoft.tenant || 'common';
}

function authorizeEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/authorize`;
}

function tokenEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0/token`;
}

function jwksUri() {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/discovery/v2.0/keys`;
}

function redirectUri() {
  const base = (config.publicUrl || '').replace(/\/+$/, '');
  return `${base}/api/auth/microsoft/callback`;
}

// Lazy JWKS cache — one per tenant.
let _jwks = null;
function jwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(jwksUri()));
  return _jwks;
}

/**
 * Build the authorize URL for Microsoft sign-in.
 * Caller is responsible for storing `state` in a short-lived cookie.
 */
export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: config.oauth.microsoft.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  return `${authorizeEndpoint()}?${params.toString()}`;
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.oauth.microsoft.clientId,
    client_secret: config.oauth.microsoft.clientSecret,
    code,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
    scope: SCOPES,
  });

  const resp = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    // Body may contain token-ish values in error descriptions; surface message only.
    let message = `Microsoft token exchange failed: ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) message += ` (${data.error})`;
    } catch { /* ignore */ }
    throw new Error(message);
  }

  const data = await resp.json();
  return {
    id_token: data.id_token,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

/**
 * Verify a Microsoft ID token against the tenant JWKS.
 * Allows any MS-issued issuer (needed for tenant=common multi-tenant apps).
 * Returns the verified claims.
 */
export async function verifyIdToken(idToken) {
  const clientId = config.oauth.microsoft.clientId;
  const { payload } = await jwtVerify(idToken, jwks(), {
    audience: clientId,
  });

  // Validate issuer ourselves for multi-tenant ("common") support.
  const iss = payload.iss;
  if (typeof iss !== 'string' || !/^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(iss)) {
    throw new Error('Invalid Microsoft issuer');
  }

  // Normalize fields — MS sometimes omits `email` in favour of preferred_username / upn.
  const rawEmail = payload.email || payload.preferred_username || payload.upn || null;
  const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail : null;
  return {
    sub: payload.sub,
    email,
    email_verified: payload.email_verified,
    name: payload.name || null,
    raw: payload,
  };
}

/** Convenience: decode without verification (for debugging / logging sub only). */
export function decodeIdToken(idToken) {
  return decodeJwt(idToken);
}
