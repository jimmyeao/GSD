/**
 * Terminal-like output panel for container logs/exec output.
 */

const MAX_LINES = 1000;

const ANSI_COLORS = {
  '30': '#555',     '31': '#E5173F', '32': '#54B9B3', '33': '#fbbf24',
  '34': '#6a9eff', '35': '#c084fc', '36': '#67e8f9', '37': '#e8eaf0',
  '90': '#8892a4',
};

function parseAnsi(text) {
  // Split on ANSI escape sequences, wrapping colored sections in spans
  const parts = [];
  let current = '';
  let color = null;
  const regex = /\x1b\[(\d+)m/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Flush text before this escape
    const before = text.slice(lastIdx, match.index);
    if (before) {
      parts.push(color
        ? `<span style="color:${color}">${escapeHtml(before)}</span>`
        : escapeHtml(before));
    }
    const code = match[1];
    if (code === '0') {
      color = null;
    } else if (ANSI_COLORS[code]) {
      color = ANSI_COLORS[code];
    }
    lastIdx = regex.lastIndex;
  }

  // Remaining text
  const tail = text.slice(lastIdx);
  if (tail) {
    parts.push(color
      ? `<span style="color:${color}">${escapeHtml(tail)}</span>`
      : escapeHtml(tail));
  }

  return parts.join('');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class Terminal {
  /** @param {HTMLElement} containerEl - div to render into */
  constructor(containerEl) {
    this._root = containerEl;
    this._lineCount = 0;
    this._onCommand = null;
    this._build();
  }

  /** Append output text (supports basic ANSI colors). */
  appendOutput(text) {
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line && lines.length === 1) continue;
      const el = document.createElement('div');
      el.className = 'terminal-line';
      el.innerHTML = parseAnsi(line);
      this._output.appendChild(el);
      this._lineCount++;
    }
    // Trim to MAX_LINES
    while (this._lineCount > MAX_LINES) {
      const first = this._output.querySelector('.terminal-line');
      if (first) { first.remove(); this._lineCount--; }
      else break;
    }
    this._scrollToBottom();
  }

  /** Clear all output. */
  clear() {
    this._output.innerHTML = '';
    this._lineCount = 0;
  }

  /** Register a command input callback (for the input line). */
  onCommand(callback) { this._onCommand = callback; }

  /** Show/hide the panel. */
  setVisible(visible) {
    this._root.style.display = visible ? 'flex' : 'none';
  }

  // ── private ──────────────────────────────────────────────────────

  _build() {
    this._root.classList.add('terminal-panel');
    this._root.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'terminal-header';
    header.innerHTML = '<span class="terminal-title">Terminal</span>';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'terminal-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => this.clear());
    header.appendChild(clearBtn);

    this._root.appendChild(header);

    // Output area
    this._output = document.createElement('div');
    this._output.className = 'terminal-output';
    this._root.appendChild(this._output);

    // Input line
    const inputRow = document.createElement('div');
    inputRow.className = 'terminal-input-row';

    const prefix = document.createElement('span');
    prefix.className = 'terminal-prompt';
    prefix.textContent = '$';
    inputRow.appendChild(prefix);

    this._input = document.createElement('input');
    this._input.className = 'terminal-input';
    this._input.type = 'text';
    this._input.placeholder = 'Enter command...';
    this._input.spellcheck = false;
    this._input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const cmd = this._input.value.trim();
        if (!cmd) return;
        this.appendOutput(`$ ${cmd}`);
        this._input.value = '';
        if (this._onCommand) this._onCommand(cmd);
      }
    });
    inputRow.appendChild(this._input);
    this._root.appendChild(inputRow);
  }

  _scrollToBottom() {
    this._output.scrollTop = this._output.scrollHeight;
  }
}
