import { AGENTS, MODEL_BADGE_CLASS } from './agents.js';
import { SocketClient } from './socketClient.js';
import { Chat } from './chat.js';
import { CodeView } from './codeView.js';
import { renderApprovalCard, setResolvedState, setErrorState } from './approvalCard.js';
import {
  startLogin, logout, getMe, getCachedUser,
  primeCsrf, getProviders, fetchJson, AuthError,
} from './auth.js';
import { initAdmin } from './admin.js';
import { initMail } from './mail.js';
import { fetchConversations, fetchMessages, deleteConversation } from './conversations.js';
import { fetchAssets, deleteAsset } from './assets.js';
import { isSupported as voiceSupported, createRecognition, speak, stopSpeaking, isSpeaking, setTTSBackend, getSpeechQueue } from './voice.js';

// ------------------------------------------------------------------ State
let selectedAgent = AGENTS[0]; // RouterAgent default
let client = null;
let codeView = null;
let isStreaming = false;
let _optimiseTimer = null;
let attachedFiles = []; // [{ name, content }]
let currentConversationId = null;
let conversations = [];
let currentUser = null;

// Mail approval tracking: approvalId → HTMLElement (card in chat DOM).
// Kept per-page (not per-conversation) so resolutions can find their card
// even if the user has since switched conversations.
const _approvalCards = new Map();
// Pending approvals that arrived for other conversations — shown as a banner.
let _pendingOtherConversations = new Set();
let _approvalsHydrated = false;

// Same-origin base URL. All API calls go via relative paths; this constant
// is only used for the TTS backend (voice.js calls ${backend}/tts, so we
// pass '/api' as the base to hit /api/tts through NGINX).
const DEFAULT_URL = window.location.origin;
setTTSBackend('/api');

// ------------------------------------------------------------------ DOM refs
const sidebar        = document.getElementById('sidebar');
const agentList      = document.getElementById('agent-list');
const chatMessages   = document.getElementById('chat-messages');
const inputEl        = document.getElementById('prompt-input');
const sendBtn        = document.getElementById('send-btn');
const clearBtn       = document.getElementById('clear-btn');
const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const activeLabel    = document.getElementById('active-agent-label');
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const urlInput       = document.getElementById('backend-url');
const connectBtn     = document.getElementById('connect-btn');
const sidebarToggle  = document.getElementById('sidebar-toggle');
const exampleBanner  = document.getElementById('example-banner');
const exampleText    = document.getElementById('example-text');
const optimiseBtn    = document.getElementById('optimise-btn');
const optimiseStatus = document.getElementById('optimise-status');
const attachBtn      = document.getElementById('attach-btn');
const fileInput      = document.getElementById('file-input');
const attachedFilesEl = document.getElementById('attached-files');
const authModal      = document.getElementById('auth-modal');
const authError      = document.getElementById('auth-error');
const btnMsLogin     = document.getElementById('btn-ms-login');
const btnGoogleLogin = document.getElementById('btn-google-login');
const userLabel      = document.getElementById('user-label');
const logoutBtn      = document.getElementById('logout-btn');
const convList       = document.getElementById('conversation-list');
const assetsBtn      = document.getElementById('assets-btn');
const assetsPanel    = document.getElementById('assets-panel');
const assetsGrid     = document.getElementById('assets-grid');
const assetsEmpty    = document.getElementById('assets-empty');
const assetsClose    = document.getElementById('assets-close');
const codeViewContainer = document.getElementById('code-view-container');
const chatModeBtn    = document.getElementById('chat-mode-btn');
const codeModeBtn    = document.getElementById('code-mode-btn');
const micBtn         = document.getElementById('mic-btn');
const speakToggle    = document.getElementById('speak-toggle');

// ------------------------------------------------------------------ Voice
let autoSpeak = false;
let recognition = null;

