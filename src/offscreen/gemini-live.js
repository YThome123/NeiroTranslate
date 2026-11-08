// NeiroTranslate — Gemini Live API client tuned for continuous speech-to-speech translation.
// Default model: gemini-3.5-live-translate-preview (translationConfig, continuous stream, no turn-taking).
const NT_GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const NT_SENTENCE_END = /[.!?…。！？]["»”')\]]?\s*$/;
const NT_GEMINI_AUDIO_WINDOW_MS = 3000;
const NT_GEMINI_BUFFER_BYTES = 128 * 1024;

class NtGeminiLive {
  constructor(opts) {
    this.apiKey = (opts.apiKey || '').trim();
    this.model = (opts.model || 'gemini-3.5-live-translate-preview').replace(/^models\//, '').trim();
    this.targetLang = opts.targetLang || 'ru';
    this.targetName = opts.targetName || 'Russian';
    this.echo = !!opts.echo;
    this.onAudio = opts.onAudio || (() => {});
    this.onTranscript = opts.onTranscript || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onFatal = opts.onFatal || (() => {});

    this.ws = null;
    this.ready = false;
    this.closedByUser = false;
    this.pending = [];
    this.variant = 0;
    this.resumeHandle = null;
    this.retries = 0;
    this.transportFailures = 0;
    this.healthyAudioSince = null;
    this.lastAudioSentAt = null;
    this.outBuf = '';
    this.inBuf = '';
    this.outTimer = null;
    this.inTimer = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
  }

  get isTranslateModel() {
    return /translate/i.test(this.model);
  }

  connect() {
    this.closedByUser = false;
    this.ready = false;
    this.healthyAudioSince = this.lastAudioSentAt = null;
    if (!this.apiKey) return this.onFatal('needGeminiKey');
    this.onStatus(this.retries ? 'reconnecting' : 'connecting');

    let ws;
    try {
      ws = new WebSocket(NT_GEMINI_WS + '?key=' + encodeURIComponent(this.apiKey));
    } catch (e) {
      return this.onFatal('WebSocket: ' + e.message);
    }
    this.ws = ws;
    ws.onopen = () => { if (ws === this.ws && !this.closedByUser) this._send(this._setupMessage()); };
    ws.onmessage = (ev) => { if (ws === this.ws && !this.closedByUser) return this._onMessage(ev, ws); };
    ws.onclose = (ev) => this._onClose(ev, ws);
    ws.onerror = () => { /* details arrive in onclose */ };
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (ws !== this.ws || this.ready || this.closedByUser) return;
      this.close();
      this.onFatal('gemini_timeout');
    }, 12000);
  }

  close() {
    this.closedByUser = true;
    this.outBuf = this.inBuf = '';
    clearTimeout(this.outTimer);
    clearTimeout(this.inTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    if (this.ws) { try { this.ws.close(1000, 'bye'); } catch (e) { /* ignore */ } }
    this.ws = null;
    this.ready = false;
    this.healthyAudioSince = this.lastAudioSentAt = null;
    this.pending = [];
  }

  /** @param {string} base64Pcm16k 100 ms of 16 kHz mono PCM */
  sendAudio(base64Pcm16k) {
    if (this.closedByUser) return;
    const msg = { realtimeInput: { audio: { data: base64Pcm16k, mimeType: 'audio/pcm;rate=16000' } } };
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      this._queueAudio(msg);
      return;
    }
    this._send(msg);
  }

  // ─── internals ─────────────────────────────────────────────
  _queueAudio(message) {
    const at = Date.now();
    this.pending = this.pending.filter(item => at - item.at < NT_GEMINI_AUDIO_WINDOW_MS);
    this.pending.push({at, message});
    if (this.pending.length > 30) this.pending.shift();
  }

  _recoverTransport(message) {
    // Already queued browser bytes cannot be removed: abandon that socket.
    // Keep only the capture packet which noticed the failure, then fresh input.
    this.pending = [];
    if (message?.realtimeInput?.audio) this._queueAudio(message);
    this.resumeHandle = null;
    if (++this.transportFailures > 6) {
      this.close();
      this.onFatal('raw|The audio connection cannot keep up. Check your network and restart translation.');
      return;
    }
    this._reconnect(Math.min(250 * 2 ** (this.transportFailures - 1), 4000), true);
  }

  _setupMessage() {
    const setup = { model: 'models/' + this.model };

    if (this.isTranslateModel) {
      // Variant 0: exactly as documented for Live Translate (+ session resumption).
      // Variant 1: transcription flags at setup level. Variant 2: bare minimum.
      const translationConfig = { targetLanguageCode: this.targetLang, echoTargetLanguage: this.echo };
      if (this.variant === 0) {
        setup.generationConfig = { responseModalities: ['AUDIO'], inputAudioTranscription: {}, outputAudioTranscription: {}, translationConfig };
        setup.sessionResumption = this.resumeHandle ? { handle: this.resumeHandle } : {};
      } else if (this.variant === 1) {
        setup.generationConfig = { responseModalities: ['AUDIO'], translationConfig };
        setup.inputAudioTranscription = {};
        setup.outputAudioTranscription = {};
      } else {
        setup.generationConfig = { responseModalities: ['AUDIO'], translationConfig };
      }
    } else {
      // Generic Live model fallback: act as an interpreter via system instruction.
      setup.generationConfig = { responseModalities: ['AUDIO'] };
      setup.systemInstruction = { parts: [{ text:
        'You are a simultaneous interpreter. Translate everything you hear into ' + this.targetName +
        '. Output only the translation, never answer questions or add comments. Keep the speaker\'s tone.' }] };
      setup.inputAudioTranscription = {};
      setup.outputAudioTranscription = {};
      if (this.variant === 0) {
        setup.sessionResumption = this.resumeHandle ? { handle: this.resumeHandle } : {};
        setup.contextWindowCompression = { slidingWindow: {} };
      }
    }
    return { setup };
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closedByUser) return false;
    try {
      const encoded = JSON.stringify(obj);
      if (obj.realtimeInput?.audio && (Number(this.ws.bufferedAmount) || 0) + encoded.length > NT_GEMINI_BUFFER_BYTES) {
        this._recoverTransport(obj);
        return false;
      }
      this.ws.send(encoded);
      if (this.ready && obj.realtimeInput?.audio) {
        const now = Date.now();
        // Setup/backoff and idle capture gaps are not evidence of a healthy stream.
        if (this.lastAudioSentAt === null || now - this.lastAudioSentAt >= NT_GEMINI_AUDIO_WINDOW_MS) {
          this.healthyAudioSince = now;
        }
        this.lastAudioSentAt = now;
        if (now - this.healthyAudioSince >= 10000) this.transportFailures = 0;
      }
      return true;
    } catch (error) {
      this._recoverTransport(obj);
      return false;
    }
  }

  async _onMessage(ev, socket = this.ws) {
    let data;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : await new Response(ev.data).text();
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (this.closedByUser || socket !== this.ws) return;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    if (data.setupComplete) {
      this.ready = true;
      clearTimeout(this.connectTimer);
      this.retries = 0;
      this.onStatus('ready');
      const queued = this.pending;
      this.pending = [];
      for (const item of queued) {
        if (socket !== this.ws || !this.ready) break;
        if (Date.now() - item.at < NT_GEMINI_AUDIO_WINDOW_MS) this._send(item.message);
      }
      return;
    }

    if (data.error) {
      const message = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
      const detail = this._explain(message);
      this.close();
      this.onFatal(detail);
      return;
    }

    if (data.sessionResumptionUpdate) {
      const u = data.sessionResumptionUpdate;
      if (u.resumable !== false && u.newHandle) this.resumeHandle = u.newHandle;
    }

    if (data.goAway) {
      // Server will drop the socket soon: reconnect proactively with the resumption handle.
      this._reconnect(0);
      return;
    }

    const sc = data.serverContent;
    if (!sc) return;

    const parts = sc.modelTurn && Array.isArray(sc.modelTurn.parts) ? sc.modelTurn.parts : [];
    for (const p of parts) {
      const inl = p && p.inlineData;
      if (inl && typeof inl.data === 'string' && inl.data) {
        const m = /rate=(\d+)/.exec(inl.mimeType || '');
        this.onAudio(inl.data, m ? parseInt(m[1], 10) : 24000);
      }
    }

    if (typeof sc.inputTranscription?.text === 'string' && sc.inputTranscription.text) this._pushIn(sc.inputTranscription.text);
    if (typeof sc.outputTranscription?.text === 'string' && sc.outputTranscription.text) this._pushOut(sc.outputTranscription.text);
    if (sc.turnComplete || sc.generationComplete) this._flushOut(true);
  }

  _pushOut(fragment) {
    this.outBuf += fragment;
    const text = this.outBuf.replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (NT_SENTENCE_END.test(text) || text.length > 180) return this._flushOut(true);
    this.onTranscript({ kind: 'output', text, final: false });
    clearTimeout(this.outTimer);
    this.outTimer = setTimeout(() => this._flushOut(true), 1600);
  }

  _flushOut(final) {
    clearTimeout(this.outTimer);
    const text = this.outBuf.replace(/\s+/g, ' ').trim();
    this.outBuf = '';
    if (text) this.onTranscript({ kind: 'output', text, final });
  }

  _pushIn(fragment) {
    this.inBuf += fragment;
    let text = this.inBuf.replace(/\s+/g, ' ').trim();
    if (text.length > 220) text = '…' + text.slice(-200);
    this.onTranscript({ kind: 'input', text, final: false });
    clearTimeout(this.inTimer);
    if (NT_SENTENCE_END.test(text) || this.inBuf.length > 400) this.inBuf = '';
    this.inTimer = setTimeout(() => { this.inBuf = ''; }, 2500);
  }

  _onClose(ev, ws) {
    if (ws !== this.ws) return; // stale socket
    const wasReady = this.ready;
    this.ready = false;
    this.healthyAudioSince = this.lastAudioSentAt = null;
    clearTimeout(this.connectTimer);
    if (this.closedByUser) return;
    const reason = ev.reason || '';
    console.warn('[NeiroTranslate] Gemini socket closed', ev.code, reason);

    const fatal = this._fatalReason(reason);
    if (fatal) { this.close(); return this.onFatal(fatal); }

    // Setup rejected (unknown field etc.): try a simpler setup variant.
    if (!wasReady && (ev.code === 1007 || ev.code === 1008 || ev.code === 1003) && this.variant < 2) {
      this.variant++;
      this.resumeHandle = null;
      return this._reconnect(150);
    }
    if (!wasReady && ev.code === 1008 && /model/i.test(reason)) {
      this.close();
      return this.onFatal(this._explain(reason));
    }

    if (this.retries >= 6) {
      this.close();
      return this.onFatal(this._explain(reason || ('WebSocket ' + ev.code)));
    }
    this.retries++;
    this._reconnect(Math.min(500 * this.retries, 4000));
  }

  _reconnect(delay, discard = false) {
    this.ready = false;
    this.healthyAudioSince = this.lastAudioSentAt = null;
    clearTimeout(this.connectTimer);
    clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = null;
    if (old) { try { old.onclose = null; old.close(); } catch (e) { /* ignore */ } }
    if (discard) {
      this.outBuf = this.inBuf = '';
      clearTimeout(this.outTimer);
      clearTimeout(this.inTimer);
    } else this._flushOut(true);
    this.onStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
  }

  _fatalReason(reason) {
    const r = (reason || '').toLowerCase();
    if (!r) return null;
    if (r.includes('api key') || r.includes('api_key') || r.includes('unauthenticated') || r.includes('permission')) return this._explain(reason);
    if (r.includes('location') || r.includes('region') || r.includes('country')) return this._explain(reason);
    if (r.includes('quota') || r.includes('exhausted') || r.includes('billing')) return this._explain(reason);
    if (r.includes('not found') && r.includes('model')) return this._explain(reason);
    return null;
  }

  _explain(message) {
    const m = (message || '').toLowerCase();
    if (m.includes('api key') || m.includes('api_key')) return 'gemini_bad_key';
    if (m.includes('location') || m.includes('region') || m.includes('country')) return 'gemini_region';
    if (m.includes('quota') || m.includes('exhausted')) return 'gemini_quota';
    if (m.includes('not found') || m.includes('not supported')) return 'gemini_model|' + this.model;
    return 'raw|' + message;
  }
}

self.NtGeminiLive = NtGeminiLive;
