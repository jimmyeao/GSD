import { AGENTS, MODEL_BADGE_CLASS } from './agents.js';
import { SocketClient } from './socketClient.js';
import { Chat } from './chat.js';
import { CodeView } from './codeView.js';
import { getToken, getUser, isLoggedIn, login, register, logout, clearToken } from './auth.js';
import { fetchConversations, fetchMessages, deleteConversation } from './conversations.js';
import { fetchAssets, deleteAsset } from './assets.js';
import { isSupported as voiceSupported, createRecognition, speak, stopSpeaking, isSpeaking, setTTSBackend } from './voice.js';

// ------------------------------------------------------------------ State
let selectedAgent = AGENTS[0]; // RouterAgent default
let client = null;
let codeView = null;
let isStreaming = false;
let _optimiseTimer = null;
let attachedFiles = []; // [{ name, content }]
let currentConversationId = null;
let conversations = [];

// Derive the backend URL from whatever hostname the browser is using,
// so Tailscale / remote access works without manual configuration.
const DEFAULT_URL = `${window.location.protocol}//${window.location.hostname}:5000`;
setTTSBackend(DEFAULT_URL);

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
const authForm       = document.getElementById('auth-form');
const authUsername    = document.getElementById('auth-username');
const authPassword   = document.getElementById('auth-password');
const authSubmit     = document.getElementById('auth-submit');
const authError      = document.getElementById('auth-error');
const authSwitch     = document.getElementById('auth-switch');
const authToggleText = document.getElementById('auth-toggle-text');
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
      if (isSpeaking()) stopSpeaking();
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
      // Start speaking whatever has been streamed so far
      speak(chat._streamBuffer);
    } else if (chat.history.length) {
      // Speak the last assistant message
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
      const token = getToken();
      await fetch(`${DEFAULT_URL}/workspace/${codeView._projectId}/file?path=${encodeURIComponent(filename.trim())}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'file', content: code }),
      });
      await codeView._fileTree.refresh();
    } catch { /* ignore — still open in editor */ }
  }
  codeView._editor.openFile(filename.trim(), code);
  setViewMode('code');
});

// ------------------------------------------------------------------ Auth
let authMode = 'login'; // or 'register'

function showAuth() {
  authModal.hidden = false;
  authUsername.focus();
}

function hideAuth() {
  authModal.hidden = true;
  authError.hidden = true;
  authForm.reset();
}

function updateAuthUI() {
  const user = getUser();
  if (user) {
    userLabel.textContent = user.username;
    logoutBtn.hidden = false;
  } else {
    userLabel.textContent = '';
    logoutBtn.hidden = true;
  }
}

authSwitch.addEventListener('click', e => {
  e.preventDefault();
  authMode = authMode === 'login' ? 'register' : 'login';
  authSubmit.textContent = authMode === 'login' ? 'Log in' : 'Register';
  authSwitch.textContent = authMode === 'login' ? 'Register' : 'Log in';
  authToggleText.textContent = authMode === 'login' ? 'No account?' : 'Already have an account?';
  authError.hidden = true;
});

authForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = authUsername.value.trim();
  const password = authPassword.value;
  if (!username || !password) return;

  authSubmit.disabled = true;
  authError.hidden = true;

  try {
    if (authMode === 'login') {
      await login(DEFAULT_URL, username, password);
    } else {
      await register(DEFAULT_URL, username, password);
    }
    hideAuth();
    updateAuthUI();
    boot();
  } catch (err) {
    authError.textContent = err.message;
    authError.hidden = false;
  } finally {
    authSubmit.disabled = false;
  }
});

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
  const token = getToken();
  if (!token) return;
  try {
    conversations = await fetchConversations(DEFAULT_URL, token);
    renderConversationList();
  } catch (err) {
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
        await deleteConversation(DEFAULT_URL, getToken(), conv.id);
        conversations = conversations.filter(c => c.id !== conv.id);
        if (currentConversationId === conv.id) startNewChat();
        renderConversationList();
      } catch (err) {
        chat.addErrorMessage(err.message);
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

  try {
    const messages = await fetchMessages(DEFAULT_URL, getToken(), convId);
    messages.forEach(msg => {
      chat.addRestoredMessage(msg.role, msg.content, msg.agent_id);
    });
  } catch (err) {
    chat.addErrorMessage('Failed to load conversation');
  }
  inputEl.focus();
}

function startNewChat() {
  currentConversationId = null;
  chat.clear();
  renderConversationList();
  inputEl.focus();
}

// ------------------------------------------------------------------ Assets panel
const ASSET_ICONS = { video: '🎬', image: '🖼', slide: '📊' };

async function loadAssets() {
  const token = getToken();
  if (!token) return;
  try {
    const assets = await fetchAssets(DEFAULT_URL, token);
    renderAssets(assets);
  } catch (err) {
    console.error('[assets] load failed:', err.message);
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
    const token = getToken();
    const fileUrl = `${DEFAULT_URL}/assets/${asset.id}/file?token=${encodeURIComponent(token)}`;

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
        await deleteAsset(DEFAULT_URL, getToken(), asset.id);
        card.remove();
        if (!assetsGrid.children.length) assetsEmpty.hidden = false;
      } catch (err) {
        console.error('[assets] delete failed:', err.message);
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

  const token = getToken();
  setStatus('connecting', 'Connecting…');
  client = new SocketClient(url || DEFAULT_URL, token);

  client.on('statusChange', ({ connected, reason }) => {
    if (connected) {
      setStatus('online', 'Connected');
      loadConversations();
    } else {
      setStatus('offline', reason ? `Disconnected: ${reason}` : 'Disconnected');
    }
  });

  client.on('connectionError', ({ message }) => {
    // If auth fails, clear token and force re-login
    const msg = (message || '').toLowerCase();
    if (msg.includes('auth') || msg.includes('token') || msg.includes('expired')) {
      clearToken();
      updateAuthUI();
      showAuth();
      setStatus('offline', 'Session expired — please log in again');
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
  });

  client.on('done', () => {
    try { chat.finaliseStream(); } catch (e) { console.error('[done] finaliseStream error:', e); }
    setStreaming(false);
    // Auto-speak the response if enabled
    if (autoSpeak && chat.history.length) {
      const last = chat.history[chat.history.length - 1];
      if (last.role === 'assistant') speak(last.content);
    }
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

  client.connect();
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
    stopSpeaking();
    return;
  }
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
  const url = urlInput.value.trim() || DEFAULT_URL;
  settingsPanel.hidden = true;
  initConnection(url);
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
  _optimiseTimer = setTimeout(() => setOptimising(false), 35_000);
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
    const token = getToken();
    codeView = new CodeView(codeViewContainer, DEFAULT_URL, token, client);
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
  initConnection(DEFAULT_URL);
}

// Gate on auth
if (isLoggedIn()) {
  hideAuth();
  updateAuthUI();
  boot();
} else {
  showAuth();
}