if (voiceSupported().recognition && micBtn) {
  recognition = createRecognition({
    onResult: (text) => {
      inputEl.value += text;
      autoResizeTextarea();
    },
    onInterim: (text) => {
      inputEl.placeholder = text || 'Listening...';
    },
    onComplete: (text) => {
      // Auto-send after silence
      inputEl.value = text;
      autoResizeTextarea();
      setTimeout(() => handleSend(), 300);
    },
    onEnd: () => {
      micBtn.classList.remove('mic-active');
      inputEl.placeholder = 'Type a prompt… (Shift+Enter for new line)';
    },
    onError: (msg) => chat.addErrorMessage(msg),
  });

  micBtn.addEventListener('click', () => {
    if (recognition.isActive) {
      recognition.stop();
    } else {
      // Interrupt Alice if she's speaking
      stopSpeaking();
      recognition.start();
      micBtn.classList.add('mic-active');
    }
  });
} else if (micBtn) {
  micBtn.disabled = true;
  micBtn.title = 'Speech recognition not supported in this browser';
}

if (speakToggle) {
  speakToggle.addEventListener('click', () => {
    autoSpeak = !autoSpeak;
    speakToggle.classList.toggle('speak-active', autoSpeak);
    speakToggle.textContent = autoSpeak ? '🔊' : '🔇';
    if (!autoSpeak) {
      stopSpeaking();
    } else if (isStreaming && chat._streamBuffer) {
      // Start speaking what's been streamed so far, then continue with queue
      getSpeechQueue().reset();
      getSpeechQueue().push(chat._streamBuffer);
    } else if (chat.history.length) {
      const last = chat.history[chat.history.length - 1];
      if (last.role === 'assistant') speak(last.content);
    }
  });
}

// ------------------------------------------------------------------ Chat
const chat = new Chat(chatMessages, handleSend);

const LANG_EXT = { javascript: 'js', typescript: 'ts', python: 'py', html: 'html', css: 'css', json: 'json', sh: 'sh', go: 'go', rust: 'rs', java: 'java', sql: 'sql', ruby: 'rb', php: 'php', markdown: 'md' };

chat.onOpenInEditor(async ({ code, lang }) => {
  // Ensure code view is initialised
  if (!codeView) {
    setViewMode('code');
    // wait a tick for init
    await new Promise(r => setTimeout(r, 200));
  }
  if (!codeView) return;
  const ext = LANG_EXT[lang] || lang || 'txt';
  const filename = prompt('Save as:', `snippet.${ext}`);
  if (!filename?.trim()) return;
  // If a project is loaded, save to workspace
  if (codeView._projectId) {
    try {
      await fetchJson(
        `/api/workspace/${encodeURIComponent(codeView._projectId)}/file?path=${encodeURIComponent(filename.trim())}`,
        { method: 'POST', body: { type: 'file', content: code } }
      );
      await codeView._fileTree.refresh();
    } catch { /* ignore — still open in editor */ }
  }
  codeView._editor.openFile(filename.trim(), code);
  setViewMode('code');
});

// ------------------------------------------------------------------ Auth UI

function showAuth() {
  authModal.hidden = false;
}

function hideAuth() {
  authModal.hidden = true;
  authError.hidden = true;
}

function updateAuthUI() {
  if (currentUser) {
    userLabel.textContent = currentUser.display_name || currentUser.email || currentUser.username || '';
    logoutBtn.hidden = false;
  } else {
    userLabel.textContent = '';
    logoutBtn.hidden = true;
  }
}

// Show "not authorized" error if redirected back after a denied OAuth login.
function handleLoginError() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('error') === 'not_authorized') {
    authError.textContent = 'Your account is not authorized for this application. Please contact your administrator.';
    authError.hidden = false;
    // Clean the URL so reload doesn't re-trigger the message.
    try { window.history.replaceState({}, '', window.location.pathname); } catch (_) {}
  }
}

// Hide whichever SSO buttons the server reports as disabled.
async function applyProviderVisibility() {
  try {
    const providers = await getProviders();
    if (btnMsLogin) btnMsLogin.hidden = !providers.microsoft;
    if (btnGoogleLogin) btnGoogleLogin.hidden = !providers.google;
  } catch (_) { /* leave both visible on failure */ }
}

