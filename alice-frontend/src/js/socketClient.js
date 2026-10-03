/**
 * Socket.IO client wrapper for Alice backend.
 *
 * Uses same-origin cookie auth — the session cookie (alice_session) is sent
 * automatically with the handshake when withCredentials is true.
 *
 * Expected backend events:
 *   Emit   → 'message'  { agent: string, content: string, history?: array }
 *   Listen ← 'token'    { token: string }           (streaming chunk)
 *   Listen ← 'done'     { agent: string }            (stream complete)
 *   Listen ← 'error'    { message: string }          (error from backend)
 *   Listen ← 'routed'   { agent: string }            (RouterAgent picked this agent)
 */

export class SocketClient {
  /**
   * @param {string} [url] — optional explicit URL; if omitted, socket.io-client
   *   defaults to the current origin (which is what we want behind NGINX).
   */
  constructor(url) {
    this.url = url || '';
    this.socket = null;
    this.connected = false;
    this._handlers = {};
  }

  connect() {
    if (this.socket) this.disconnect();

    // io() is loaded via Socket.IO CDN in index.html. When url is falsy,
    // socket.io-client connects to the current origin on the default path.
    const opts = {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
      withCredentials: true,
      path: '/socket.io',
    };
    this.socket = this.url ? io(this.url, opts) : io(opts);

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

    this.socket.on('container:output', (data) => {
      this._emit('containerOutput', data);
    });

    // ── Mail approval flow (MailAgent) ─────────────────────────────────
    this.socket.on('mail:approval_needed', (data) => {
      this._emit('mailApprovalNeeded', data);
    });

    this.socket.on('mail:approval_resolved', (data) => {
      this._emit('mailApprovalResolved', data);
    });

    this.socket.on('mail:approval_error', (data) => {
      this._emit('mailApprovalError', data);
    });

    this.socket.on('mail:continuation_start', (data) => {
      this._emit('mailContinuationStart', data);
    });
  }

  /** Send the user's approve/reject decision back to the backend. */
  sendMailApprovalResponse(approvalId, decision) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to backend.');
    }
    if (decision !== 'approve' && decision !== 'reject') {
      throw new Error(`Invalid decision: ${decision}`);
    }
    this.socket.emit('mail:approval_response', { approvalId, decision });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  sendMessage(agent, content, history = [], conversationId = null, imageData = null, lastFrameData = null, videoMode = null, references = null, videoModel = null, lyrics = null, musicSeconds = null, chainImagesData = null, imageModel = null, imageAspect = null, upscale4k = false) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to backend.');
    }
    const payload = { agent, content, history, conversationId };
    if (imageData) payload.imageData = imageData;
    // VideoAgent first/last-frame mode: a second attached image is the end keyframe.
    if (lastFrameData) payload.lastFrameData = lastFrameData;
    // VideoAgent explicit mode/model selectors + character/style/audio references.
    if (videoMode) payload.videoMode = videoMode;
    if (videoModel) payload.videoModel = videoModel;
    if (references) payload.references = references;
    // MusicAgent: optional lyrics (empty = instrumental) + target duration.
    if (lyrics) payload.lyrics = lyrics;
    if (musicSeconds) payload.musicSeconds = musicSeconds;
    // VideoAgent chain mode: all attached reference images, matched by name
    // against each script chunk's own "Image: <filename>" line.
    if (chainImagesData) payload.chainImagesData = chainImagesData;
    // ImageAgent explicit model selector — 'auto' (default) omitted since
    // that's the backend's own default too, only 'flux2' needs to travel.
    if (imageModel && imageModel !== 'auto') payload.imageModel = imageModel;
    if (imageAspect && imageAspect !== 'square') payload.imageAspect = imageAspect;
    if (upscale4k) payload.upscale4k = true;
    this.socket.emit('message', payload);
  }

  stopStream() {
    if (this.socket) this.socket.emit('stop:stream');
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
