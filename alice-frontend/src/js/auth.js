/**
 * Auth — OAuth (Microsoft + Google) with httpOnly-cookie sessions.
 *
 * The session is stored in an httpOnly cookie (alice_session) that JS cannot
 * read. CSRF protection uses a double-submit cookie (alice_csrf): JS reads
 * that cookie and echoes it back in the X-CSRF-Token header on mutating
 * requests. All fetches are same-origin with credentials: 'include'.
 */

/** Thrown by fetchJson when the server returns 401. Callers should redirect to login. */
export class AuthError extends Error {
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

// Module-level caches.
let _cachedUser = null;        // last user returned by getMe() (null = not logged in)
let _cachedCsrf = null;        // last CSRF token from primeCsrf()
let _providers = null;         // { microsoft, google }

// ── Cookie helpers ────────────────────────────────────────────────────────

function readCookie(name) {
  // document.cookie is a flat string like "a=1; b=2"
  const parts = document.cookie ? document.cookie.split(';') : [];
  for (const raw of parts) {
    const idx = raw.indexOf('=');
    if (idx < 0) continue;
    const k = raw.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(raw.slice(idx + 1));
  }
  return null;
}

// ── Login / Logout ────────────────────────────────────────────────────────

/**
 * Kick off OAuth login with the given provider. Navigates the window to the
 * backend start endpoint; the backend redirects to the provider, then back
 * to '/'. No return value — this navigates away.
 */
export function startLogin(provider) {
  if (provider !== 'microsoft' && provider !== 'google') {
    throw new Error(`Unknown provider: ${provider}`);
  }
  window.location.href = `/api/auth/${provider}/start`;
}

/**
 * POST /api/auth/logout with CSRF, clear client-side cache, reload page.
 */
export async function logout() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRF-Token': getCsrfToken() || '',
      },
    });
  } catch (_) { /* ignore — we reload regardless */ }
  _cachedUser = null;
  _cachedCsrf = null;
  window.location.href = '/';
}

// ── Session / user ────────────────────────────────────────────────────────

/**
 * GET /api/auth/me. Returns the user object on success, null on 401.
 * Throws on network errors or unexpected statuses.
 */
export async function getMe() {
  let res;
  try {
    res = await fetch('/api/auth/me', { credentials: 'include' });
  } catch (err) {
    // Network error — treat as not logged in so we surface the login modal.
    _cachedUser = null;
    return null;
  }
  if (res.status === 401) {
    _cachedUser = null;
    return null;
  }
  if (!res.ok) {
    throw new Error(`Auth check failed: HTTP ${res.status}`);
  }
  const user = await res.json();
  _cachedUser = user;
  return user;
}

/** Async: true if the server agrees we have a live session. */
export async function isLoggedIn() {
  const user = await getMe();
  return user !== null;
}

/** Sync read of the last-known user (populated by getMe()). Use after boot. */
export function getCachedUser() {
  return _cachedUser;
}

// ── Providers ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/providers → { microsoft, google }.
 * Cached for the session.
 */
export async function getProviders() {
  if (_providers) return _providers;
  try {
    const res = await fetch('/api/auth/providers', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _providers = await res.json();
  } catch (err) {
    // If the probe fails, assume both are enabled so buttons don't all vanish.
    _providers = { microsoft: true, google: true };
  }
  return _providers;
}

// ── CSRF ──────────────────────────────────────────────────────────────────

/**
 * GET /api/auth/csrf. Ensures the alice_csrf cookie is set, caches the token.
 * Call once on page load before any state-changing fetch.
 */
export async function primeCsrf() {
  try {
    const res = await fetch('/api/auth/csrf', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data && typeof data.csrf === 'string') {
        _cachedCsrf = data.csrf;
      }
    }
  } catch (_) { /* ignored — getCsrfToken() falls back to cookie */ }
  return getCsrfToken();
}

/**
 * Returns the CSRF token to send in X-CSRF-Token. Prefers the live cookie
 * (survives navigation), falls back to the cached value from primeCsrf().
 */
export function getCsrfToken() {
  const fromCookie = readCookie('alice_csrf');
  return fromCookie || _cachedCsrf;
}

// ── Central fetch helper ──────────────────────────────────────────────────

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Central JSON fetch helper. Features:
 *   - credentials: 'include' on every request
 *   - Content-Type: application/json when a body is supplied
 *   - X-CSRF-Token header on POST/PUT/PATCH/DELETE
 *   - Throws AuthError on 401 (and reloads the page to force re-auth)
 *   - Throws { status, body } on other non-2xx responses
 *   - Returns parsed JSON (or null on 204 / empty body)
 *
 * @param {string} path  — relative path (e.g. '/api/auth/me')
 * @param {object} options — standard fetch options; body may be an object
 *                           (auto-stringified) or a string.
 */
export async function fetchJson(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };

  let body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
    body = JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (typeof body === 'string' && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (MUTATING_METHODS.has(method)) {
    headers['X-CSRF-Token'] = getCsrfToken() || '';
  }

  let res;
  try {
    res = await fetch(path, {
      ...options,
      method,
      headers,
      body,
      credentials: 'include',
    });
  } catch (err) {
    // Network-level failure
    const e = new Error(err?.message || 'Network error');
    e.status = 0;
    throw e;
  }

  if (res.status === 401) {
    // Central re-auth: clear cache and force the login modal via reload.
    _cachedUser = null;
    // Tiny setTimeout so the caller can see the throw before the reload kicks in.
    setTimeout(() => { window.location.reload(); }, 0);
    throw new AuthError();
  }

  if (res.status === 403) {
    // Soft-fail: surface a friendly message but still throw so the caller knows.
    try { window.alert("You don't have permission to do that."); } catch (_) {}
    const bodyText = await res.text().catch(() => '');
    const err = new Error('Forbidden');
    err.status = 403;
    err.body = bodyText;
    throw err;
  }

  if (!res.ok) {
    let bodyText = '';
    try { bodyText = await res.text(); } catch (_) {}
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }

  if (res.status === 204) return null;
  // Handle empty response bodies defensively (some DELETEs return 200 empty)
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}