if (btnMsLogin) btnMsLogin.addEventListener('click', () => startLogin('microsoft'));
if (btnGoogleLogin) btnGoogleLogin.addEventListener('click', () => startLogin('google'));

logoutBtn.addEventListener('click', () => logout());

// ------------------------------------------------------------------ Sidebar
function buildSidebar() {
  agentList.innerHTML = '';
  AGENTS.forEach(agent => {
    const li = document.createElement('li');
    li.className = 'agent-item' + (agent.id === selectedAgent.id ? ' active' : '');
    li.dataset.id = agent.id;

    const badgeClass = MODEL_BADGE_CLASS[agent.model] || 'badge-general';

    li.innerHTML = `
      <span class="agent-icon">${agent.icon}</span>
      <span class="agent-info">
        <span class="agent-name">${agent.label}</span>
        <span class="agent-model badge ${badgeClass}">${agent.model}</span>
      </span>
    `;

    li.addEventListener('click', () => selectAgent(agent));
    agentList.appendChild(li);
  });
}

function selectAgent(agent) {
  selectedAgent = agent;
  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === agent.id);
  });
  activeLabel.textContent = agent.label;

  if (agent.example) {
    exampleText.textContent = agent.example;
    exampleBanner.hidden = false;
  } else {
    exampleBanner.hidden = true;
  }

  inputEl.focus();
}

// ------------------------------------------------------------------ Conversations sidebar
async function loadConversations() {
  try {
    conversations = await fetchConversations();
    renderConversationList();
  } catch (err) {
    if (err instanceof AuthError) return; // reload already triggered
    console.error('[conversations] load failed:', err.message);
  }
}

function renderConversationList() {
  convList.innerHTML = '';
  conversations.forEach(conv => {
    const li = document.createElement('li');
    li.className = 'conv-item' + (conv.id === currentConversationId ? ' active' : '');
    li.dataset.id = conv.id;

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conv.title;
    li.appendChild(title);

    const del = document.createElement('button');
    del.className = 'conv-delete';
    del.textContent = '\u00d7';
    del.title = 'Delete';
    li.appendChild(del);

    li.addEventListener('click', e => {
      if (e.target.closest('.conv-delete')) return;
      switchConversation(conv.id);
    });

    del.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await deleteConversation(conv.id);
        conversations = conversations.filter(c => c.id !== conv.id);
        if (currentConversationId === conv.id) startNewChat();
        renderConversationList();
      } catch (err) {
        if (!(err instanceof AuthError)) chat.addErrorMessage(err.message);
      }
    });

    convList.appendChild(li);
  });
}

async function switchConversation(convId) {
  if (convId === currentConversationId) return;
  currentConversationId = convId;
  renderConversationList();
  chat.clear();
  // Cards are tied to DOM elements that were just cleared — drop references.
  _approvalCards.clear();
  _pendingOtherConversations.delete(convId);
  renderPendingApprovalsBanner();
  renderBulkApproveBar();

  try {
    const messages = await fetchMessages(convId);
    messages.forEach(msg => {
      chat.addRestoredMessage(msg.role, msg.content, msg.agent_id, msg.created_at);
    });
  } catch (err) {
    if (!(err instanceof AuthError)) chat.addErrorMessage('Failed to load conversation');
  }

  // Re-hydrate approvals for this conversation (if connected).
  if (client && client.connected) hydratePendingApprovals();

  inputEl.focus();
}

function startNewChat() {
  currentConversationId = null;
  chat.clear();
  _approvalCards.clear();
  _pendingOtherConversations.clear();
  renderPendingApprovalsBanner();
  renderBulkApproveBar();
  renderConversationList();
  inputEl.focus();
}

// ------------------------------------------------------------------ Assets panel
const ASSET_ICONS = { video: '🎬', image: '🖼', slide: '📊' };

async function loadAssets() {
  try {
    const assets = await fetchAssets();
    renderAssets(assets);
  } catch (err) {
    if (!(err instanceof AuthError)) console.error('[assets] load failed:', err.message);
  }
}

