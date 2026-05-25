/**
 * REST client for conversation CRUD. Uses same-origin cookie auth via fetchJson.
 */

import { fetchJson } from './auth.js';

export async function fetchConversations() {
  const data = await fetchJson('/api/conversations');
  return (data && data.conversations) || [];
}

export async function createConversation(title, agentId) {
  const data = await fetchJson('/api/conversations', {
    method: 'POST',
    body: { title, agent_id: agentId },
  });
  return data && data.conversation;
}

export async function fetchMessages(convId) {
  const data = await fetchJson(`/api/conversations/${encodeURIComponent(convId)}/messages`);
  return (data && data.messages) || [];
}

export async function deleteConversation(convId) {
  await fetchJson(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' });
}

export async function renameConversation(convId, title) {
  const data = await fetchJson(`/api/conversations/${encodeURIComponent(convId)}`, {
    method: 'PATCH',
    body: { title },
  });
  return data && data.conversation;
}
