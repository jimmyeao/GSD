/**
 * REST client for conversation CRUD.
 */

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

export async function fetchConversations(baseUrl, token) {
  const res = await fetch(`${baseUrl}/conversations`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load conversations');
  const data = await res.json();
  return data.conversations;
}

export async function createConversation(baseUrl, token, title, agentId) {
  const res = await fetch(`${baseUrl}/conversations`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title, agent_id: agentId }),
  });
  if (!res.ok) throw new Error('Failed to create conversation');
  const data = await res.json();
  return data.conversation;
}

export async function fetchMessages(baseUrl, token, convId) {
  const res = await fetch(`${baseUrl}/conversations/${convId}/messages`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to load messages');
  const data = await res.json();
  return data.messages;
}

export async function deleteConversation(baseUrl, token, convId) {
  const res = await fetch(`${baseUrl}/conversations/${convId}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error('Failed to delete conversation');
}

export async function renameConversation(baseUrl, token, convId, title) {
  const res = await fetch(`${baseUrl}/conversations/${convId}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error('Failed to rename conversation');
  const data = await res.json();
  return data.conversation;
}