function renderAssets(assets) {
  assetsGrid.innerHTML = '';
  assetsEmpty.hidden = assets.length > 0;

  assets.forEach(asset => {
    const card = document.createElement('div');
    card.className = 'asset-card';

    const sizeStr = asset.size_bytes ? `${(asset.size_bytes / 1024 / 1024).toFixed(1)}MB` : '';
    const dateStr = new Date(asset.created_at + 'Z').toLocaleDateString();
    // Same-origin, cookie-auth download. No token in URL anymore — NGINX
    // forwards the session cookie.
    const fileUrl = `/api/assets/${encodeURIComponent(asset.id)}/file`;

    card.innerHTML = `
      <span class="asset-icon">${ASSET_ICONS[asset.type] || '📁'}</span>
      <span class="asset-title" title="${asset.title || asset.filename}">${asset.title || asset.filename}</span>
      <span class="asset-meta"><span>${asset.type}</span><span>${sizeStr}</span><span>${dateStr}</span></span>
      <div class="asset-actions">
        <a class="asset-dl" href="${fileUrl}" target="_blank" download>Download</a>
        <button class="asset-del" data-id="${asset.id}">Delete</button>
      </div>
    `;

    card.querySelector('.asset-del').addEventListener('click', async () => {
      try {
        await deleteAsset(asset.id);
        card.remove();
        if (!assetsGrid.children.length) assetsEmpty.hidden = false;
      } catch (err) {
        if (!(err instanceof AuthError)) console.error('[assets] delete failed:', err.message);
      }
    });

    assetsGrid.appendChild(card);
  });
}

assetsBtn.addEventListener('click', () => {
  assetsPanel.hidden = !assetsPanel.hidden;
  if (!assetsPanel.hidden) loadAssets();
});

assetsClose.addEventListener('click', () => {
  assetsPanel.hidden = true;
});

