export class Vp8Capture {
  constructor({
    videoBitsPerSecond = 2_500_000,
    includeAudio = false,          // raw VP8 video only in this minimal version
    frameRate = 30,
    keyFrameIntervalMs = 2000,     // force a keyframe every N ms
    onStatus = () => {},
    onError = () => {},
  } = {}) {
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.includeAudio = includeAudio;
    this.frameRate = frameRate;
    this.keyFrameIntervalMs = keyFrameIntervalMs;
    this.onStatus = onStatus;
    this.onError = onError;

    this.stream = null;
    this.encoder = null;
    this._reader = null;
    this._running = false;
    this._onChunk = null;

    this._lastKeyTs = 0;
  }

  async start({ onChunk } = {}) {
    try {
      this._onChunk = typeof onChunk === "function" ? onChunk : null;
      this._running = true;

      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("getDisplayMedia() n'est pas supporté.");
      }
      if (!window.VideoEncoder) {
        throw new Error("WebCodecs VideoEncoder n'est pas supporté.");
      }
      if (!window.MediaStreamTrackProcessor) {
        throw new Error("MediaStreamTrackProcessor n'est pas supporté (nécessaire pour frames brutes).");
      }

      this.onStatus("requesting_capture");

      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: this.frameRate },
        // Audio: si tu veux aussi raw audio, c’est un autre pipeline (AudioEncoder).
        audio: false,
      });

      const [videoTrack] = this.stream.getVideoTracks();
      if (!videoTrack) throw new Error("Pas de piste vidéo.");

      videoTrack.addEventListener("ended", () => {
        if (this._running) this.stop();
      });

      const settings = videoTrack.getSettings?.() || {};
      const width = settings.width || 1280;
      const height = settings.height || 720;

      this.onStatus("starting_encoder", { codec: "vp8", width, height, bitrate: this.videoBitsPerSecond });

      // 1) Processor: transforme track -> VideoFrame stream
      const processor = new MediaStreamTrackProcessor({ track: videoTrack });
      this._reader = processor.readable.getReader();

      // 2) Encoder: sort des EncodedVideoChunk VP8 "raw"
      const encoder = new VideoEncoder({
        output: async (chunk /* EncodedVideoChunk */) => {
          try {
            if (!this._onChunk) return;

            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);

            // IMPORTANT: on envoie type + timestamp + data
            this._onChunk(
              { type: chunk.type, timestamp: chunk.timestamp, data }, // raw VP8 frame
              { codec: "vp8", bytes: data.byteLength, ts: Date.now() }
            );
          } catch (err) {
            this.onError(err);
          }
        },
        error: (e) => {
          this.onError(e instanceof Error ? e : new Error(String(e)));
        },
      });

      // Configure VP8 encoder
      encoder.configure({
        codec: "vp8",
        width,
        height,
        bitrate: this.videoBitsPerSecond,
        framerate: this.frameRate,
        latencyMode: "realtime",
      });

      this.encoder = encoder;
      this._lastKeyTs = 0;

      this.onStatus("encoding");

      // 3) Loop: read VideoFrame -> encode -> close frame
      this._encodeLoop();
    } catch (err) {
      this.onError(err);
      await this._cleanup().catch(() => {});
      throw err;
    }
  }

  async _encodeLoop() {
    while (this._running && this._reader && this.encoder) {
      const { value: frame, done } = await this._reader.read();
      if (done || !frame) break;

      try {
        const nowMs = performance.now();
        const forceKey = (this._lastKeyTs === 0) || (nowMs - this._lastKeyTs >= this.keyFrameIntervalMs);

        this.encoder.encode(frame, { keyFrame: forceKey });

        if (forceKey) this._lastKeyTs = nowMs;
      } finally {
        // Toujours fermer le frame pour éviter memory leak
        frame.close();
      }

      // Backpressure: évite d’accumuler trop de frames encodées en attente
      if (this.encoder.encodeQueueSize > 8) {
        await this.encoder.flush();
      }
    }
  }

  async stop() {
    this._running = false;
    this.onStatus("stopping");

    try {
      // stop tracks
      if (this.stream) {
        this.stream.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }

      // stop reader
      try { await this._reader?.cancel(); } catch {}

      // flush + close encoder
      try { await this.encoder?.flush(); } catch {}
      try { this.encoder?.close(); } catch {}
    } finally {
      await this._cleanup();
      this.onStatus("stopped");
    }
  }

  isRecording() {
    return this._running;
  }

  async _cleanup() {
    this._reader = null;
    this.encoder = null;
    this.stream = null;
    this._onChunk = null;
    this._lastKeyTs = 0;
  }
}

