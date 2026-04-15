/**
 * REST client for the per-user assets API.
 */

function authHeaders(token) {
  return { 'Authorization': `Bearer ${token}` };
}

export async function fetchAssets(baseUrl, token) {
  const res = await fetch(`${baseUrl}/assets`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error('Failed to load assets');
  const data = await res.json();
  return data.assets;
}

export async function deleteAsset(baseUrl, token, id) {
  const res = await fetch(`${baseUrl}/assets/${id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to delete asset');
}
