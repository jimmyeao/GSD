/**
 * Socket.IO client wrapper for GSD backend.
 *
 * Expected backend events:
 *   Emit   → 'message'  { agent: string, content: string, history?: array }
 *   Listen ← 'token'    { token: string }           (streaming chunk)
 *   Listen ← 'done'     { agent: string }            (stream complete)
 *   Listen ← 'error'    { message: string }          (error from backend)
 *   Listen ← 'routed'   { agent: string }            (RouterAgent picked this agent)
 */

export class SocketClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.socket = null;
    this.connected = false;
    this._handlers = {};
  }

  connect() {
    if (this.socket) this.disconnect();

    // io() is loaded via Socket.IO CDN in index.html
    this.socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      auth: { token: this.token },
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this._emit('statusChange', { connected: true });
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this._emit('statusChange', { connected: false, reason });
    });

    this.socket.on('connect_error', (err) => {
      this.connected = false;
      this._emit('statusChange', { connected: false, reason: err.message });
      this._emit('connectionError', { message: err.message });
    });

    this.socket.on('token', (data) => {
      this._emit('token', data);
    });

    this.socket.on('thinking', (data) => {
      this._emit('thinking', data);
    });

    this.socket.on('done', (data) => {
      this._emit('done', data);
    });

    this.socket.on('error', (data) => {
      this._emit('serverError', data);
    });

    this.socket.on('routed', (data) => {
      this._emit('routed', data);
    });

    this.socket.on('optimised', (data) => {
      this._emit('optimised', data);
    });

    this.socket.on('conversation:created', (data) => {
      this._emit('conversationCreated', data);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  sendMessage(agent, content, history = [], conversationId = null, imageData = null) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to backend.');
    }
    const payload = { agent, content, history, conversationId };
    if (imageData) payload.imageData = imageData;
    this.socket.emit('message', payload);
  }

  optimisePrompt(content, agent) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to backend.');
    }
    this.socket.emit('optimise', { content, agent });
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  }

  off(event, handler) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(h => h !== handler);
  }

  _emit(event, data) {
    (this._handlers[event] || []).forEach(h => h(data));
  }
}