export class WrtcBinaryChannel {
  /**
   * @param {Object} opts
   * @param {(msg: any) => void} opts.sendSignal - Envoie un msg de signaling vers l'autre peer (via WS etc.)
   * @param {(handler: (msg: any) => void) => void} opts.onSignal - Abonnement aux msgs de signaling entrants
   * @param {RTCConfiguration} [opts.rtcConfig] - STUN/TURN config
   * @param {string} [opts.label] - label du datachannel
   * @param {RTCDataChannelInit} [opts.dcOptions] - options du datachannel (ordered, maxRetransmits...)
   * @param {number} [opts.chunkSize] - taille des chunks pour gros buffers
   */
  constructor({
    sendSignal,
    onSignal,
    rtcConfig = {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
    label = "bin",
    dcOptions = { ordered: true },
    chunkSize = 16_000,
  }) {
    if (typeof sendSignal !== "function") throw new Error("sendSignal must be a function");
    if (typeof onSignal !== "function") throw new Error("onSignal must be a function");

    this.sendSignal = sendSignal;
    this._onSignalSubscribe = onSignal;

    this.rtcConfig = rtcConfig;
    this.label = label;
    this.dcOptions = dcOptions;
    this.chunkSize = chunkSize;

    this.pc = null;
    this.dc = null;

    this._binaryHandlers = new Set();
    this._textHandlers = new Set();

    // Pour reconstituer les messages chunkés
    this._rx = new Map(); // id -> { total, parts: ArrayBuffer[], received }
    this._nextMsgId = 1;

    this._openPromise = null;
    this._openResolve = null;
    this._openReject = null;
  }

  onBinary(cb) {
    this._binaryHandlers.add(cb);
    return () => this._binaryHandlers.delete(cb);
  }

  onText(cb) {
    this._textHandlers.add(cb);
    return () => this._textHandlers.delete(cb);
  }

  async start(isInitiator = false) {
    if (this.pc) throw new Error("Already started");

    this.pc = new RTCPeerConnection(this.rtcConfig);

    // ICE -> on envoie au remote
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal({ type: "ice", candidate: e.candidate });
      }
    };

    // Si on n'est pas initiateur, on attend que l'autre crée le channel
    this.pc.ondatachannel = (e) => {
      this._attachDataChannel(e.channel);
    };

    // Abonnement aux signaux entrants
    this._onSignalSubscribe(async (msg) => {
      try {
        await this._handleSignal(msg);
      } catch (err) {
        console.error("Signal handling error:", err);
      }
    });

    // Promesse pour attendre le "open"
    this._openPromise = new Promise((res, rej) => {
      this._openResolve = res;
      this._openReject = rej;
    });

