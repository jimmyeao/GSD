/**
 * Code View orchestrator — manages the IDE layout with file tree,
 * editor, and terminal panels.
 */

import { Editor } from './editor.js';
import { FileTree } from './fileTree.js';
import { Terminal } from './terminal.js';
import { isSupported as voiceSupported, createRecognition, speak, stopSpeaking, isSpeaking } from './voice.js';

export class CodeView {
  /**
   * @param {HTMLElement} containerEl - main container div
   * @param {string} backendUrl
   * @param {string} token
   * @param {object} socketClient - SocketClient instance for container logs
   */
  constructor(containerEl, backendUrl, token, socketClient) {
    this._root = containerEl;
    this._url = backendUrl;
    this._token = token;
    this._socket = socketClient;
    this._visible = false;
    this._projectId = null;
    this._containerId = null;
    this._editor = null;
    this._fileTree = null;
    this._terminal = null;
    this._logHandler = null;
    this._chatHistory = [];
    this._chatStreamEl = null;
    this._chatStreamBuffer = '';
    this._terminalLog = [];
    this._composeMode = false;
    this._composeServices = [];
  }

  /** Initialize all sub-components and set up the layout. */
  async init() {
    this._buildDOM();
    await this._editor.init();
    this._wireEvents();
    await this._loadProjects();
  }

  /** Load a project into the code view. */
  async loadProject(projectId, projectName) {
    this._projectId = projectId;
    this._terminal.clear();
    this._terminal.appendOutput(`Loaded project: ${projectName}`);
    await this._fileTree.load(projectId);
  }

  /** Show/hide the code view. */
  setVisible(visible) {
    this._visible = visible;
    this._wrap.style.display = visible ? 'flex' : 'none';
  }

  /** Whether code view is currently visible. */
  get visible() { return this._visible; }

  /** Destroy and clean up. */
  dispose() {
    if (this._logHandler && this._socket) {
      this._socket.off('container:output', this._logHandler);
    }
    if (this._editor) this._editor.dispose();
    this._wrap?.remove();
  }

  // ── private ──────────────────────────────────────────────────────

  _el(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
  }

  _buildDOM() {
    this._wrap = this._el('div', 'code-view');
    this._wrap.style.display = 'none';

    // Toolbar
    const toolbar = this._el('div', 'code-toolbar');
    this._projectSelect = this._el('select', 'project-select');
    this._runBtn = this._el('button', 'run-btn', 'Run');
    this._stopBtn = this._el('button', 'stop-btn', 'Stop');
    this._stopBtn.disabled = true;
    const termToggle = this._el('button', 'term-toggle-btn', 'Terminal');
    termToggle.addEventListener('click', () => {
      const vis = this._terminalDiv.style.display !== 'none';
      this._terminal.setVisible(!vis);
    });
    this._newProjectBtn = this._el('button', 'new-project-btn', '+ Project');
    this._newProjectBtn.addEventListener('click', () => this._createProject());

    this._restartBtn = this._el('button', 'restart-btn', 'Restart');
    this._restartBtn.disabled = true;
    this._previewBtn = this._el('button', 'preview-btn', 'Preview');
    this._previewBtn.disabled = true;
    this._envBtn = this._el('button', 'env-btn', 'Env Vars');

    // Services status bar (shown below toolbar when compose is running)
    this._servicesBar = this._el('div', 'services-bar');
    this._servicesBar.hidden = true;

    [this._projectSelect, this._newProjectBtn, this._runBtn, this._restartBtn, this._stopBtn, this._previewBtn, this._envBtn, termToggle].forEach(c => toolbar.appendChild(c));
    this._wrap.appendChild(toolbar);
    this._wrap.insertBefore(this._servicesBar, this._wrap.children[1]);

    // Layout: sidebar + main (editor + terminal)
    const layout = this._el('div', 'code-layout');
    this._sidebarDiv = this._el('div', 'code-sidebar');
    const main = this._el('div', 'code-main');
    this._editorDiv = this._el('div', 'code-editor');
    this._terminalDiv = this._el('div', 'code-terminal');
    main.append(this._editorDiv, this._terminalDiv);

    // Chat panel
    this._chatPanel = this._el('div', 'code-chat');
    const chatHeader = this._el('div', 'code-chat-header', 'CoderAgent');
    this._chatMessages = this._el('div', 'code-chat-messages');
    const chatInputRow = this._el('div', 'code-chat-input-row');
    this._chatInput = document.createElement('textarea');
    this._chatInput.className = 'code-chat-textarea';
    this._chatInput.placeholder = 'Ask CoderAgent to write code...';
    this._chatInput.rows = 2;
    this._chatSendBtn = this._el('button', 'code-chat-send', 'Send');
    this._chatMicBtn = this._el('button', 'mic-btn', '🎤');
    this._chatMicBtn.title = 'Voice input';
    this._chatSpeakBtn = this._el('button', 'speak-toggle', '🔊');
    this._chatSpeakBtn.title = 'Auto-speak responses';
    chatInputRow.append(this._chatMicBtn, this._chatInput, this._chatSpeakBtn, this._chatSendBtn);
    this._chatPanel.append(chatHeader, this._chatMessages, chatInputRow);

    layout.append(this._sidebarDiv, main, this._chatPanel);
    this._wrap.appendChild(layout);
    this._root.appendChild(this._wrap);

    // Create sub-components
    this._editor = new Editor(this._editorDiv);
    this._fileTree = new FileTree(this._sidebarDiv, this._url, this._token);
    this._terminal = new Terminal(this._terminalDiv);
    // Intercept terminal output so CoderAgent can see it
    const origAppend = this._terminal.appendOutput.bind(this._terminal);
    this._terminal.appendOutput = (text) => {
      origAppend(text);
      this._terminalLog.push(text);
      if (this._terminalLog.length > 200) this._terminalLog.shift();
    };
  }

