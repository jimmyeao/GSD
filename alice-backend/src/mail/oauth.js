/**
 * OAuth 2.0 flow for connecting *mail accounts* (extended scopes).
 * Separate from the login OAuth flow — do NOT reuse.
 *
 * Scopes:
 *   Microsoft: openid email profile offline_access
 *              Mail.ReadWrite Mail.Send Calendars.ReadWrite
 *   Google:    openid email profile
 *              gmail.modify gmail.send calendar
 *
 * NEVER log access or refresh tokens. Redact any token field in debug output.
 */

import { config } from '../config.js';
import {
  verifyIdToken as verifyMsIdToken,
} from '../oauth/microsoft.js';
import {
  verifyIdToken as verifyGoogleIdToken,
} from '../oauth/google.js';

const MS_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.ReadWrite',
].join(' ');

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

function msTenant() {
  return config.oauth.microsoft.tenant || 'common';
}

function msAuthorizeEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(msTenant())}/oauth2/v2.0/authorize`;
}

function msTokenEndpoint() {
  return `https://login.microsoftonline.com/${encodeURIComponent(msTenant())}/oauth2/v2.0/token`;
}

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function assertProvider(provider) {
  if (provider !== 'microsoft' && provider !== 'google') {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Build the provider's authorize URL with mail/calendar scopes.
 */
export function buildAuthUrl(provider, state, redirectUri) {
  assertProvider(provider);
  if (provider === 'microsoft') {
    if (!config.oauth.microsoft.clientId) throw new Error('Microsoft client not configured');
    const params = new URLSearchParams({
      client_id: config.oauth.microsoft.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MS_SCOPES,
      state,
      // Force consent so we always get a refresh token on fresh connect.
      prompt: 'consent',
    });
    return `${msAuthorizeEndpoint()}?${params.toString()}`;
  }
  // google
  if (!config.oauth.google.clientId) throw new Error('Google client not configured');
  const params = new URLSearchParams({
    client_id: config.oauth.google.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: GOOGLE_SCOPES,
    // access_type=offline + prompt=consent is required to reliably get a refresh_token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * Returns { access_token, refresh_token, expires_in, id_token, scope }.
 */
export async function exchangeCode(provider, code, redirectUri) {
  assertProvider(provider);
  const body = new URLSearchParams();
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('grant_type', 'authorization_code');

  let endpoint;
  if (provider === 'microsoft') {
    body.set('client_id', config.oauth.microsoft.clientId);
    body.set('client_secret', config.oauth.microsoft.clientSecret);
    body.set('scope', MS_SCOPES);
    endpoint = msTokenEndpoint();
  } else {
    body.set('client_id', config.oauth.google.clientId);
    body.set('client_secret', config.oauth.google.clientSecret);
    endpoint = GOOGLE_TOKEN;
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    let message = `${provider} token exchange failed: ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) message += ` (${data.error})`;
    } catch { /* ignore */ }
    throw new Error(message);
  }

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in,
    id_token: data.id_token || null,
    scope: data.scope || null,
  };
}

/**
 * Refresh an access token. Returns { access_token, refresh_token?, expires_in }.
 * Google may return no refresh_token — caller must keep the original.
 */
export async function refreshAccessToken(provider, refreshToken) {
  assertProvider(provider);
  if (!refreshToken) throw new Error('No refresh token available');

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);

  let endpoint;
  if (provider === 'microsoft') {
    body.set('client_id', config.oauth.microsoft.clientId);
    body.set('client_secret', config.oauth.microsoft.clientSecret);
    body.set('scope', MS_SCOPES);
    endpoint = msTokenEndpoint();
  } else {
    body.set('client_id', config.oauth.google.clientId);
    body.set('client_secret', config.oauth.google.clientSecret);
    endpoint = GOOGLE_TOKEN;
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    let message = `${provider} refresh failed: ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) message += ` (${data.error})`;
    } catch { /* ignore */ }
    throw new Error(message);
  }

  const data = await resp.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in,
  };
}

/**
 * Verify the ID token signature via the existing login helpers and extract
 * a trustworthy { email, sub, name }. We never trust provider user input.
 */
export async function extractEmailFromIdToken(provider, idToken) {
  assertProvider(provider);
  if (!idToken) throw new Error('No id_token returned from provider');
  const claims = provider === 'microsoft'
    ? await verifyMsIdToken(idToken)
    : await verifyGoogleIdToken(idToken);
  if (claims.email_verified === false) {
    throw new Error('Email is not verified by the identity provider');
  }
  if (!claims.email) throw new Error('No email claim in id_token');
  return {
    email: claims.email,
    sub: claims.sub,
    name: claims.name || null,
  };
}

export const SCOPES = {
  microsoft: MS_SCOPES,
  google: GOOGLE_SCOPES,
};