    if (isInitiator) {
      // L'initiateur crée le datachannel
      const dc = this.pc.createDataChannel(this.label, this.dcOptions);
      this._attachDataChannel(dc);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ type: "sdp", sdp: this.pc.localDescription });
    }

    return this._openPromise; // résout quand channel open
  }

  async waitOpen() {
    if (!this._openPromise) throw new Error("Call start() first");
    return this._openPromise;
  }

  /**
   * Envoie du binaire (ArrayBuffer | Uint8Array).
   * Chunk automatiquement si c'est grand.
   */
  async sendBinary(data) {
    await this.waitOpen();
    this._assertOpen();

    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (ArrayBuffer.isView(data)) {
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      throw new Error("sendBinary expects ArrayBuffer or TypedArray");
    }

    // Petit => on envoie direct
    if (buffer.byteLength <= this.chunkSize) {
      this.dc.send(buffer);
      return;
    }

    // Gros => on chunk
    const id = this._nextMsgId++;
    const total = Math.ceil(buffer.byteLength / this.chunkSize);

    // Header en JSON (petit) pour annoncer le message chunké
    this.dc.send(JSON.stringify({ _bin: "start", id, total, bytes: buffer.byteLength }));

    for (let i = 0; i < total; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(buffer.byteLength, start + this.chunkSize);
      const chunk = buffer.slice(start, end);

      // Backpressure: si buffer réseau trop rempli, on attend un peu
      await this._drainIfNeeded();

      // Chaque chunk est envoyé en binaire + un mini prefix JSON séparé (texte)
      // Pour rester simple: on envoie d'abord un petit message texte qui dit "chunk i"
      this.dc.send(JSON.stringify({ _bin: "chunk", id, i }));
      this.dc.send(chunk);
    }

    this.dc.send(JSON.stringify({ _bin: "end", id }));
  }

  sendText(text) {
    this._assertOpen();
    this.dc.send(String(text));
  }

  close() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null;
    this.pc = null;
    this._rx.clear();
  }

  // -------------------- internals --------------------

  _attachDataChannel(dc) {
    this.dc = dc;
    this.dc.binaryType = "arraybuffer";

    this.dc.onopen = () => {
      this._openResolve?.();
    };

    this.dc.onclose = () => {
      // si ça ferme avant open, on rejette
      this._openReject?.(new Error("DataChannel closed"));
    };

    this.dc.onerror = (e) => {
      // pareil
      this._openReject?.(new Error("DataChannel error"));
      console.error("DataChannel error:", e);
    };

    // Parser messages (texte + binaire)
    this._pendingChunkMeta = null; // {id,i} quand on reçoit le JSON "chunk"
    this._pendingMode = null; // "chunk" etc.

    this.dc.onmessage = (e) => {
      const d = e.data;

      // Texte (JSON de contrôle ou message texte)
      if (typeof d === "string") {
        let obj = null;
        try { obj = JSON.parse(d); } catch {}

        if (obj && obj._bin) {
          this._handleBinControl(obj);
        } else {
          for (const cb of this._textHandlers) cb(d);
        }
        return;
      }

      // Binaire direct (petit message non chunké)
      if (d instanceof ArrayBuffer) {
        // Si on attend un chunk (après avoir reçu { _bin:"chunk" })
        if (this._pendingChunkMeta) {
          const { id, i } = this._pendingChunkMeta;
          this._pendingChunkMeta = null;

          const rec = this._rx.get(id);
          if (rec) {
            rec.parts[i] = d;
            rec.received++;

            if (rec.received === rec.total) {
              // Reconstituer
              const full = this._concatArrayBuffers(rec.parts);
              this._rx.delete(id);
              for (const cb of this._binaryHandlers) cb(full);
            }
            return;
          }
        }

        // Sinon: binaire simple
        for (const cb of this._binaryHandlers) cb(d);
        return;
      }

      // Certains navigateurs peuvent donner un Blob
      if (d instanceof Blob) {
        d.arrayBuffer().then((buf) => {
          for (const cb of this._binaryHandlers) cb(buf);
        });
      }
    };
  }

  _handleBinControl(obj) {
    if (obj._bin === "start") {
      this._rx.set(obj.id, {
        total: obj.total,
        parts: new Array(obj.total),
        received: 0,
        bytes: obj.bytes,
      });
      return;
    }
    if (obj._bin === "chunk") {
      this._pendingChunkMeta = { id: obj.id, i: obj.i };
      return;
    }
    if (obj._bin === "end") {
      // rien à faire ici (on finalise quand received === total)
      return;
    }
  }

  _concatArrayBuffers(parts) {
    const totalBytes = parts.reduce((sum, ab) => sum + (ab?.byteLength || 0), 0);
    const out = new Uint8Array(totalBytes);
    let offset = 0;
    for (const ab of parts) {
      const u8 = new Uint8Array(ab);
      out.set(u8, offset);
      offset += u8.byteLength;
    }
    return out.buffer;
  }

  async _handleSignal(msg) {
    if (!this.pc) return;

    if (msg?.type === "sdp") {
      const desc = new RTCSessionDescription(msg.sdp);
      await this.pc.setRemoteDescription(desc);

      if (desc.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({ type: "sdp", sdp: this.pc.localDescription });
      }
      return;
    }

    if (msg?.type === "ice" && msg.candidate) {
      // addIceCandidate peut échouer si remoteDescription pas encore posée
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (e) {
        // On peut log, mais souvent c'est juste un timing
        console.warn("addIceCandidate warning:", e);
      }
    }
  }

  _assertOpen() {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("DataChannel not open");
    }
  }

  async _drainIfNeeded() {
    // Si le buffer est trop rempli, on attend que ça redescende
    const HIGH = 4 * 1024 * 1024; // 4MB
    const LOW = 1 * 1024 * 1024;  // 1MB

    if (!this.dc) return;
    if (this.dc.bufferedAmount < HIGH) return;

    await new Promise((resolve) => {
      const check = () => {
        if (!this.dc) return resolve();
        if (this.dc.bufferedAmount <= LOW) return resolve();
        setTimeout(check, 20);
      };
      check();
    });
  }
}