  _wireEvents() {
    // File tree → open in editor
    this._fileTree.onSelect(async ({ path, name }) => {
      try {
        const res = await this._apiFetch(
          `/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();
        this._editor.openFile(path, data.content || '');
      } catch (err) {
        this._terminal.appendOutput(`Error opening ${name}: ${err.message}`);
      }
    });

    // File tree → create file/folder
    this._fileTree.onCreateFile(async ({ path, type }) => {
      try {
        await this._apiFetch(
          `/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`,
          { method: 'POST', body: JSON.stringify({ type, content: type === 'file' ? '' : undefined }) }
        );
        this._terminal.appendOutput(`Created ${type}: ${path}`);
        await this._fileTree.refresh();
      } catch (err) {
        this._terminal.appendOutput(`Error creating ${path}: ${err.message}`);
      }
    });

    // File tree → rename
    this._fileTree.onRename(async ({ path, oldName, newName }) => {
      try {
        await this._apiFetch(
          `/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`,
          { method: 'PATCH', body: JSON.stringify({ newName }) }
        );
        this._editor.closeFile(path);
        this._terminal.appendOutput(`Renamed: ${oldName} → ${newName}`);
        await this._fileTree.refresh();
      } catch (err) {
        this._terminal.appendOutput(`Rename failed: ${err.message}`);
      }
    });

    // File tree → delete
    this._fileTree.onDelete(async ({ path, type }) => {
      try {
        await this._apiFetch(
          `/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`,
          { method: 'DELETE' }
        );
        this._editor.closeFile(path);
        this._terminal.appendOutput(`Deleted: ${path}`);
        await this._fileTree.refresh();
      } catch (err) {
        this._terminal.appendOutput(`Delete failed: ${err.message}`);
      }
    });

    // Ctrl+S → save file
    this._editor.onSave(async ({ path, content }) => {
      try {
        await this._apiFetch(
          `/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`,
          { method: 'PUT', body: JSON.stringify({ content }) }
        );
        this._terminal.appendOutput(`Saved: ${path}`);
      } catch (err) {
        this._terminal.appendOutput(`Save failed: ${err.message}`);
      }
    });

    this._projectSelect.addEventListener('change', () => {
      const opt = this._projectSelect.selectedOptions[0];
      if (opt && opt.value) this.loadProject(opt.value, opt.textContent);
    });
    this._runBtn.addEventListener('click', () => this._smartRun());
    this._stopBtn.addEventListener('click', () => this._stopAll());

    this._previewBtn.addEventListener('click', () => this._openPreview());
    this._envBtn.addEventListener('click', () => this._toggleEnvPanel());

    this._terminal.onDiagnose(() => {
      const output = this._terminalLog.slice(-80).join('\n');
      if (!output.trim()) { this._terminal.appendOutput('No terminal output to diagnose.'); return; }
      this._chatInput.value = `Diagnose the following terminal output and fix any errors:\n\n${output}`;
      this._sendCodeMessage();
    });

    this._terminal.onCommand(async (cmd) => {
      if (!this._containerId) { this._terminal.appendOutput('No running container. Click Run first.'); return; }
      try {
        const res = await this._apiFetch(`/sandbox/${this._containerId}/exec`, {
          method: 'POST', body: JSON.stringify({ cmd }),
        });
        const data = await res.json();
        if (data.output) this._terminal.appendOutput(data.output);
        if (data.exitCode !== 0) this._terminal.appendOutput(`Exit code: ${data.exitCode}`);
      } catch (err) { this._terminal.appendOutput(`Exec error: ${err.message}`); }
    });

    this._logHandler = ({ containerId, data }) => {
      if (containerId === this._containerId) this._terminal.appendOutput(data);
    };
    if (this._socket?.socket) this._socket.socket.on('container:output', this._logHandler);

    this._restartBtn.addEventListener('click', () => this._restartProject());

    // Build socket events
    if (this._socket?.socket) {
      this._socket.socket.on('build:log', ({ data }) => this._terminal.appendOutput(data.replace(/\n$/, '')));
      this._socket.socket.on('build:done', ({ tag }) => {
        this._terminal.appendOutput(`\nBuild complete: ${tag}`);
        this._builtTag = tag;
        // Auto-run container from built image
        this._runContainerWithImage(tag);
      });
      this._socket.socket.on('build:error', ({ error }) => {
        this._terminal.appendOutput(`\nBuild failed: ${error}`);
        this._setRunning(false);
      });
    }

    // Compose socket events
    if (this._socket?.socket) {
      this._socket.socket.on('compose:log', ({ data }) => {
        this._terminal.appendOutput(data.replace(/\n$/, ''));
      });

      this._socket.socket.on('compose:done', ({ projectName, services }) => {
        this._composeMode = true;
        this._composeServices = services || [];
        this._setRunning(true);
        this._terminal.appendOutput(`\nAll services running`);
        this._renderServicesBar();
        if (this._socket?.socket) {
          this._socket.socket.emit('compose:logs', { projectId: this._projectId });
        }
      });

      this._socket.socket.on('compose:error', ({ error }) => {
        this._terminal.appendOutput(`\nCompose error: ${error}`);
        this._setRunning(false);
      });

      this._socket.socket.on('compose:stopped', () => {
        this._composeMode = false;
        this._composeServices = [];
        this._servicesBar.hidden = true;
        this._setRunning(false);
        this._terminal.appendOutput('\nAll services stopped.');
      });
    }

    // Chat voice
    this._chatAutoSpeak = false;
    if (voiceSupported().recognition) {
      this._chatRecognition = createRecognition({
        onResult: (text) => { this._chatInput.value += text; },
        onInterim: (text) => { this._chatInput.placeholder = text || 'Listening...'; },
        onComplete: (text) => {
          this._chatInput.value = text;
          setTimeout(() => this._sendCodeMessage(), 300);
        },
        onEnd: () => { this._chatMicBtn.classList.remove('mic-active'); this._chatInput.placeholder = 'Ask CoderAgent to write code...'; },
        onError: (msg) => this._terminal.appendOutput(`Voice: ${msg}`),
      });
      this._chatMicBtn.addEventListener('click', () => {
        if (this._chatRecognition.isActive) { this._chatRecognition.stop(); }
        else {
          if (isSpeaking()) stopSpeaking(); // interrupt Alice
          this._chatRecognition.start(); this._chatMicBtn.classList.add('mic-active');
        }
      });
    } else { this._chatMicBtn.disabled = true; }

    this._chatSpeakBtn.addEventListener('click', () => {
      this._chatAutoSpeak = !this._chatAutoSpeak;
      this._chatSpeakBtn.classList.toggle('speak-active', this._chatAutoSpeak);
      if (!this._chatAutoSpeak) stopSpeaking();
    });

    // Chat send
    this._chatSendBtn.addEventListener('click', () => this._sendCodeMessage());
    this._chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendCodeMessage(); }
    });

    // Socket events for code chat
    if (this._socket?.socket) {
      this._socket.socket.on('code:token', ({ token }) => {
        if (!this._chatStreamEl) {
          this._chatStreamEl = this._addChatBubble('assistant', '');
        }
        this._chatStreamBuffer += token;
        this._chatStreamEl.innerHTML = this._escapeHtml(this._chatStreamBuffer).replace(/\n/g, '<br>');
        this._chatMessages.scrollTop = this._chatMessages.scrollHeight;
      });

      this._socket.socket.on('code:file-written', async ({ path, language }) => {
        this._terminal.appendOutput(`Auto-saved: ${path}`);
        await this._fileTree.refresh();
        try {
          const res = await this._apiFetch(`/workspace/${this._projectId}/file?path=${encodeURIComponent(path)}`);
          const data = await res.json();
          this._editor.openFile(path, data.content || '');
        } catch { /* ignore */ }
      });

      this._socket.socket.on('code:done', () => {
        if (this._chatStreamEl && this._chatStreamBuffer) {
          if (window.marked) {
            this._chatStreamEl.innerHTML = marked.parse(this._chatStreamBuffer);
          }
          this._chatHistory.push({ role: 'assistant', content: this._chatStreamBuffer });
          if (this._chatAutoSpeak) speak(this._chatStreamBuffer);
        }
        this._chatStreamEl = null; this._chatStreamBuffer = '';
        this._chatSendBtn.disabled = false; this._chatInput.disabled = false;
      });
      this._socket.socket.on('code:error', ({ message }) => {
        this._addChatBubble('error', message);
        this._chatStreamEl = null; this._chatStreamBuffer = '';
        this._chatSendBtn.disabled = false; this._chatInput.disabled = false;
      });
    }
  }

  async _loadProjects() {
    try {
      const res = await this._apiFetch('/workspace/projects');
      const data = await res.json();
      this._projectSelect.innerHTML = '<option value="">Select project...</option>';
      const projects = data.projects || [];
      projects.forEach(p => {
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; this._projectSelect.appendChild(o);
      });
      console.log(`[CodeView] Loaded ${projects.length} projects`);
    } catch (err) {
      console.error('[CodeView] Failed to load projects:', err);
      this._terminal?.appendOutput?.(`Failed to load projects: ${err.message}`);
    }
  }

  async _createProject() {
    const name = prompt('Project name:');
    if (!name?.trim()) return;
    try {
      const res = await this._apiFetch('/workspace/projects', {
        method: 'POST', body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      this._terminal.appendOutput(`Created project: ${data.project.name}`);
      await this._loadProjects();
      this._projectSelect.value = data.project.id;
      this.loadProject(data.project.id, data.project.name);
    } catch (err) { this._terminal.appendOutput(`Create failed: ${err.message}`); }
  }

  // ── Smart Run: auto-detects compose/dockerfile/runtime ──────────

  async _smartRun() {
    if (!this._projectId) { this._terminal.appendOutput('Select a project first.'); return; }
    this._terminal.clear();
    this._terminal.appendOutput('Detecting project type...');
    this._setBusy(true, 'Detecting...');

    try {
      const res = await this._apiFetch(`/workspace/${this._projectId}/detect`);
      const info = await res.json();
      this._terminal.appendOutput(`Detected: ${info.type}`);

      if (info.type === 'compose') {
        this._setBusy(true, 'Composing...');
        this._terminal.appendOutput('Found docker-compose.yml — building & starting all services...');
        this._socket.socket.emit('compose:up', { projectId: this._projectId });
      } else if (info.type === 'dockerfile') {
        this._setBusy(true, 'Building...');
        this._terminal.appendOutput('Found Dockerfile — building image...');
        this._socket.socket.emit('build:start', { projectId: this._projectId });
        // build:done handler will auto-call _runContainerWithImage
      } else {
        // node, python, go, unknown — use base image + auto-install + auto-start
        const image = info.image || 'node:20-slim';
        this._setBusy(true, 'Pulling...');
        this._terminal.appendOutput(`Using ${image}...`);
        await this._runContainerWithImage(image, info.install, info.start);
      }
    } catch (err) {
      this._terminal.appendOutput(`Run failed: ${err.message}`);
      this._setRunning(false);
    }
  }

  async _runContainerWithImage(image, installCmd, startCmd) {
    try {
      const res = await this._apiFetch('/sandbox', {
        method: 'POST', body: JSON.stringify({ projectId: this._projectId, image }),
      });
      const data = await res.json();
      this._containerId = data.container?.id;
      this._terminal.appendOutput(`Container created: ${data.container?.name || this._containerId}`);

      await this._apiFetch(`/sandbox/${this._containerId}/start`, { method: 'POST' });
      this._terminal.appendOutput('Container started.');

      // Show port mappings
      try {
        const portsRes = await this._apiFetch(`/sandbox/${this._containerId}/ports`);
        const portsData = await portsRes.json();
        if (portsData.ports?.length) {
          portsData.ports.forEach(p => {
            this._terminal.appendOutput(`Port ${p.container} → http://${window.location.hostname}:${p.host}`);
          });
        }
      } catch { /* ignore */ }

      this._setRunning(true);
      if (this._socket?.socket) this._socket.socket.emit('container:logs', { containerId: this._containerId });

      // Auto-install and start
      if (installCmd) {
        this._terminal.appendOutput(`\nInstalling dependencies: ${installCmd}`);
        try {
          const r = await this._apiFetch(`/sandbox/${this._containerId}/exec`, {
            method: 'POST', body: JSON.stringify({ cmd: installCmd }),
          });
          const d = await r.json();
          if (d.output) this._terminal.appendOutput(d.output);
        } catch (err) { this._terminal.appendOutput(`Install error: ${err.message}`); }
      }
      if (startCmd) {
        this._terminal.appendOutput(`\nStarting app: ${startCmd}`);
        try {
          // Run start command in background (don't await — it's a long-running process)
          this._apiFetch(`/sandbox/${this._containerId}/exec`, {
            method: 'POST', body: JSON.stringify({ cmd: `${startCmd} &` }),
          }).then(r => r.json()).then(d => { if (d.output) this._terminal.appendOutput(d.output); }).catch(() => {});
        } catch { /* ignore */ }
      }
    } catch (err) {
      this._terminal.appendOutput(`Container failed: ${err.message}`);
      this._setRunning(false);
    }
  }

  async _stopAll() {
    this._terminal.appendOutput('Stopping...');
    if (this._composeMode) {
      this._socket?.socket?.emit('compose:down', { projectId: this._projectId });
    }
    if (this._containerId) {
      try {
        await this._apiFetch(`/sandbox/${this._containerId}/stop`, { method: 'POST' });
      } catch { /* ignore */ }
      this._containerId = null;
    }
    this._setRunning(false);
    this._composeMode = false;
    this._composeServices = [];
    this._servicesBar.hidden = true;
  }

  async _restartProject() {
    this._terminal.appendOutput('Restarting...');
    await this._stopAll();
    await new Promise(r => setTimeout(r, 1000));
    await this._smartRun();
  }

  _setBusy(busy, label = 'Working...') {
    this._runBtn.disabled = busy;
    this._runBtn.textContent = busy ? label : 'Run';
    if (busy) this._runBtn.classList.add('btn-busy');
    else this._runBtn.classList.remove('btn-busy');
  }

  _setRunning(running) {
    this._runBtn.disabled = running;
    this._runBtn.textContent = 'Run';
    this._runBtn.classList.remove('btn-busy');
    this._stopBtn.disabled = !running;
    this._restartBtn.disabled = !running;
    this._previewBtn.disabled = !running;
  }

  _renderServicesBar() {
    this._servicesBar.innerHTML = '';
    this._servicesBar.hidden = false;
    if (!this._composeServices.length) { this._servicesBar.hidden = true; return; }
    const label = this._el('span', 'services-label', 'Services:');
    this._servicesBar.appendChild(label);
    this._composeServices.forEach(svc => {
      const pill = this._el('span', 'service-pill');
      const isRunning = (svc.State || '').toLowerCase() === 'running';
      pill.classList.add(isRunning ? 'service-running' : 'service-stopped');
      const name = svc.Service || svc.Name || 'unknown';
      const ports = svc.Ports || '';
      pill.innerHTML = `<span class="service-dot"></span> ${this._escapeHtml(name)}`;
      if (ports) pill.title = ports;
      const portMatch = ports.match(/0\.0\.0\.0:(\d+)/);
      if (portMatch && isRunning) {
        pill.style.cursor = 'pointer';
        pill.addEventListener('click', () => {
          const hostPort = portMatch[1];
          window.open(`http://${window.location.hostname}:${hostPort}`, '_blank');
          this._terminal.appendOutput(`Preview: http://${window.location.hostname}:${hostPort}`);
        });
      }
      this._servicesBar.appendChild(pill);
    });
  }

  _openPreview() {
    if (!this._containerId && !this._composeMode) {
      this._terminal.appendOutput('No running services. Click Run first.');
      return;
    }
    const port = prompt('Port to preview:', '3000');
    if (!port) return;
    if (this._containerId) {
      window.open(`${this._url}/preview/${this._containerId}/?port=${port}`, '_blank');
    } else {
      window.open(`http://${window.location.hostname}:${port}`, '_blank');
    }
    this._terminal.appendOutput(`Preview opened: port ${port}`);
  }

  async _toggleEnvPanel() {
    if (!this._projectId) { this._terminal.appendOutput('Select a project first.'); return; }
    if (this._envPanel && !this._envPanel.hidden) { this._envPanel.hidden = true; return; }
    if (!this._envPanel) {
      this._envPanel = this._el('div', 'env-panel');
      this._envPanel.innerHTML = '<div class="env-panel-header"><span>Environment Variables</span>' +
        '<button class="env-close-btn">Close</button></div><div class="env-panel-body">' +
        '<div class="env-rows"></div><button class="env-add-btn">+ Add Variable</button></div>' +
        '<div class="env-panel-footer"><button class="env-save-btn">Save</button></div>';
      this._wrap.appendChild(this._envPanel);
      this._envPanel.querySelector('.env-close-btn').addEventListener('click', () => { this._envPanel.hidden = true; });
      this._envPanel.querySelector('.env-add-btn').addEventListener('click', () => { this._addEnvRow('', ''); });
      this._envPanel.querySelector('.env-save-btn').addEventListener('click', () => this._saveEnvVars());
    }
    try {
      const res = await this._apiFetch(`/workspace/projects/${this._projectId}/env`);
      const data = await res.json();
      const rows = this._envPanel.querySelector('.env-rows');
      rows.innerHTML = '';
      const env = data.env || {};
      if (Object.keys(env).length === 0) this._addEnvRow('', '');
      else Object.entries(env).forEach(([k, v]) => this._addEnvRow(k, v));
    } catch (err) { this._terminal.appendOutput(`Failed to load env vars: ${err.message}`); return; }
    this._envPanel.hidden = false;
  }

  _addEnvRow(key, value) {
    const rows = this._envPanel.querySelector('.env-rows');
    const row = this._el('div', 'env-row');
    row.innerHTML = `<input class="env-key" type="text" placeholder="KEY" value="${this._escapeHtml(key)}" />` +
      `<span class="env-eq">=</span><input class="env-value" type="text" placeholder="value" value="${this._escapeHtml(value)}" />` +
      `<button class="env-remove-btn" title="Remove">x</button>`;
    row.querySelector('.env-remove-btn').addEventListener('click', () => row.remove());
    rows.appendChild(row);
  }

  async _saveEnvVars() {
    const rows = this._envPanel.querySelectorAll('.env-row');
    const env = {};
    rows.forEach(row => {
      const k = row.querySelector('.env-key').value.trim();
      if (k) env[k] = row.querySelector('.env-value').value;
    });
    try {
      await this._apiFetch(`/workspace/projects/${this._projectId}/env`, {
        method: 'PUT', body: JSON.stringify({ env }),
      });
      this._terminal.appendOutput('Environment variables saved.');
      this._envPanel.hidden = true;
    } catch (err) { this._terminal.appendOutput(`Save env failed: ${err.message}`); }
  }

  _sendCodeMessage() {
    const content = this._chatInput.value.trim();
    if (!content || !this._projectId) return;

    // Use the SocketClient's connected flag — more reliable than raw socket check
    if (!this._socket?.connected || !this._socket?.socket) {
      this._terminal.appendOutput('Not connected to backend — retrying...');
      return;
    }

    this._addChatBubble('user', content);
    this._chatHistory.push({ role: 'user', content });
    this._chatInput.value = '';
    this._chatSendBtn.disabled = true;
    this._chatInput.disabled = true;

    // Include recent terminal output so CoderAgent can see errors/logs
    const termContext = this._terminalLog.length
      ? `\n\n[Terminal output (last ${Math.min(this._terminalLog.length, 50)} lines)]:\n${this._terminalLog.slice(-50).join('\n')}`
      : '';

    this._socket.socket.emit('code:message', {
      content: content + termContext,
      projectId: this._projectId,
      history: this._chatHistory.slice(-10),
    });
  }

  _addChatBubble(role, text) {
    const bubble = this._el('div', `code-chat-msg code-chat-${role}`);
    if (role === 'error') {
      bubble.textContent = `Error: ${text}`;
    } else if (role === 'user') {
      bubble.textContent = text;
    } else {
      bubble.innerHTML = text ? (window.marked ? marked.parse(text) : this._escapeHtml(text).replace(/\n/g, '<br>')) : '';
    }
    this._chatMessages.appendChild(bubble);
    this._chatMessages.scrollTop = this._chatMessages.scrollHeight;
    return bubble;
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async _apiFetch(path, opts = {}) {
    const headers = {
      'Authorization': `Bearer ${this._token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    };
    const res = await fetch(`${this._url}${path}`, { ...opts, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res;
  }
}