// ------------------------------------------------------------------ Connection
function initConnection(url) {
  if (client) client.disconnect();

  setStatus('connecting', 'Connecting…');
  // No url = default to current origin (NGINX proxies /socket.io).
  client = new SocketClient(url);

  client.on('statusChange', ({ connected, reason }) => {
    if (connected) {
      setStatus('online', 'Connected');
      loadConversations();
    } else {
      setStatus('offline', reason ? `Disconnected: ${reason}` : 'Disconnected');
    }
  });

  client.on('connectionError', ({ message }) => {
    // If cookie auth was rejected, force a full reload so the login modal
    // is shown again via getMe() returning null.
    const msg = (message || '').toLowerCase();
    if (msg.includes('auth') || msg.includes('unauthoriz') || msg.includes('forbidden')) {
      setStatus('offline', 'Session expired — reloading…');
      setTimeout(() => window.location.reload(), 400);
      return;
    }
    setStatus('offline', `Error: ${message}`);
  });

  client.on('routed', ({ agent }) => {
    chat.addStatusMessage(`Routed to ${agent}`);
  });

  client.on('thinking', () => {
    chat.showThinking();
  });

  client.on('token', ({ token }) => {
    chat.appendToken(token);
    // Stream TTS: feed tokens to speech queue as they arrive
    if (autoSpeak) getSpeechQueue().push(token);
  });

  client.on('done', () => {
    try { chat.finaliseStream(); } catch (e) { console.error('[done] finaliseStream error:', e); }
    setStreaming(false);
    // Flush remaining text to speech queue
    if (autoSpeak) getSpeechQueue().flush();
  });

  client.on('serverError', ({ message }) => {
    clearTimeout(_optimiseTimer);
    try { chat.finaliseStream(); } catch (_) {}
    chat.addErrorMessage(message);
    setStreaming(false);
    setOptimising(false);
  });

  client.on('optimised', ({ positive }) => {
    clearTimeout(_optimiseTimer);
    inputEl.value = positive;
    autoResizeTextarea();
    inputEl.focus();
    setOptimising(false);
  });

  client.on('conversationCreated', ({ id, title, agent_id }) => {
    currentConversationId = id;
    conversations.unshift({ id, title, agent_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    renderConversationList();
  });

  client.on('containerOutput', ({ containerId, data }) => {
    if (codeView) {
      // Forward to code view's terminal
      codeView._terminal?.appendOutput(data);
    }
  });

  // ── MailAgent approval events ────────────────────────────────────────
  client.on('mailApprovalNeeded', (data) => {
    handleApprovalNeeded(data);
  });

  client.on('mailApprovalResolved', (data) => {
    handleApprovalResolved(data);
  });

  client.on('mailApprovalError', (data) => {
    handleApprovalError(data);
  });

  client.on('mailContinuationStart', () => {
    // Backend auto-re-invoked MailAgent; open a fresh assistant bubble so the
    // upcoming tokens render (they'd otherwise drop on a closed stream).
    try { chat.startAssistantStream('MailAgent'); } catch (_) { /* ignore */ }
    setStreaming(true);
  });

  // On (re)connect, hydrate any pending approvals from the server.
  client.on('statusChange', ({ connected }) => {
    if (connected) hydratePendingApprovals();
  });

  client.connect();
}

// ------------------------------------------------------------------ Mail approvals
/**
 * Render an approval card for the given payload. If `conversation_id` is
 * present and doesn't match the current conversation, surface a banner
 * rather than appending to a thread the user isn't looking at.
 */
function handleApprovalNeeded(data) {
  if (!data || !data.approvalId) return;
  // Idempotence guard — never double-render the same approval.
  if (_approvalCards.has(data.approvalId)) return;

  const convId = data.conversation_id || data.conversationId || null;
  if (convId && currentConversationId && convId !== currentConversationId) {
    _pendingOtherConversations.add(convId);
    renderPendingApprovalsBanner();
    return;
  }

  const card = renderApprovalCard(
    chatMessages,
    data,
    {
      onApprove: () => sendApprovalDecision(data.approvalId, 'approve'),
      onReject:  () => sendApprovalDecision(data.approvalId, 'reject'),
    },
  );
  _approvalCards.set(data.approvalId, card);
  renderBulkApproveBar();
}

function handleApprovalResolved(data) {
  if (!data || !data.approvalId) return;
  const card = _approvalCards.get(data.approvalId);
  if (card) {
    setResolvedState(card, data.status || 'failed', { error: data.error });
    _approvalCards.delete(data.approvalId);
  }
  renderBulkApproveBar();
  // The backend follows this event with a summary streamed as token chunks.
  // Open a fresh assistant bubble so those tokens render — otherwise
  // chat.appendToken silently drops them because _streamEl is null from the
  // original prompt's finaliseStream().
  try { chat.startAssistantStream('MailAgent'); } catch (_) { /* ignore */ }
}

function handleApprovalError(data) {
  const msg = (data && data.message) || 'Approval error';
  if (data && data.approvalId && _approvalCards.has(data.approvalId)) {
    setErrorState(_approvalCards.get(data.approvalId), msg);
    _approvalCards.delete(data.approvalId);
    renderBulkApproveBar();
    return;
  }
  // Transient toast-style notice in the chat stream.
  try { chat.addErrorMessage(msg); } catch (_) { /* ignore */ }
}

// Shows a sticky "Approve all (N)" bar at the top of the chat whenever 2+
// approval cards are pending for the active conversation. One click fires
// approve for every outstanding card — the backend handles each as a normal
// approve_response event, so resolutions still arrive per-card.
function renderBulkApproveBar() {
  const chatWrap = chatMessages;
  if (!chatWrap) return;
  let bar = document.getElementById('mail-bulk-approve-bar');
  const pendingIds = [..._approvalCards.keys()].filter(id => {
    const c = _approvalCards.get(id);
    return c && !c.dataset.decided;
  });
  const count = pendingIds.length;
  if (count < 2) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mail-bulk-approve-bar';
    bar.className = 'approvals-banner';
    bar.style.position = 'sticky';
    bar.style.top = '0';
    bar.style.zIndex = '10';
    const label = document.createElement('span');
    label.className = 'approvals-banner__label';
    bar.appendChild(label);
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'approvals-banner__btn';
    approveBtn.addEventListener('click', () => {
      if (approveBtn.disabled) return;
      approveBtn.disabled = true;
      approveBtn.textContent = 'Approving…';
      const ids = [..._approvalCards.keys()].filter(id => {
        const c = _approvalCards.get(id);
        return c && !c.dataset.decided;
      });
      for (const id of ids) {
        const c = _approvalCards.get(id);
        if (!c) continue;
        // Mark decided locally (same state setApprovalCard sets on click) so
        // we don't re-send if another resolution interleaves.
        c.dataset.decided = '1';
        c.querySelectorAll('.approval-card__btn').forEach(b => (b.disabled = true));
        sendApprovalDecision(id, 'approve');
      }
    });
    bar.appendChild(approveBtn);
    chatWrap.prepend(bar);
  }
  const labelEl = bar.querySelector('.approvals-banner__label');
  const btnEl = bar.querySelector('.approvals-banner__btn');
  if (labelEl) labelEl.textContent = `${count} approvals pending — `;
  if (btnEl && !btnEl.disabled) btnEl.textContent = `Approve all ${count}`;
}

function sendApprovalDecision(approvalId, decision) {
  if (!client || !client.connected) {
    // Find the card and flag a failure — the user can retry when reconnected.
    const card = _approvalCards.get(approvalId);
    if (card) setErrorState(card, 'Not connected — try again when online.');
    return;
  }
  try {
    client.sendMailApprovalResponse(approvalId, decision);
  } catch (err) {
    const card = _approvalCards.get(approvalId);
    if (card) setErrorState(card, err.message || 'Failed to send response');
  }
}

/**
 * On connect/reconnect, fetch any approvals still pending and render the
 * ones that belong to the current conversation. Expired ones get a one-line
 * status note instead of a full card.
 */
async function hydratePendingApprovals() {
  let data;
  try {
    data = await fetchJson('/api/mail/approvals');
  } catch (err) {
    if (err instanceof AuthError) return;
    // Endpoint may not exist yet; fail quiet so chat still works.
    console.warn('[mail] approvals hydration failed:', err.message);
    return;
  }
  _approvalsHydrated = true;
  const approvals = (data && data.approvals) || [];
  _pendingOtherConversations.clear();

  approvals.forEach(a => {
    if (!a || !a.id) return;
    const convId = a.conversation_id || a.conversationId || null;
    const approvalId = a.id;

    if (a.status === 'expired') {
      if (!convId || convId === currentConversationId) {
        try { chat.addStatusMessage('Action expired — ask again to retry'); } catch (_) {}
      }
      return;
    }

    if (a.status && a.status !== 'pending') return;

    if (_approvalCards.has(approvalId)) return;

    if (convId && currentConversationId && convId !== currentConversationId) {
      _pendingOtherConversations.add(convId);
      return;
    }

    const card = renderApprovalCard(
      chatMessages,
      {
        approvalId,
        action: a.action,
        payload: a.payload || {},
        preview: a.preview || '',
      },
      {
        onApprove: () => sendApprovalDecision(approvalId, 'approve'),
        onReject:  () => sendApprovalDecision(approvalId, 'reject'),
      },
    );
    _approvalCards.set(approvalId, card);
  });

  renderPendingApprovalsBanner();
  renderBulkApproveBar();
}

function renderPendingApprovalsBanner() {
  let banner = document.getElementById('mail-approvals-banner');
  const count = _pendingOtherConversations.size;
  if (count === 0) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mail-approvals-banner';
    banner.className = 'approvals-banner';
    const label = document.createElement('span');
    label.className = 'approvals-banner__label';
    banner.appendChild(label);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'approvals-banner__btn';
    btn.textContent = 'Open';
    btn.addEventListener('click', () => {
      const next = _pendingOtherConversations.values().next().value;
      if (next) switchConversation(next);
    });
    banner.appendChild(btn);
    chatMessages.prepend(banner);
  }
  const labelEl = banner.querySelector('.approvals-banner__label');
  if (labelEl) {
    labelEl.textContent = count === 1
      ? 'You have 1 pending email action in another conversation.'
      : `You have ${count} pending email actions in other conversations.`;
  }
}