export class HubWsClient {
  /**
   * @param {Object} opts
   * @param {string} opts.urlBase - ex: "wss://localhost:8445/ws"
   * @param {string} opts.room - room id
   * @param {(evt: {type:"open"|"close"|"error"|"reconnect", detail?:any})=>void} [opts.onStatus]
   */
  constructor({ urlBase, room, onStatus } = {}) {
    if (!urlBase) throw new Error("urlBase is required");
    if (!room) throw new Error("room is required");

    this.urlBase = urlBase;
    this.room = room;
    this.onStatus = typeof onStatus === "function" ? onStatus : () => {};

    this.ws = null;

    this._jsonHandlers = new Set();   // (msg) => void
    this._binHandlers = new Set();    // ({from, payload}) => void
    this._rawHandlers = new Set();    // (event) => void (optionnel)

    this._openPromise = null;
    this._openResolve = null;
    this._openReject = null;
  }

  // ---------- Events ----------
  onJson(cb) {
    this._jsonHandlers.add(cb);
    return () => this._jsonHandlers.delete(cb);
  }

  onBinary(cb) {
    this._binHandlers.add(cb);
    return () => this._binHandlers.delete(cb);
  }

  onRawMessage(cb) {
    this._rawHandlers.add(cb);
    return () => this._rawHandlers.delete(cb);
  }

