const { randomUUID } = require('node:crypto');
const { CommandName } = require('../../adapters/eufy');
const { isAuthenticated } = require('../auth/session.cjs');
const { scopeKey } = require('../devices/capabilities.cjs');
const { LiveConnection } = require('./connection.cjs');
const { createDecoder } = require('./decoder.cjs');

const statuses = { DEVICE_NOT_FOUND: 404, UNAUTHENTICATED: 401, SERVICE_BUSY: 409, SERVICE_STOPPING: 503,
  INVALID_REQUEST: 400, LIVE_SESSION_NOT_FOUND: 404, LIVE_REQUEST_CONFLICT: 409, LIVE_CLIENT_CONFLICT: 409,
  LIVE_UNSUPPORTED: 422, LIVE_CAPABILITY_UNKNOWN: 409, LIVE_DEVICE_OFFLINE: 503, LIVE_SCOPE_CHANGED: 409,
  LIVE_CONNECTION_FAILED: 503, LIVE_CONNECTION_LOST: 503, LIVE_COMMAND_REJECTED: 502,
  LIVE_COMMAND_TIMEOUT: 504, LIVE_MEDIA_TIMEOUT: 504, LIVE_RUNTIME_UNAVAILABLE: 503,
  LIVE_DECODER_FAILED: 502, LIVE_CLEANUP_FAILED: 503, LIVE_INACTIVE: 409 };
const failure = code => Object.assign(new Error(code), { code, status: statuses[code] || 502 });
const safeError = error => failure(statuses[error?.code] ? error.code : 'LIVE_CONNECTION_FAILED');

