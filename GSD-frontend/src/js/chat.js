/**
 * Chat UI manager — handles message rendering, streaming, and history.
 */

export class Chat {
  constructor(containerEl, onSend) {
    this.container = containerEl;
    this.onSend = onSend;
    this.history = [];
    this._streamEl = null;
    this._streamBuffer = '';
    this._emptyState = containerEl.querySelector('#empty-state');
  }

  /** Append a user message bubble. files = [{name}] for display only. */
  addUserMessage(text, files = []) {
    this._hideEmptyState();
    this.history.push({ role: 'user', content: text });
    const el = this._createBubble('user', text);
    if (files.length) {
      const row = document.createElement('div');
      row.className = 'msg-attachments';
      files.forEach(f => {
        const badge = document.createElement('span');
        badge.className = 'file-badge';
        badge.textContent = `📎 ${f.name}`;
        row.appendChild(badge);
      });
      el.appendChild(row);
    }
    this.container.appendChild(el);
    this._scrollToBottom();
  }

  /** Start a streaming assistant bubble. Returns the element. */
  startAssistantStream(agentId) {
    this._streamBuffer = '';
    const el = this._createBubble('assistant', '', agentId);
    this._streamEl = el.querySelector('.bubble-content');
    this._thinkingEl = el.querySelector('.thinking-indicator');
    this.container.appendChild(el);
    this._scrollToBottom();
    return el;
  }

  /** Called when a thinking/reasoning keepalive arrives — show indicator. */
  showThinking() {
    if (this._thinkingEl) this._thinkingEl.hidden = false;
  }

  /** Append a token chunk to the active stream. */
  appendToken(token) {
    if (!this._streamEl) return;
    // Hide thinking indicator the moment real content arrives
    if (this._thinkingEl) this._thinkingEl.hidden = true;
    this._streamBuffer += token;
    this._streamEl.innerHTML = this._renderContent(this._streamBuffer, false);
    this._scrollToBottom();
  }

  /** Finalise the active stream — run full markdown + mermaid render. */
  finaliseStream() {
    if (!this._streamEl) return;
    // Always hide the thinking indicator — it may still be visible if no
    // content tokens arrived (e.g. pure-thinking response or image generation)
    if (this._thinkingEl) {
      this._thinkingEl.hidden = true;
      this._thinkingEl = null;
    }
    let finalHtml;
    try {
      finalHtml = this._renderContent(this._streamBuffer, true);
    } catch (_) {
      finalHtml = this._escapeHtml(this._streamBuffer).replace(/\n/g, '<br>');
    }
    this._streamEl.innerHTML = finalHtml;
    this.history.push({ role: 'assistant', content: this._streamBuffer });
    this._streamBuffer = '';
    this._streamEl = null;
    this._renderMermaid();
    this._scrollToBottom();
  }

  /** Render a previously saved message (for loading conversation history). */
  addRestoredMessage(role, content, agentId = null) {
    this._hideEmptyState();
    this.history.push({ role, content });
    const el = this._createBubble(role, content, agentId);
    this.container.appendChild(el);
    this._renderMermaid();
    this._scrollToBottom();
  }

  /** Show an inline error message in the chat. */
  addErrorMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-error';
    el.textContent = `Error: ${text}`;
    this.container.appendChild(el);
    this._scrollToBottom();
  }

  /** Show a system / status message (e.g. "Routed to CoderAgent"). */
  addStatusMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-status';
    el.textContent = text;
    this.container.appendChild(el);
    this._scrollToBottom();
  }

  /** Clear all messages and history. */
  clear() {
    // Remove all children except the empty state element
    Array.from(this.container.children).forEach(child => {
      if (child.id !== 'empty-state') child.remove();
    });
    this.history = [];
    this._streamEl = null;
    this._streamBuffer = '';
    if (this._emptyState) this._emptyState.hidden = false;
  }

  // ------------------------------------------------------------------ private

  _hideEmptyState() {
    if (this._emptyState) this._emptyState.hidden = true;
  }

  _createBubble(role, text, agentId = null) {
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${role}`;

    const header = document.createElement('div');
    header.className = 'msg-header';
    header.textContent = role === 'user' ? 'You' : (agentId || 'Assistant');
    wrap.appendChild(header);

    if (role === 'assistant') {
      const thinking = document.createElement('div');
      thinking.className = 'thinking-indicator';
      thinking.hidden = true;
      thinking.innerHTML = '<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-label">Thinking…</span>';
      wrap.appendChild(thinking);
    }

    const content = document.createElement('div');
    content.className = 'bubble-content';
    if (text) content.innerHTML = this._renderContent(text, true);
    wrap.appendChild(content);

    return wrap;
  }

  _renderContent(text, finalise) {
    if (!text) return '<span class="cursor-blink">▌</span>';

    // Detect if the entire response is a mermaid block
    const mermaidMatch = text.match(/```mermaid\s*([\s\S]*?)```/);
    if (mermaidMatch) {
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return `<div class="mermaid" id="${id}">${mermaidMatch[1].trim()}</div>`;
    }

    // Detect image URL returned by ImageAgent
    const imgMatch = text.match(/!\[.*?\]\((https?:\/\/\S+|\/\S+)\)/);
    if (imgMatch) {
      const rendered = window.marked ? marked.parse(text) : this._escapeHtml(text);
      return rendered;
    }

    if (finalise && window.marked) {
      return marked.parse(text);
    }

    // During streaming just do lightweight escaping to avoid XSS
    return this._escapeHtml(text).replace(/\n/g, '<br>') + '<span class="cursor-blink">▌</span>';
  }

  _renderMermaid() {
    if (window.mermaid) {
      try {
        mermaid.run({ querySelector: '.bubble-content .mermaid' });
      } catch (e) {
        // mermaid parse errors — leave as-is
      }
    }
  }

  _escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