  // ---------- Connection ----------
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return this._openPromise ?? Promise.resolve();
    }

    const url = `${this.urlBase}?room=${encodeURIComponent(this.room)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this._openPromise = new Promise((res, rej) => {
      this._openResolve = res;
      this._openReject = rej;
    });

    this.ws.addEventListener("open", () => {
      this.onStatus({ type: "open" });
      this._openResolve?.();
    });

    this.ws.addEventListener("close", (e) => {
      this.onStatus({ type: "close", detail: { code: e.code, reason: e.reason } });
      // si close arrive avant open
      this._openReject?.(new Error(`WebSocket closed before open: ${e.code} ${e.reason || ""}`));
    });

    this.ws.addEventListener("error", (e) => {
      this.onStatus({ type: "error", detail: e });
      // si error arrive avant open
      this._openReject?.(new Error("WebSocket error"));
    });

    this.ws.addEventListener("message", (e) => this._handleMessage(e));

    return this._openPromise;
  }

  async waitOpen() {
    if (!this._openPromise) throw new Error("Call connect() first");
    return this._openPromise;
  }

  close(code, reason) {
    try { this.ws?.close(code, reason); } catch {}
    this.ws = null;
  }

  // ---------- JSON protocol ----------
  /**
   * Broadcast JSON: { action, data }
   */
  sendJsonBroadcast(action, data) {
    this._assertOpen();
    this.ws.send(JSON.stringify({ action, data }));
  }

  /**
   * Targeted JSON: { to, action, data }
   */
  sendJsonTo(to, action, data) {
    this._assertOpen();
    this._assertId(to);
    this.ws.send(JSON.stringify({ to, action, data }));
  }

  // ---------- Binary protocol ----------
  /**
   * Broadcast binary: 2 bytes ID=0 + payload
   * payload: ArrayBuffer | Uint8Array | Blob
   */
  async sendBinaryBroadcast(payload) {
    return this.sendBinaryTo(0, payload);
  }

  /**
   * Targeted binary: 2 bytes ID (big-endian) + payload
   */
  async sendBinaryTo(to, payload) {
    this._assertOpen();
    this._assertId(to);

    const dataBuf = await this._toArrayBuffer(payload);
    const out = new Uint8Array(2 + dataBuf.byteLength);

    // 2 bytes big-endian
    out[0] = (to >> 8) & 0xff;
    out[1] = to & 0xff;

    out.set(new Uint8Array(dataBuf), 2);
    this.ws.send(out.buffer);
  }

  // ---------- Internals ----------
  _handleMessage(e) {
    for (const cb of this._rawHandlers) cb(e);

    // Texte => JSON
    if (typeof e.data === "string") {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        // si c'est pas JSON, on ignore ou on le passe brut
        return;
      }
      // Le hub dit qu'on reçoit: { from, action, data }
      for (const cb of this._jsonHandlers) cb(msg);
      return;
    }

    // Binaire => ArrayBuffer
    const buf = e.data;
    if (!(buf instanceof ArrayBuffer)) return;

    if (buf.byteLength < 2) return; // invalide
    const u8 = new Uint8Array(buf);

    const from = (u8[0] << 8) | u8[1];
    const payload = buf.slice(2);

    for (const cb of this._binHandlers) cb({ from, payload });
  }

  _assertOpen() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open. Call connect() and await it.");
    }
  }

  _assertId(id) {
    if (!Number.isInteger(id) || id < 0 || id > 65535) {
      throw new Error("ID must be an integer between 0 and 65535");
    }
  }

  async _toArrayBuffer(payload) {
    if (payload instanceof ArrayBuffer) return payload;
    if (ArrayBuffer.isView(payload)) {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    }
    if (payload instanceof Blob) return await payload.arrayBuffer();
    throw new Error("Binary payload must be ArrayBuffer, TypedArray, or Blob");
  }
}

export class Vp8Decoder {
  constructor({ onFrame = () => {}, onStatus = () => {}, onError = () => {}, maxQueueSize = 6 } = {}) {
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.onError = onError;
    this.maxQueueSize = maxQueueSize;

    this.decoder = null;
    this._running = false;
    this._lastTs = 0;
  }

  async start() {
    if (this._running) return;
    if (!window.VideoDecoder) throw new Error("WebCodecs VideoDecoder n'est pas supporté.");

    this._running = true;
    this.onStatus("starting_decoder", { codec: "vp8" });

    const decoder = new VideoDecoder({
      output: async (frame) => {
        try {
          if (!this._running) {
            try { frame.close(); } catch {}
            return;
          }

          const bitmap = await createImageBitmap(frame);
          try { frame.close(); } catch {}

          this.onFrame(bitmap);
        } catch (err) {
          try { frame.close(); } catch {}
          this.onError(err);
        }
      },
      error: (e) => {
        this.onError(e instanceof Error ? e : new Error(String(e)));
      },
    });

    decoder.configure({ codec: "vp8" });
    this.decoder = decoder;
    this.onStatus("decoding");
  }

  async decode({ type, timestamp, data } = {}) {
    if (!this._running || !this.decoder) throw new Error("Vp8Decoder not started. Call start().");
    if (!(data instanceof Uint8Array)) throw new Error("Vp8Decoder expects data as Uint8Array");
    if (type !== "key" && type !== "delta") throw new Error("Vp8Decoder chunk.type must be 'key' or 'delta'");

    const ts = Number.isFinite(timestamp) ? timestamp : (this._lastTs + 1);
    this._lastTs = ts;

    try {
      const chunk = new EncodedVideoChunk({
        type,
        timestamp: ts,
        data,
      });

      if (this.decoder.decodeQueueSize > this.maxQueueSize) {
        await this.decoder.flush().catch(() => {});
      }

      this.decoder.decode(chunk);
    } catch (err) {
      this.onError(err);
    }
  }

  async flush() {
    if (!this.decoder) return;
    await this.decoder.flush();
  }

  close() {
    this._running = false;
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
    this.onStatus("stopped");
  }
}

export class WebTransportHubClient {
  constructor({ url, onStatus } = {}) {
    this.url = url;
    this.onStatus = onStatus;

    this.transport = null;
    this.id = null;

    this._binHandlers = [];
    this._reader = null;
    this._writer = null;
    this._recvLoopPromise = null;
    this._closed = false;
  }

  onBinary(cb) {
    this._binHandlers.push(cb);
    return () => {
      const i = this._binHandlers.indexOf(cb);
      if (i >= 0) this._binHandlers.splice(i, 1);
    };
  }

  async connect() {
    if (!this.url) throw new Error("WebTransport url is required");
    if (this.transport) return;

    this._closed = false;
    this.onStatus?.({ type: "connecting" });

    const transport = new WebTransport(this.url);
    this.transport = transport;

    transport.closed
      .then(() => {
        this.onStatus?.({ type: "close" });
      })
      .catch((e) => {
        this.onStatus?.({ type: "error", detail: e });
      });

    await transport.ready;

    this._writer = transport.datagrams.writable.getWriter();
    this._reader = transport.datagrams.readable.getReader();

    this.onStatus?.({ type: "open" });
    this._recvLoopPromise = this._recvLoop();
    await this._waitForWelcomeId();
  }

  close() {
    this._closed = true;
    try {
      this._reader?.cancel();
    } catch {}
    try {
      this._writer?.close();
    } catch {}
    try {
      this.transport?.close();
    } catch {}

    this._reader = null;
    this._writer = null;
    this.transport = null;
    this.id = null;
  }

  async sendTo(to, payload) {
    this._assertOpen();
    this._assertId(to);

    const dataBuf = await this._toArrayBuffer(payload);
    const out = new Uint8Array(8 + dataBuf.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, to >>> 0, false);
    dv.setUint32(4, dataBuf.byteLength >>> 0, false);
    out.set(new Uint8Array(dataBuf), 8);

    await this._writer.write(out);
  }

  async _waitForWelcomeId() {
    const started = Date.now();
    while (!this._closed && this.id == null) {
      if (Date.now() - started > 8000) {
        throw new Error("WebTransport welcome id timeout");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async _recvLoop() {
    while (!this._closed) {
      let res;
      try {
        res = await this._reader.read();
      } catch {
        return;
      }
      if (!res || res.done) return;

      const u8 = res.value;
      if (!(u8 instanceof Uint8Array)) continue;
      if (u8.byteLength < 8) continue;

      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const from = dv.getUint32(0, false);
      const ln = dv.getUint32(4, false);
      if (u8.byteLength !== 8 + ln) continue;

      const payload = u8.slice(8);

      if (from === 0 && ln === 4 && this.id == null) {
        this.id = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
        this.onStatus?.({ type: "id", detail: { id: this.id } });
        continue;
      }

      for (const cb of this._binHandlers) {
        try {
          cb({ from, payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) });
        } catch {}
      }
    }
  }

  _assertOpen() {
    if (!this.transport || !this._writer) {
      throw new Error("WebTransport not open. Call connect() and await it.");
    }
  }

  _assertId(id) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
      throw new Error("ID must be an integer between 0 and 4294967295");
    }
  }

  async _toArrayBuffer(payload) {
    if (payload instanceof ArrayBuffer) return payload;
    if (ArrayBuffer.isView(payload)) {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    }
    if (payload instanceof Blob) return await payload.arrayBuffer();
    throw new Error("Binary payload must be ArrayBuffer, TypedArray, or Blob");
  }
}

import { toCanvas } from "https://cdn.jsdelivr.net/npm/html-to-image/+esm";

export class HtmlVp8Capture {
  
  constructor({
    videoBitsPerSecond = 1_200_000,
    frameRate = 10,               // DOM->raster coûte cher: 5-15 fps est plus réaliste que 30 sur mobile
    keyFrameIntervalMs = 2000,     // keyframe toutes les N ms
    pixelRatio = 1,               // IMPORTANT mobile: 1 (ou <1) pour éviter crash/mémoire
    width = null,                 // si null -> taille de l'élément capturé
    height = null,
    backgroundColor = null,       // ex: "#fff" si besoin
    latencyMode = "realtime",     // "realtime" recommandé
    onStatus = () => {},
    onError = () => {},
  } = {}) {
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.frameRate = frameRate;
    this.keyFrameIntervalMs = keyFrameIntervalMs;
    this.pixelRatio = pixelRatio;
    this.width = width;
    this.height = height;
    this.backgroundColor = backgroundColor;
    this.latencyMode = latencyMode;
    this.onStatus = onStatus;
    this.onError = onError;

    this.encoder = null;
    this._running = false;
    this._onChunk = null;

    this._element = null;
    this._canvas = null;
    this._ctx = null;

    this._lastKeyMs = 0;
    this._t0ms = 0;
    this._timer = null;
    this._frameIndex = 0;
  }

  async start({ element, onChunk } = {}) {
    try {
      if (!element) throw new Error("start({ element }) requis.");
      this._element = element;

      this._onChunk = typeof onChunk === "function" ? onChunk : null;
      this._running = true;

      if (!window.VideoEncoder) {
        throw new Error("WebCodecs VideoEncoder n'est pas supporté.");
      }
      if (!VideoEncoder.isConfigSupported) {
        throw new Error("VideoEncoder.isConfigSupported n'est pas supporté.");
      }

      this.onStatus("starting");

      // Canvas de sortie (celui qui sert de source à VideoFrame)
      this._canvas = document.createElement("canvas");
      this._ctx = this._canvas.getContext("2d", { alpha: true });

      // Détermine une taille de capture (évite les très grands canvases)
      const rect = element.getBoundingClientRect();
      const outW = this.width ?? Math.max(2, Math.round(rect.width));
      const outH = this.height ?? Math.max(2, Math.round(rect.height));

      this._canvas.width = outW;
      this._canvas.height = outH;

      // Configure encoder VP8
      const config = {
        codec: "vp8",
        width: outW,
        height: outH,
        bitrate: this.videoBitsPerSecond,
        framerate: this.frameRate,
        latencyMode: this.latencyMode,
      };

      const support = await VideoEncoder.isConfigSupported(config);
      if (!support?.supported) {
        throw new Error(`Config VP8 non supportée: ${JSON.stringify(support)}`);
      }

      this.onStatus("starting_encoder", {
        codec: "vp8",
        width: outW,
        height: outH,
        bitrate: this.videoBitsPerSecond,
        framerate: this.frameRate,
      });

      this.encoder = new VideoEncoder({
        output: (chunk /* EncodedVideoChunk */, metadata) => {
          try {
            if (!this._onChunk) return;

            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);

            // Même style de payload que ton exemple:
            // { type, timestamp, data } + meta
            this._onChunk(
              { type: chunk.type, timestamp: chunk.timestamp, data },
              {
                codec: "vp8",
                bytes: data.byteLength,
                width: outW,
                height: outH,
                key: chunk.type === "key",
                frameIndex: this._frameIndex,
                // metadata peut contenir des infos utiles selon implémentation
                metadata,
              }
            );
          } catch (err) {
            this.onError(err);
          }
        },
        error: (e) => this.onError(e instanceof Error ? e : new Error(String(e))),
      });

      this.encoder.configure(config);

      this._lastKeyMs = 0;
      this._t0ms = performance.now();
      this._frameIndex = 0;

      this.onStatus("capturing");

      // Boucle cadence fixe
      const intervalMs = Math.max(1, Math.round(1000 / this.frameRate));
      this._timer = setInterval(() => {
        // fire & forget; on gère la pression via encodeQueueSize/flush
        this._tick().catch((err) => this.onError(err));
      }, intervalMs);

      // Tick immédiat
      await this._tick();
    } catch (err) {
      this.onError(err);
      await this._cleanup().catch(() => {});
      throw err;
    }
  }

  async _tick() {
    if (!this._running || !this.encoder || !this._element) return;

    // Backpressure: si la queue explose, on drop un frame (latence live)
    if (this.encoder.encodeQueueSize > 10) {
      this.onStatus("dropping_frame", { encodeQueueSize: this.encoder.encodeQueueSize });
      return;
    }

    // 1) DOM -> canvas (raster)
    // toCanvas renvoie un canvas "domCanvas" que l'on draw dans notre canvas cible à taille fixe
    const domCanvas = await toCanvas(this._element, {
      pixelRatio: this.pixelRatio,
      cacheBust: true,
      backgroundColor: this.backgroundColor ?? undefined,
      // Astuce: si tu as du contenu hors-bord, html-to-image gère déjà via l'élément
    });

    // 2) draw dans canvas sortie (mise à l’échelle si nécessaire)
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    this._ctx.drawImage(domCanvas, 0, 0, this._canvas.width, this._canvas.height);

    // 3) canvas -> VideoFrame -> encode
    const nowMs = performance.now();
    const tsUs = Math.round((nowMs - this._t0ms) * 1000); // microsecondes

    const forceKey =
      this._lastKeyMs === 0 || nowMs - this._lastKeyMs >= this.keyFrameIntervalMs;

    const frame = new VideoFrame(this._canvas, { timestamp: tsUs });

    try {
      this.encoder.encode(frame, { keyFrame: forceKey });
      if (forceKey) this._lastKeyMs = nowMs;
      this._frameIndex++;
    } finally {
      frame.close();
    }

    // Flush occasionnel pour garder latence basse
    if (this.encoder.encodeQueueSize > 6) {
      await this.encoder.flush();
    }
  }

  async stop() {
    this._running = false;
    this.onStatus("stopping");

    try {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }

      try {
        await this.encoder?.flush();
      } catch {}

      try {
        this.encoder?.close();
      } catch {}
    } finally {
      await this._cleanup();
      this.onStatus("stopped");
    }
  }

  isRecording() {
    return this._running;
  }

  // Optionnel: pour afficher ce que tu captures (preview)
  getPreviewCanvas() {
    return this._canvas;
  }

  async _cleanup() {
    this.encoder = null;
    this._onChunk = null;
    this._element = null;

    this._ctx = null;
    this._canvas = null;

    this._lastKeyMs = 0;
    this._t0ms = 0;
    this._frameIndex = 0;
  }
}

