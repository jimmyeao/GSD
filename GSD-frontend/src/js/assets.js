/**
 * REST client for the per-user assets API. Same-origin cookie auth.
 */

import { fetchJson } from './auth.js';

export async function fetchAssets() {
  const data = await fetchJson('/api/assets');
  return (data && data.assets) || [];
}

export async function deleteAsset(id) {
  await fetchJson(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