// ------------------------------------------------------------------ Files
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    if (isImageFile(file.name)) {
      // Read images as base64 data URL
      reader.onload = e => resolve(e.target.result);
      reader.readAsDataURL(file);
    } else {
      // Read text files as text
      reader.onload = e => resolve(e.target.result);
      reader.readAsText(file);
    }
  });
}

function renderAttachedFileBadges() {
  if (!attachedFilesEl) return;
  attachedFilesEl.innerHTML = '';
  attachedFiles.forEach((f, i) => {
    const badge = document.createElement('span');
    badge.className = 'file-badge';
    badge.innerHTML = `📎 ${f.name} <span class="file-badge-remove" data-index="${i}" title="Remove">×</span>`;
    attachedFilesEl.appendChild(badge);
  });
  attachedFilesEl.hidden = attachedFiles.length === 0;
}

function buildMessageWithFiles(text, files) {
  // Only include non-image files inline in the message text
  const textFiles = files.filter(f => !f.isImage);
  if (!textFiles.length) return text;
  const sections = textFiles.map(f => {
    const ext = f.name.split('.').pop() || '';
    return `\`\`\`${ext}\n// File: ${f.name}\n${f.content}\n\`\`\``;
  });
  return sections.join('\n\n') + '\n\n' + text;
}

