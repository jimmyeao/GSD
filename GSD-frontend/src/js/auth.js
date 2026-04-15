/**
 * Auth state manager — JWT storage, login/register API calls.
 */

const TOKEN_KEY = 'gsd-token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Decode JWT payload (no verification — that's the server's job). */
export function getUser() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return { id: payload.sub, username: payload.username };
  } catch {
    clearToken();
    return null;
  }
}

export function isLoggedIn() {
  return getUser() !== null;
}

export async function login(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  setToken(data.token);
  return data.user;
}

export async function register(baseUrl, username, password) {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  setToken(data.token);
  return data.user;
}

export function logout() {
  clearToken();
  window.location.reload();
}