// Session ownership participates in the resident v1 admission guards. This map
// is request identity/history, not a second HomeBase scheduler or protocol pool.
class LiveSessions {
  constructor({ session, resolveDevice, createConnection = () => new LiveConnection(session),
    createDecoder: decoder = createDecoder, startupMs = 15000, commandMs = 5000, attachMs = 10000, authPollMs = 1000 }) {
    Object.assign(this, { session, resolveDevice, createConnection, createDecoder: decoder, startupMs, commandMs, attachMs, authPollMs });
    this.sessions = new Map(); this.requests = new Map(); this.current = null; this.stopping = false;
  }
  isBusy() { return Boolean(this.current && !this.current.closed); }
  hasRequest(id) { return this.requests.has(id); }
  _find(id) { const c = this.sessions.get(id); if (!c) throw failure('LIVE_SESSION_NOT_FOUND'); return c; }
  get(id) {
    const c = this._find(id);
    return { sessionId: c.id, requestId: c.requestId, state: c.state, serial: c.serial,
      homeBaseId: c.scope?.homeBase?.serial ?? null, channel: c.scope?.channel ?? null,
      verificationScope: structuredClone(c.scope ?? null), capability: structuredClone(c.capability ?? null),
      maxDurationMs: c.maxDurationMs, expiresAtMs: c.expiresAt, stopConfirmed: Boolean(c.stopConfirmed),
      cleanupComplete: Boolean(c.closed), error: c.error ? { code: c.error.code, message: c.error.code } : null,
      resources: { protocolClosed: !c.connection || Boolean(c.connectionClosed && !c.p2p?.isConnected()),
        connectionClosed: !c.connection || Boolean(c.connectionClosed), decoderClosed: !c.decoder || Boolean(c.decoderClosed),
        streamsClosed: (c.streams || []).every(stream => stream.destroyed) },
      media: { url: `/api/v1/live-sessions/${c.id}/media`, contentType: 'multipart/x-mixed-replace; boundary=frame',
        decodedFrames: c.frames, bytes: c.bytes, connected: Boolean(c.client), audio: false },
      operations: structuredClone(c.operations), channelChecks: { ...c.channelChecks } };
  }
  start({ requestId, serial, maxDurationMs = 60000 }) {
    if (typeof requestId !== 'string' || !requestId.trim() || typeof serial !== 'string' || !serial.trim()
      || !Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 60000) return Promise.reject(failure('INVALID_REQUEST'));
    const old = this.requests.get(requestId);
    if (old) {
      if (old.serial !== serial || old.maxDurationMs !== maxDurationMs) return Promise.reject(failure('LIVE_REQUEST_CONFLICT'));
      return old.opening.then(() => this.get(old.id));
    }
    if (this.stopping) return Promise.reject(failure('SERVICE_STOPPING'));
    if (this.isBusy()) return Promise.reject(failure('SERVICE_BUSY'));
    const c = { id: randomUUID(), requestId, serial, maxDurationMs, state: 'opening', closed: false,
      controller: new AbortController(), operations: [], frames: 0, bytes: 0,
      expiresAt: Date.now() + maxDurationMs + 60000,
      channelChecks: { commandMatched: 0, commandRejected: 0, mediaMatched: 0, mediaRejected: 0 } };
    this.current = c; this.sessions.set(c.id, c); this.requests.set(requestId, c);
    c.opening = this._start(c);
    return c.opening.then(() => this.get(c.id));
  }
  _auth(c) {
    if (!isAuthenticated(this.session) || (c.api && c.api !== this.session.api)) throw failure('UNAUTHENTICATED');
    c.controller.signal.throwIfAborted();
  }
  _wait(c, operation, ms, code, allowClosing = false) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer);
        c.controller.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(value);
      };
      const aborted = () => finish(c.controller.signal.reason || failure('LIVE_INACTIVE'));
      const timer = setTimeout(() => finish(failure(code)), ms);
      if (!allowClosing) c.controller.signal.addEventListener('abort', aborted, { once: true });
      if (!allowClosing && c.controller.signal.aborted) aborted();
      else Promise.resolve().then(() => { if (!done) return operation(); }).then(value => finish(null, value), error => finish(safeError(error)));
    });
  }
  async _start(c) {
    try {
      this._auth(c); c.api = this.session.api;
      const device = await this._wait(c, () => this.resolveDevice(c.serial), this.startupMs, 'LIVE_CONNECTION_FAILED');
      this._auth(c);
      if (!device) throw failure('DEVICE_NOT_FOUND');
      c.scope = structuredClone(device.verificationScope); c.capability = structuredClone(device.capabilities.liveVideo);
      if (c.scope.model !== 'T8600' || c.scope.homeBase?.model !== 'T8030' || !Number.isInteger(c.scope.channel)
        || c.scope.channel < 0 || c.capability.status === 'unsupported') throw failure('LIVE_UNSUPPORTED');
      if (!['verified', 'protocol_hint'].includes(c.capability.status)) throw failure('LIVE_CAPABILITY_UNKNOWN');
      if (['offline', 'unavailable'].includes(device.availability)) throw failure('LIVE_DEVICE_OFFLINE');
      c.connection = this.createConnection();
      c.connecting = Promise.resolve().then(() => c.connection.connect(c.serial, { signal: c.controller.signal }));
      await this._wait(c, () => c.connecting, 50000, 'LIVE_CONNECTION_FAILED');
      this._auth(c);
      const camera = c.connection.camera, station = c.station = c.connection.station;
      c.p2p = station.p2pSession;
      if (camera.getSerial() !== c.scope.serial || camera.getModel() !== c.scope.model
        || camera.getStationSerial() !== c.scope.homeBase.serial || camera.getChannel() !== c.scope.channel
        || station.getSerial() !== c.scope.homeBase.serial || station.getModel() !== c.scope.homeBase.model) throw failure('LIVE_SCOPE_CHANGED');
      if (c.connection.verificationScope && scopeKey(c.connection.verificationScope) !== scopeKey(c.scope)) throw failure('LIVE_SCOPE_CHANGED');
      if (!c.p2p.isConnected()) throw failure('LIVE_CONNECTION_FAILED');
      if (c.p2p.isCurrentlyStreaming() || c.p2p.continuousPlayback) throw failure('SERVICE_BUSY');
      const fresh = await this._wait(c, () => this.resolveDevice(c.serial), this.startupMs, 'LIVE_CONNECTION_FAILED');
      this._auth(c);
      if (!fresh || scopeKey(fresh.verificationScope) !== scopeKey(c.scope)) throw failure('LIVE_SCOPE_CHANGED');
      if (['offline', 'unavailable'].includes(fresh.availability)) throw failure('LIVE_DEVICE_OFFLINE');
      if (fresh.capabilities.liveVideo.status === 'unsupported') throw failure('LIVE_UNSUPPORTED');
      if (!['verified', 'protocol_hint'].includes(fresh.capabilities.liveVideo.status)) throw failure('LIVE_CAPABILITY_UNKNOWN');
      c.firstFrame = new Promise(resolve => { c.frameReady = resolve; });
      this._listen(c);
      c.originalIdle = c.p2p.streamTimeouts?.streamDataWait;
      c.p2p.setStreamTimeouts?.({ streamDataWait: this.startupMs });
      c.authTimer = setInterval(() => { try { this._auth(c); } catch (error) { this._end(c, safeError(error)); } }, this.authPollMs);
      await this._command(c, 'start', () => station.startLivestream(camera));
      await this._wait(c, () => c.firstFrame, this.startupMs, 'LIVE_MEDIA_TIMEOUT');
      this._auth(c);
      c.p2p.setStreamTimeouts?.({ streamDataWait: c.originalIdle ?? 5000 });
      c.state = 'streaming'; c.expiresAt = Date.now() + c.maxDurationMs;
      c.durationTimer = setTimeout(() => this._end(c), c.maxDurationMs);
      c.attachTimer = setTimeout(() => this._end(c), this.attachMs);
    } catch (error) {
      const safe = c.error || safeError(error);
      await this._dispose(c, c.state === 'stopping' ? undefined : safe);
      throw safe;
    }
  }
  _listen(c) {
    const listen = (event, handler) => { c.station.on(event, handler); c.listeners.push([event, handler]); };
    c.listeners = [];
    listen('close', () => { if (!c.cleanup) this._end(c, failure('LIVE_CONNECTION_LOST')); });
    listen('connection error', () => this._end(c, failure('LIVE_CONNECTION_FAILED')));
    listen('livestream error', (_station, channel) => { if (channel === c.scope.channel) this._end(c, failure('LIVE_CONNECTION_LOST')); });
    listen('livestream stop', (_station, channel) => {
      if (channel === c.scope.channel && c.state !== 'stopping' && !c.cleanup) this._end(c, failure('LIVE_CONNECTION_LOST'));
    });
    listen('livestream start', (_station, channel, metadata, video, audio) => {
      if (channel !== c.scope.channel) { c.channelChecks.mediaRejected++; return; }
      if (c.cleanup || c.decoder) return;
      c.channelChecks.mediaMatched++; c.streams = [video, audio];
      const streamError = () => this._end(c, failure('LIVE_CONNECTION_LOST'));
      for (const stream of c.streams) stream.on('error', streamError);
      audio.resume();
      try {
        c.decoder = this.createDecoder({ video, metadata,
          onFrame: jpeg => {
            if (c.cleanup || c.controller.signal.aborted) return false;
            c.frames++; c.bytes += jpeg.length; c.latest = jpeg; c.frameReady();
            clearTimeout(c.mediaTimer);
            c.mediaTimer = setTimeout(() => this._end(c, failure('LIVE_MEDIA_TIMEOUT')), c.originalIdle ?? 5000);
            if (c.client) this._writeFrame(c);
            return true;
          }, onError: error => this._end(c, safeError(error)) });
      } catch (error) { this._end(c, safeError(error)); }
    });
  }
  async _command(c, operation, send) {
    const station = c.station;
    const name = operation === 'start' ? CommandName.DeviceStartLivestream : CommandName.DeviceStopLivestream;
    const observation = { operation, sentAtMs: Date.now(), returnCode: null }; c.operations.push(observation);
    let receive;
    try {
      await this._wait(c, () => new Promise((resolve, reject) => {
        receive = (_station, result) => {
          if (result.customData?.command?.name !== name) return;
          if (result.channel !== c.scope.channel) { c.channelChecks.commandRejected++; return; }
          c.channelChecks.commandMatched++;
          observation.returnCode = Number.isInteger(result.return_code) ? result.return_code : null;
          // Media callbacks can fail before the awaiting _start resumes.
          if (operation === 'start' && result.return_code === 0) c.startConfirmed = true;
          result.return_code === 0 ? resolve() : reject(failure('LIVE_COMMAND_REJECTED'));
        };
        station.on('command result', receive); send();
      }), this.commandMs, 'LIVE_COMMAND_TIMEOUT', operation === 'stop');
    } finally { if (receive) station.off('command result', receive); }
  }
  attach(id, response) {
    const c = this._find(id);
    this._auth(c);
    if (c.state !== 'streaming' || c.cleanup) throw c.error || failure('LIVE_INACTIVE');
    if (c.client) throw failure('LIVE_CLIENT_CONFLICT');
    clearTimeout(c.attachTimer); c.client = response;
    response.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store' });
    response.once('close', () => { c.client = null; if (!c.cleanup) this._end(c); });
    this._writeFrame(c);
  }
  _writeFrame(c) {
    if (!c.latest || c.client.destroyed || c.client.writableLength > 1024 * 1024) return;
    const header = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${c.latest.length}\r\n\r\n`);
    c.client.write(Buffer.concat([header, c.latest, Buffer.from('\r\n')]));
  }
  _end(c, error) { this._dispose(c, error).catch(() => {}); }
  _dispose(c, error) {
    if (c.cleanup) return c.cleanup;
    if (error) c.error = safeError(error);
    c.state = 'stopping'; c.controller.abort(c.error || failure('LIVE_INACTIVE'));
    for (const timer of [c.authTimer, c.durationTimer, c.attachTimer, c.mediaTimer]) clearTimeout(timer);
    c.cleanup = Promise.resolve().then(async () => {
      // A connection setup can complete after cancellation. Retain admission
      // ownership until that setup settles and its resources are also closed.
      await c.connecting?.catch(() => {});
      let cleanupError;
      if (c.startConfirmed && c.station?.p2pSession.isConnected() && c.station.isLiveStreaming(c.connection.camera)) {
        try { await this._command(c, 'stop', () => c.station.stopLivestream(c.connection.camera)); c.stopConfirmed = true; }
        catch (error) { c.error ||= safeError(error); }
      }
      for (const [event, handler] of c.listeners || []) c.station.off(event, handler);
      c.client?.end(); c.client = null; c.latest = null;
      for (const stream of c.streams || []) stream.destroy();
      try { await c.decoder?.close(); c.decoderClosed = true; } catch { cleanupError = failure('LIVE_CLEANUP_FAILED'); }
      try {
        await c.connection?.close();
        if (c.p2p?.isConnected()) throw failure('LIVE_CLEANUP_FAILED');
        c.connectionClosed = true;
      } catch { cleanupError = failure('LIVE_CLEANUP_FAILED'); }
      if (cleanupError) { c.error = cleanupError; c.state = 'failed'; throw cleanupError; }
      c.closed = true; c.state = c.error ? 'failed' : 'stopped';
      c.connection = c.p2p = c.station = c.decoder = null; c.streams = []; c.listeners = [];
    });
    return c.cleanup;
  }
  async stop(id) { const c = this._find(id); await this._dispose(c); return this.get(id); }
  async closeRequest(requestId) { const c = this.requests.get(requestId); if (c && !c.closed) await this.stop(c.id); }
  async closeActive() { if (this.current && !this.current.closed) await this.stop(this.current.id); }
  async shutdown() { this.stopping = true; await this.closeActive(); }
}

module.exports = { LiveSessions, failure, statuses };