if (attachBtn) attachBtn.addEventListener('click', () => fileInput && fileInput.click());

if (fileInput) fileInput.addEventListener('change', async () => {
  const newFiles = Array.from(fileInput.files);
  for (const file of newFiles) {
    try {
      const content = await readFile(file);
      if (!attachedFiles.find(f => f.name === file.name)) {
        attachedFiles.push({ name: file.name, content, isImage: isImageFile(file.name) });
      }
    } catch (err) {
      chat.addErrorMessage(err.message);
    }
  }
  fileInput.value = '';
  renderAttachedFileBadges();
});

if (attachedFilesEl) attachedFilesEl.addEventListener('click', e => {
  const btn = e.target.closest('.file-badge-remove');
  if (!btn) return;
  attachedFiles.splice(Number(btn.dataset.index), 1);
  renderAttachedFileBadges();
});

// ------------------------------------------------------------------ Send
function handleSend() {
  // If streaming, clicking Send acts as Stop
  if (isStreaming) {
    if (client) client.stopStream();
    stopSpeaking(); // also stops the speech queue
    return;
  }
  // Reset speech queue for new conversation turn
  getSpeechQueue().reset();
  const text = inputEl.value.trim();
  if (!text) return;

  if (!client || !client.connected) {
    chat.addErrorMessage('Not connected to backend. Check Settings and connect first.');
    return;
  }

  const files = [...attachedFiles];
  const content = buildMessageWithFiles(text, files);

  // Extract first attached image for agents that support it (VideoAgent, ImageAgent)
  const imageFile = files.find(f => f.isImage);
  const imageData = imageFile ? { name: imageFile.name, dataUrl: imageFile.content } : null;

  chat.addUserMessage(text, files);
  chat.startAssistantStream(selectedAgent.label);
  setStreaming(true);
  inputEl.value = '';
  attachedFiles = [];
  renderAttachedFileBadges();
  autoResizeTextarea();

  try {
    client.sendMessage(selectedAgent.id, content, chat.history.slice(0, -2), currentConversationId, imageData);
  } catch (err) {
    chat.finaliseStream();
    chat.addErrorMessage(err.message);
    setStreaming(false);
  }
}

// ------------------------------------------------------------------ UI helpers
function setStatus(state, label) {
  statusDot.className = `status-dot status-${state}`;
  statusText.textContent = label;
}

