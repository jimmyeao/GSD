import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { config } from '../config.js';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const SCOPES = 'openid email profile';

function redirectUri() {
  const base = (config.publicUrl || '').replace(/\/+$/, '');
  return `${base}/api/auth/google/callback`;
}

let _jwks = null;
function jwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(JWKS_URI));
  return _jwks;
}

/** Build the Google sign-in authorize URL. */
export function authUrl(state) {
  const params = new URLSearchParams({
    client_id: config.oauth.google.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `${AUTHORIZE}?${params.toString()}`;
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.oauth.google.clientId,
    client_secret: config.oauth.google.clientSecret,
    code,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    let message = `Google token exchange failed: ${resp.status}`;
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

/** Verify a Google ID token against Google's JWKS. */
export async function verifyIdToken(idToken) {
  const clientId = config.oauth.google.clientId;
  const { payload } = await jwtVerify(idToken, jwks(), {
    audience: clientId,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  });

  const rawEmail = payload.email || null;
  const email = typeof rawEmail === 'string' && rawEmail.includes('@') ? rawEmail : null;
  return {
    sub: payload.sub,
    email,
    email_verified: payload.email_verified,
    name: payload.name || null,
    raw: payload,
  };
}

export function decodeIdToken(idToken) {
  return decodeJwt(idToken);
}