function setStreaming(active) {
  isStreaming = active;
  sendBtn.disabled = false; // always clickable — acts as Stop when streaming
  sendBtn.textContent = active ? 'Stop' : 'Send';
  sendBtn.classList.toggle('stop-mode', active);
  optimiseBtn.disabled = active;
}

function setOptimising(active) {
  optimiseBtn.disabled = active;
  optimiseBtn.textContent = active ? '…' : 'Optimise';
  sendBtn.disabled = active;
  optimiseStatus.hidden = !active;
}

function autoResizeTextarea() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

// ------------------------------------------------------------------ Settings panel
settingsBtn.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) urlInput.value = (client && client.url) || DEFAULT_URL;
});

connectBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  settingsPanel.hidden = true;
  // Empty string => socket.io-client uses current origin.
  initConnection(url || undefined);
});

// ------------------------------------------------------------------ Other bindings
clearBtn.addEventListener('click', () => startNewChat());

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

sendBtn.addEventListener('click', handleSend);

optimiseBtn.addEventListener('click', () => {
  const content = inputEl.value.trim();
  if (!content || isStreaming) return;
  if (!client || !client.connected) {
    chat.addErrorMessage('Not connected to backend.');
    return;
  }
  setOptimising(true);
  // Backend's enhance*Prompt() calls now budget up to 90s for the LLM itself
  // (verified the real video-prompt system prompt needs ~2600+ reasoning
  // tokens to complete, given how many constraints it has to satisfy) — give
  // real headroom past that, and show an actual error on a genuine timeout
  // instead of resetting the button silently with zero feedback.
  _optimiseTimer = setTimeout(() => {
    setOptimising(false);
    chat.addErrorMessage('Prompt optimisation timed out — try again, or check the LLM backend is reachable.');
  }, 100_000);
  try {
    client.optimisePrompt(content, selectedAgent.id);
  } catch (err) {
    clearTimeout(_optimiseTimer);
    chat.addErrorMessage(err.message);
    setOptimising(false);
  }
});

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

inputEl.addEventListener('input', autoResizeTextarea);

exampleBanner.addEventListener('click', () => {
  if (selectedAgent.example) {
    inputEl.value = selectedAgent.example;
    autoResizeTextarea();
    inputEl.focus();
  }
});

// ------------------------------------------------------------------ View mode toggle
function setViewMode(mode) {
  const isCode = mode === 'code';

  // Toggle visibility — fully hide main chat when in code mode
  chatMessages.style.display = isCode ? 'none' : '';
  document.getElementById('input-area').style.display = isCode ? 'none' : '';
  codeViewContainer.hidden = !isCode;

  // Toggle button active states
  chatModeBtn.classList.toggle('active', !isCode);
  codeModeBtn.classList.toggle('active', isCode);

  // Lazy-init the code view on first switch
  if (isCode && !codeView) {
    codeView = new CodeView(codeViewContainer, client);
    codeView.init();
  }

  if (isCode && codeView) {
    codeView.setVisible(true);
  }
}

chatModeBtn.addEventListener('click', () => setViewMode('chat'));
codeModeBtn.addEventListener('click', () => setViewMode('code'));

// ------------------------------------------------------------------ Boot
function boot() {
  buildSidebar();
  activeLabel.textContent = selectedAgent.label;
  exampleBanner.hidden = true;
  initConnection();
}

// ------------------------------------------------------------------ Init
/**
 * Session-start orchestration:
 *   1. Prime CSRF cookie + cached token.
 *   2. Probe auth providers so we know which buttons to show.
 *   3. Surface the "?error=not_authorized" banner if present.
 *   4. GET /api/auth/me. If 200 → boot the app. If 401 → show the modal.
 */
(async function init() {
  handleLoginError();
  await primeCsrf();
  await applyProviderVisibility();
  try {
    currentUser = await getMe();
  } catch (err) {
    console.error('[auth] me() failed:', err);
    currentUser = null;
  }

  if (currentUser) {
    hideAuth();
    updateAuthUI();
    initAdmin(currentUser);
    initMail(currentUser);
    boot();
  } else {
    updateAuthUI();
    showAuth();
  }
})();
