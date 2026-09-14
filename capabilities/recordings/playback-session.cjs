const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');
const { LocalContinuousRecordings } = require('./continuous.cjs');
const { createDecoder } = require('../live/decoder.cjs');
const { isAuthenticated } = require('../auth/session.cjs');
const { playbackControls, scopeKey } = require('../devices/capabilities.cjs');

const STARTUP_MS = 15000, STARTUP_TOTAL_MS = 60000, COMMAND_MS = 1500, MAX_PAUSE_MS = 30000;
const MEDIA_TYPE = 'multipart/x-mixed-replace; boundary=frame';
const statuses = { UNAUTHENTICATED: 401, DEVICE_NOT_FOUND: 404, PLAYBACK_SESSION_NOT_FOUND: 404,
  PLAYBACK_REQUEST_NOT_FOUND: 404, PLAYBACK_REQUEST_CONFLICT: 409, PLAYBACK_REQUEST_EXPIRED: 409,
  PLAYBACK_STALE_SESSION: 409, PLAYBACK_CLIENT_CONFLICT: 409, PLAYBACK_NO_RECORDING: 422,
  PLAYBACK_MEDIA_UNAVAILABLE: 422, PLAYBACK_MEDIA_TIMEOUT: 504, PLAYBACK_MEDIA_SLOW_CLIENT: 504,
  PLAYBACK_DECODER_FAILED: 502, PLAYBACK_RUNTIME_UNAVAILABLE: 503, CONTROL_NOT_VERIFIED: 409,
  SERVICE_BUSY: 409, CONTROL_INACTIVE: 409, CONTROL_SCOPE_CHANGED: 409, CONTROL_CONTEXT_UNAVAILABLE: 409,
  CONTROL_CONNECTION_LOST: 503, CONTROL_REJECTED: 502, CONTROL_RESPONSE_INVALID: 502, CONTROL_SEND_FAILED: 502,
  CONTROL_TIMEOUT: 504, CONTROL_STARTUP_TIMEOUT: 504, CONTROL_MEDIA_TIMEOUT: 504, CONTROL_CLEANUP_FAILED: 503,
  PAUSE_MEDIA_ADVANCED: 502, SERVICE_STOPPING: 503 };
const failure = code => Object.assign(new Error(code), { code, status: statuses[code] || 502 });
const safeError = error => statuses[error?.code] ? error : failure('CONTROL_SEND_FAILED');
const fingerprint = value => JSON.stringify(value);

// A resident session owns one P2P connection and, for media:true only, one
// bounded decoder/HTTP consumer. Request history is process-local identity.
class PlaybackSessions {
  constructor({ session, resolveDevice, createConnection = () => new LocalContinuousRecordings(session),
    createDecoder: decoder = createDecoder, residentEpoch = randomUUID(), attachMs = 10000,
    mediaIdleMs = 5000, mediaLeaseMs = 120000, authPollMs = 1000, scopePollMs = 5000, cleanupMs = 5000,
    startupMs = STARTUP_MS, startupTotalMs = STARTUP_TOTAL_MS }) {
    Object.assign(this, { session, resolveDevice, createConnection, createDecoder: decoder, residentEpoch,
      attachMs, mediaIdleMs, mediaLeaseMs, authPollMs, scopePollMs, cleanupMs, startupMs, startupTotalMs });
    this.current = null; this.operation = null; this.stopping = false;
    this.sessions = new Map(); this.requests = new Map();
  }
  isBusy() { return Boolean(this.operation || (this.current && !this.current.closed)); }
  hasRequest(id) { return this.requests.has(id); }
  get(id) {
    const c = this._find(id);
    const value = { sessionId: c.id, state: c.state, verificationScope: structuredClone(c.scope), speed: c.speed,
      positionMs: c.position ?? null, pauseExpiresAtMs: c.pauseExpiresAt ?? null, maxPauseMs: MAX_PAUSE_MS,
      allowedOperations: c.state === 'playing' && c.speed === 1 && c.controls.pauseResumeAtSpeed1 ? ['pause', 'close']
        : c.state === 'paused' && c.speed === 1 ? ['resume', 'close'] : c.closed ? [] : ['close'],
      verifiedStartSpeeds: [...c.controls.verifiedStartSpeeds], stopConfirmed: Boolean(c.stopConfirmed),
      cleanupComplete: Boolean(c.closed), error: c.error ? { code: c.error.code, message: c.error.code } : null,
      operations: structuredClone(c.operations), channelChecks: { ...c.channelChecks }, channelIsolation: 'unverified' };
    if (c.media) Object.assign(value, { requestId: c.requestId, residentEpoch: this.residentEpoch,
      window: structuredClone(c.requestWindow ?? { beginMs: c.begin * 1000, endMs: c.end * 1000 }),
      resources: { protocolClosed: !c.connection || Boolean(c.connectionClosed && !c.p2p?.isConnected()),
        connectionClosed: !c.connection || Boolean(c.connectionClosed), decoderClosed: c.decoderClosed !== false,
        streamsClosed: (c.streams || []).every(stream => stream.destroyed) } });
    if (c.media && c.mediaEpoch > 0 && Number.isSafeInteger(c.expiresAt)) Object.assign(value, {
      media: { url: `/api/v1/playback-sessions/${c.id}/media`, contentType: MEDIA_TYPE,
        timestampSemantics: 'source-received-position', sourceReceivedPositionMs: c.lastFrame?.sourceReceivedPositionMs ?? null,
        firstFrameLatencyMs: c.firstFrameLatencyMs ?? null,
        mediaEpoch: c.mediaEpoch, frameSequence: c.lastFrame?.frameSequence ?? 0,
        decodedFrames: c.frames, bytes: c.bytes, connected: Boolean(c.client), audio: false,
        maxFps: 5, maxWidth: 960, expiresAtMs: c.expiresAt } });
    return value;
  }
  getRequest(id, epoch) {
    if (epoch !== this.residentEpoch) throw failure('PLAYBACK_REQUEST_EXPIRED');
    const request = this.requests.get(id);
    if (!request) throw failure('PLAYBACK_REQUEST_NOT_FOUND');
    return { requestId: request.id, residentEpoch: this.residentEpoch, operation: request.operation,
      state: request.state, fromSessionId: request.fromSessionId ?? null, sessionId: request.session?.id ?? null,
      cleanupComplete: Boolean(request.session?.closed), error: request.error ? { code: request.error.code, message: request.error.code } : null };
  }
  _find(id) { const c = this.sessions.get(id); if (!c) throw failure('PLAYBACK_SESSION_NOT_FOUND'); return c; }
  async _exclusive(action) {
    if (this.operation) throw failure('SERVICE_BUSY');
    const operation = Promise.resolve().then(action); this.operation = operation;
    try { return await operation; }
    finally {
      if (this.operation === operation) this.operation = null;
      const c = this.current;
      if (c?.endReached && c.state === 'playing' && !c.closed) this.close(c.id).catch(() => {});
    }
  }
  _owned(c) { return c.owner && c.p2p?.continuousPlayback === c.owner && c.p2p.currentMessageState[1].p2pStreaming; }
  _bounded(work, ms, code) {
    let timer;
    return Promise.race([Promise.resolve(work), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure(code)), ms); })])
      .finally(() => clearTimeout(timer));
  }
  _requireControl(c) { if (c.error || c.closed || c.cleanup) throw c.error || failure('CONTROL_INACTIVE'); }
  async _check(c) {
    this._requireControl(c);
    if (!isAuthenticated(this.session) || this.session.api !== c.api) throw failure('UNAUTHENTICATED');
    if (!c.p2p.isConnected()) throw failure('CONTROL_CONNECTION_LOST');
    if (c.closed || !this._owned(c)) throw failure('CONTROL_INACTIVE');
    const device = await this._bounded(this.resolveDevice(c.scope.serial), this.startupMs, 'CONTROL_TIMEOUT');
    this._requireControl(c);
    if (!device || scopeKey(device.verificationScope) !== scopeKey(c.scope)) throw failure('CONTROL_SCOPE_CHANGED');
    const controls = playbackControls(device);
    if (!controls.verifiedStartSpeeds.includes(c.speed)
      || (c.controls.pauseResumeAtSpeed1 && !controls.pauseResumeAtSpeed1)) throw failure('CONTROL_NOT_VERIFIED');
    if (!isAuthenticated(this.session) || this.session.api !== c.api) throw failure('UNAUTHENTICATED');
    if (!c.p2p.isConnected()) throw failure('CONTROL_CONNECTION_LOST');
    if (!this._owned(c)) throw failure('CONTROL_INACTIVE');
  }
  _idle(c, ms) { c.p2p.setStreamTimeouts({ streamDataWait: ms }); if (this._owned(c)) c.p2p.waitForStreamData(1, true); }
  _listen(c) {
    c.originalEndStream = c.p2p.endStream;
    c.p2p.endStream = (type, sendStop, marker) => {
      if (type === 1 && this._owned(c) && c.state !== 'closing') {
        this._dispose(c, failure(c.starting ? 'CONTROL_STARTUP_TIMEOUT' : 'CONTROL_INACTIVE')).catch(() => {});
        return c.originalEndStream.call(c.p2p, type, false);
      }
      return c.originalEndStream.call(c.p2p, type, sendStop, marker);
    };
    c.frame = frame => {
      if (!this._owned(c) || frame.channel !== c.scope.channel) { c.channelChecks.mediaRejected++; return; }
      if (frame.kind !== 'video' || !Number.isSafeInteger(frame.timestamp) || frame.timestamp < c.begin * 1000) return;
      c.channelChecks.mediaMatched++; c.position = frame.timestamp;
      if (c.starting && frame.timestamp < c.end * 1000) { c.starting = false; this._idle(c, c.media ? this.startupMs + COMMAND_MS : c.originalIdle); c.rawReady?.(); }
      if (c.position >= c.end * 1000) {
        c.endReached = true;
        c.endReady?.();
        if (!this.operation && ['playing', 'paused'].includes(c.state)) this.close(c.id).catch(() => {});
        return;
      }
      if (c.state === 'paused' && c.position > c.pausePosition) { this._dispose(c, failure('PAUSE_MEDIA_ADVANCED')).catch(() => {}); return; }
      if (c.media && Buffer.isBuffer(frame.data)) this._mediaInput(c, frame);
    };
    c.drain = (channel, metadata, video, audio) => {
      if (channel !== c.scope.channel || !this._owned(c)) return;
      c.metadata = metadata; c.streams = [video, audio]; video.resume(); audio.resume();
      if (c.pendingKeyframe) { const frame = c.pendingKeyframe; c.pendingKeyframe = null; this._mediaInput(c, frame); }
    };
    c.disconnected = () => { if (c.state !== 'closing' && !c.closed) this._dispose(c, failure('CONTROL_CONNECTION_LOST')).catch(() => {}); };
    c.stopped = channel => { if (channel === c.scope.channel && c.state !== 'closing' && !c.closed) this._dispose(c, failure('CONTROL_INACTIVE')).catch(() => {}); };
    c.p2p.on('continuous playback frame', c.frame); c.p2p.on('livestream started', c.drain);
    c.p2p.on('close', c.disconnected); c.p2p.on('livestream stopped', c.stopped);
  }
  _mediaInput(c, frame) {
    if (c.cleanup || !['opening', 'playing', 'resuming'].includes(c.state) || frame.timestamp <= (c.resumeAfter ?? -1)) return;
    if (!c.decoder) {
      if (!frame.keyFrame) return;
      if (!c.metadata) { c.pendingKeyframe = frame.data.length <= 1024 * 1024 ? { ...frame, data: Buffer.from(frame.data) } : null; return; }
      this._openDecoder(c);
    }
    if (!c.feed) return;
    c.sourceReceivedPosition = frame.timestamp;
    if (c.feed.writableLength + frame.data.length > 8 * 1024 * 1024) return this._end(c, failure('PLAYBACK_DECODER_FAILED'));
    c.feed.write(frame.data);
  }
  _openDecoder(c) {
    c.feed = new PassThrough({ highWaterMark: 1024 * 1024 }); c.decoderClosed = false; c.mediaEpoch++;
    const epoch = c.mediaEpoch;
    try {
      c.decoderClose = null;
      c.decoder = this.createDecoder({ video: c.feed, metadata: c.metadata,
        onFrame: jpeg => this._decoded(c, epoch, jpeg),
        onError: error => this._end(c, failure(error?.code === 'LIVE_RUNTIME_UNAVAILABLE' ? 'PLAYBACK_RUNTIME_UNAVAILABLE' : 'PLAYBACK_DECODER_FAILED')) });
    } catch (error) { this._end(c, failure(error?.code === 'LIVE_RUNTIME_UNAVAILABLE' ? 'PLAYBACK_RUNTIME_UNAVAILABLE' : 'PLAYBACK_DECODER_FAILED')); }
  }
  _decoded(c, epoch, jpeg) {
    if (c.cleanup || epoch !== c.mediaEpoch || !Buffer.isBuffer(jpeg) || jpeg.length > 1024 * 1024) return;
    if (!Number.isSafeInteger(c.sourceReceivedPosition)) return;
    c.frames++; c.bytes += jpeg.length;
    c.lastFrame = { jpeg: Buffer.from(jpeg), mediaEpoch: epoch, frameSequence: c.frames,
      sourceReceivedPositionMs: c.sourceReceivedPosition };
    clearTimeout(c.mediaTimer); c.mediaTimer = setTimeout(() => this._end(c, failure('PLAYBACK_MEDIA_TIMEOUT')), this.mediaIdleMs);
    if (!c.firstFrameAt) {
      c.firstFrameAt = Date.now(); c.firstFrameLatencyMs = c.firstFrameAt - c.acceptedAt; c.firstFrame?.(); c.firstFrame = c.firstFrameReject = null;
      c.attachTimer = setTimeout(() => { if (!c.client) this._end(c, failure('PLAYBACK_MEDIA_TIMEOUT')); }, this.attachMs);
    }
    c.epochFrame?.(); c.epochFrame = c.epochFrameReject = null;
    if (c.client) this._writeFrame(c, c.lastFrame);
  }
  _part(c, frame) {
    const headers = ['--frame', 'Content-Type: image/jpeg', `Content-Length: ${frame.jpeg.length}`,
      `X-Playback-Session-Id: ${c.id}`, `X-Playback-Request-Id: ${c.requestId}`,
      `X-Playback-Media-Epoch: ${frame.mediaEpoch}`, `X-Playback-Frame-Sequence: ${frame.frameSequence}`,
      `X-Playback-Source-Received-Ms: ${frame.sourceReceivedPositionMs}`, '', ''].join('\r\n');
    return Buffer.concat([Buffer.from(headers, 'ascii'), frame.jpeg, Buffer.from('\r\n')]);
  }
  _writeFrame(c, frame = c.lastFrame) {
    if (!frame || !c.client || c.cleanup || c.state === 'paused' || c.state === 'pausing') return;
    if (c.waitingDrain) { c.pendingFrame = frame; return; }
    const part = this._part(c, frame);
    if (part.length > 1024 * 1024 || c.client.writableLength + part.length > 1024 * 1024) {
      c.pendingFrame = frame;
      c.slowTimer ||= setTimeout(() => this._end(c, failure('PLAYBACK_MEDIA_SLOW_CLIENT')), 5000);
      return;
    }
    c.waitingDrain = true;
    const accepted = c.client.write(part, error => {
      c.waitingDrain = false; clearTimeout(c.slowTimer); c.slowTimer = null;
      if (error) return this._end(c, failure('PLAYBACK_MEDIA_SLOW_CLIENT'));
      const latest = c.pendingFrame; c.pendingFrame = null; this._writeFrame(c, latest);
    });
    if (!accepted) c.slowTimer ||= setTimeout(() => this._end(c, failure('PLAYBACK_MEDIA_SLOW_CLIENT')), 5000);
  }
  async attach(id, response) {
    const c = this._find(id); if (!c.media) throw failure('PLAYBACK_MEDIA_UNAVAILABLE');
    if (c.client) throw failure('PLAYBACK_CLIENT_CONFLICT');
    if (c.closed || c.cleanup || !['playing', 'resuming', 'paused'].includes(c.state)) throw c.error || failure('CONTROL_INACTIVE');
    await this._check(c); this._requireControl(c);
    clearTimeout(c.attachTimer); c.client = response;
    response.writeHead(200, { 'Content-Type': MEDIA_TYPE, 'Cache-Control': 'no-store', Connection: 'close' });
    response.once('close', () => { if (c.client === response) c.client = null; if (!c.cleanup) this._end(c); });
    if (c.state === 'playing') this._writeFrame(c); return response;
  }
  _wait(c, event, select, action, ms, code = 'CONTROL_TIMEOUT', allowStop = false) {
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); c.p2p.off(event, receive); c.p2p.off('close', closed); c.p2p.off('livestream stopped', stopped); };
      const finish = (error, value) => { clean(); error ? reject(error) : resolve(value); };
      const receive = (...args) => { try { const value = select(...args); if (value !== undefined) finish(null, value); } catch (error) { finish(safeError(error)); } };
      const closed = () => finish(failure('CONTROL_CONNECTION_LOST'));
      const stopped = channel => { if (!allowStop && channel === c.scope.channel) finish(failure('CONTROL_INACTIVE')); };
      const timer = setTimeout(() => finish(failure(code)), ms);
      c.p2p.on(event, receive); c.p2p.on('close', closed); c.p2p.on('livestream stopped', stopped);
      try { action(); } catch (error) { finish(safeError(error)); }
    });
  }
  async _command(c, operation, send, onAck = () => {}, ms = COMMAND_MS) {
    this._requireControl(c);
    const marker = {}, observation = { operation, sentAtMs: Date.now(), receivedAtMs: null, returnCode: null };
    c.operations.push(observation);
    await this._wait(c, 'command', response => {
      if (response.command_type !== 6001 || response.customData !== marker) return;
      if (response.channel !== c.scope.channel) { c.channelChecks.commandRejected++; return; }
      this._requireControl(c); c.channelChecks.commandMatched++; observation.receivedAtMs = Date.now();
      if (!Number.isInteger(response.return_code)) throw failure('CONTROL_RESPONSE_INVALID');
      observation.returnCode = response.return_code; if (response.return_code !== 0) throw failure('CONTROL_REJECTED');
      onAck(); return true;
    }, () => send(marker), ms, 'CONTROL_TIMEOUT', operation === 'stop');
  }
  start(input) {
    const { serial, begin, end, speed = 1, media = false, requestId, residentEpoch, requestWindow } = input;
    if (media && (residentEpoch !== this.residentEpoch || typeof requestId !== 'string' || !requestId.trim()))
      return Promise.reject(failure(residentEpoch !== this.residentEpoch ? 'PLAYBACK_REQUEST_EXPIRED' : 'CONTROL_CONTEXT_UNAVAILABLE'));
    const key = fingerprint({ operation: 'create', serial, begin, end, speed, media: Boolean(media), requestWindow });
    if (media) {
      const old = this.requests.get(requestId);
      if (old) return old.fingerprint === key ? old.promise : Promise.reject(failure('PLAYBACK_REQUEST_CONFLICT'));
    }
    if (this.stopping) return Promise.reject(failure('SERVICE_STOPPING'));
    if (this.isBusy()) return Promise.reject(failure('SERVICE_BUSY'));
    const c = this._context({ serial, begin, end, speed, media: Boolean(media), requestId, requestWindow });
    const request = media ? { id: requestId, operation: 'create', fingerprint: key, state: 'pending', session: c } : null;
    if (request) this.requests.set(requestId, request);
    const promise = this._exclusive(() => this._start(c));
    if (request) { request.promise = promise.then(value => { request.state = 'succeeded'; return value; }, error => { request.state = 'failed'; request.error = error; throw error; }); return request.promise; }
    return promise;
  }
  _context({ serial, begin, end, speed, media, requestId, requestWindow }) {
    const c = { id: randomUUID(), serial, state: 'opening', begin, end, speed, media, requestId, requestWindow, acceptedAt: Date.now(),
      scope: { serial, model: null, firmware: { main: null, secondary: null }, homeBase: null, channel: null },
      controls: { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] },
      closed: false, operations: [], mediaEpoch: 0, frames: 0, bytes: 0, streams: [],
      channelChecks: { queryMatched: 0, queryRejected: 0, commandMatched: 0, commandRejected: 0, mediaMatched: 0, mediaRejected: 0 } };
    this.current = c; this.sessions.set(c.id, c); return c;
  }
  async _start(c) {
    try {
      const startupDeadline = Date.now() + this.startupTotalMs;
      const remaining = () => Math.max(1, Math.min(this.startupMs, startupDeadline - Date.now()));
      if (!isAuthenticated(this.session)) throw failure('UNAUTHENTICATED');
      if (!Number.isSafeInteger(c.begin) || !Number.isSafeInteger(c.end) || c.end <= c.begin || c.end - c.begin > 60)
        throw failure('CONTROL_CONTEXT_UNAVAILABLE');
      const api = this.session.api, device = await this._bounded(this.resolveDevice(c.serial), remaining(), 'CONTROL_STARTUP_TIMEOUT'), controls = playbackControls(device);
      if (c.media && c.speed !== 1) throw failure('CONTROL_NOT_VERIFIED');
      if (![1, 2, 4, 16].includes(c.speed) || !controls.verifiedStartSpeeds.includes(c.speed)) throw failure('CONTROL_NOT_VERIFIED');
      if (!isAuthenticated(this.session) || this.session.api !== api) throw failure('UNAUTHENTICATED');
      c.scope = structuredClone(device.verificationScope); c.controls = controls; c.api = api;
      try {
        c.connection = this.createConnection(); c.abortController = new AbortController();
        c.connecting = Promise.resolve().then(() => c.connection.connect(c.serial, { signal: c.abortController.signal }));
        await this._bounded(c.connecting, remaining(), 'CONTROL_STARTUP_TIMEOUT'); c.connecting = null;
      } catch (error) {
        c.abortController?.abort(error); throw error?.code === 'CONTROL_STARTUP_TIMEOUT' ? error : failure('CONTROL_CONNECTION_LOST');
      }
      c.p2p = c.connection.station.p2pSession;
      const camera = c.connection.camera, base = c.connection.station;
      if (camera.getSerial() !== c.scope.serial || camera.getModel() !== c.scope.model || camera.getStationSerial() !== c.scope.homeBase.serial
        || camera.getChannel() !== c.scope.channel || base.getSerial() !== c.scope.homeBase.serial || base.getModel() !== c.scope.homeBase.model)
        throw failure('CONTROL_SCOPE_CHANGED');
      if (!c.p2p.isConnected()) throw failure('CONTROL_CONNECTION_LOST');
      if (c.p2p.isCurrentlyStreaming() || c.p2p.continuousPlayback || c.p2p.sendQueue.some(row => row.nestedCommandType === 6001)
        || [...c.p2p.messageStates.values()].some(row => row.nestedCommandType === 6001)) throw failure('SERVICE_BUSY');
      c.originalIdle = c.p2p.streamTimeouts.streamDataWait;
      const ranges = await this._wait(c, 'continuous recording ranges', (channel, data) => {
        if (channel !== c.scope.channel) { c.channelChecks.queryRejected++; return; }
        if (data?.begin_time !== c.begin || data?.end_time !== c.end) return;
        c.channelChecks.queryMatched++; return data;
      }, () => c.p2p.queryContinuousRecordings(c.serial, c.scope.channel, c.begin, c.end), remaining());
      const records = ranges.videos?.filter(row => Number.isSafeInteger(row.start_time) && Number.isSafeInteger(row.stop_time)
        && row.start_time <= c.begin && row.stop_time >= c.end);
      if (records?.length !== 1 || (records[0].file_path != null && typeof records[0].file_path !== 'string'))
        throw failure(c.media ? 'PLAYBACK_NO_RECORDING' : 'CONTROL_CONTEXT_UNAVAILABLE');
      c.filePath = typeof records[0].file_path === 'string' ? records[0].file_path : undefined;
      if (typeof c.connection.userId !== 'string' || !c.connection.userId) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
      const fresh = await this._bounded(this.resolveDevice(c.serial), remaining(), 'CONTROL_STARTUP_TIMEOUT');
      if (!isAuthenticated(this.session) || this.session.api !== api) throw failure('UNAUTHENTICATED');
      if (scopeKey(fresh.verificationScope) !== scopeKey(c.scope)) throw failure('CONTROL_SCOPE_CHANGED');
      if (!playbackControls(fresh).verifiedStartSpeeds.includes(c.speed)) throw failure('CONTROL_NOT_VERIFIED');
      this._listen(c); c.starting = true; this._idle(c, remaining());
      const rawReady = new Promise(resolve => { c.rawReady = resolve; });
      const firstFrame = c.media ? new Promise((resolve, reject) => { c.firstFrame = resolve; c.firstFrameReject = reject; }) : null;
      await this._command(c, 'start', marker => {
        try { c.p2p.startContinuousPlayback(c.serial, c.scope.channel, c.connection.userId, c.begin,
          { speed: c.speed, filePath: c.filePath, customData: marker }); }
        finally { c.owner = c.p2p.continuousPlayback; }
      }, () => {}, remaining());
      if (c.starting) await Promise.race([rawReady, new Promise((_resolve, reject) => setTimeout(() => reject(failure('CONTROL_STARTUP_TIMEOUT')), remaining())) ]);
      if (c.media && !c.firstFrameAt) await Promise.race([firstFrame, new Promise((_resolve, reject) => setTimeout(() => reject(failure('PLAYBACK_MEDIA_TIMEOUT')), remaining())) ]);
      if (c.error) throw c.error;
      await this._check(c); this._requireControl(c); c.state = 'playing';
      if (c.media) this._startMediaGuards(c);
      return this.get(c.id);
    } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
  }
  _startMediaGuards(c) {
    this._idle(c, Math.max(c.originalIdle, this.mediaIdleMs + COMMAND_MS));
    c.expiresAt = Date.now() + this.mediaLeaseMs;
    c.durationTimer = setTimeout(() => this._end(c), this.mediaLeaseMs);
    const auth = () => { if (c.cleanup) return;
      if (!isAuthenticated(this.session) || this.session.api !== c.api) return this._end(c, failure('UNAUTHENTICATED'));
      c.authTimer = setTimeout(auth, this.authPollMs); };
    c.authTimer = setTimeout(auth, this.authPollMs);
    const scope = async () => { if (c.cleanup) return; try { await this._check(c); } catch (error) { return this._end(c, safeError(error)); }
      if (!c.cleanup) c.scopeTimer = setTimeout(scope, this.scopePollMs); };
    c.scopeTimer = setTimeout(scope, this.scopePollMs);
  }
  async _closeDecoder(c) {
    c.mediaEpoch++; c.pendingFrame = c.pendingKeyframe = null; clearTimeout(c.mediaTimer); c.mediaTimer = null;
    c.feed?.destroy(); c.feed = null;
    const decoder = c.decoder; if (!decoder) { c.decoderClosed = true; return; }
    if (!c.decoderClose) c.decoderClose = this._bounded(Promise.resolve().then(() => decoder.close()), this.cleanupMs, 'CONTROL_CLEANUP_FAILED')
      .then(() => { if (c.decoder === decoder) c.decoder = null; c.decoderClosed = true; c.decoderClose = null; },
        () => { c.decoderClosed = false; throw failure('CONTROL_CLEANUP_FAILED'); });
    await c.decoderClose;
  }
  async _control(id, operation) {
    return this._exclusive(async () => {
      const c = this._find(id);
      if (c.closed || c.error) throw c.error || failure('CONTROL_INACTIVE');
      if (c.speed !== 1 || !c.controls.pauseResumeAtSpeed1) throw failure('CONTROL_NOT_VERIFIED');
      if (c.state !== (operation === 'pause' ? 'playing' : 'paused')) throw failure('CONTROL_INACTIVE');
      try {
        await this._check(c); this._requireControl(c);
        if (!Number.isSafeInteger(c.position) || c.position < c.begin * 1000 || c.position >= c.end * 1000) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
        if (operation === 'pause') { c.pausePosition = c.position; c.state = 'pausing'; if (c.media) await this._closeDecoder(c); }
        else { clearTimeout(c.pauseTimer); c.pauseExpiresAt = null; c.state = 'resuming'; c.resumeAfter = c.pausePosition; this._idle(c, c.originalIdle); }
        const epochFrame = operation === 'resume' && c.media ? new Promise((resolve, reject) => { c.epochFrame = resolve; c.epochFrameReject = reject; }) : null;
        const endFrame = operation === 'resume' ? new Promise(resolve => { c.endReady = resolve; }) : null;
        await this._command(c, operation, marker => c.p2p.sendCommandWithStringPayload({ commandType: 1700, channel: c.scope.channel,
          value: JSON.stringify({ commandType: 6001, data: { session_id: 125, cmd: operation === 'pause' ? 1 : 2,
            play_type: 0, play_speed: 1, begin_time: operation === 'pause' ? 0 : Math.floor(c.position / 1000),
            file_path: operation === 'pause' ? '' : c.filePath, device_sn: c.scope.serial, index: 0 } }) }, marker));
        if (c.endReached) return await this._finish(c);
        if (operation === 'pause') {
          c.state = 'paused'; this._idle(c, MAX_PAUSE_MS + COMMAND_MS); c.pauseExpiresAt = Date.now() + MAX_PAUSE_MS;
          c.pauseTimer = setTimeout(() => { if (this.operation) this._dispose(c, failure('CONTROL_INACTIVE')).catch(() => {}); else this.close(c.id).catch(() => {}); }, MAX_PAUSE_MS);
        }
        if (operation === 'resume') {
          if (c.position <= c.pausePosition) {
            const advanced = await this._wait(c, 'continuous playback frame', () => c.endReached ? 'end' : c.position > c.pausePosition ? 'advanced' : undefined, () => {}, c.originalIdle, 'CONTROL_MEDIA_TIMEOUT');
            if (advanced === 'end' || c.endReached) return await this._finish(c);
          }
          if (c.media) {
            const result = await Promise.race([epochFrame.then(() => 'frame'), endFrame.then(() => 'end'),
              new Promise((_resolve, reject) => setTimeout(() => reject(failure('PLAYBACK_MEDIA_TIMEOUT')), this.startupMs))]);
            if (result === 'end' || c.endReached) return await this._finish(c);
          }
          c.resumeAfter = null; c.state = 'playing';
        }
        if (c.error) throw c.error; return this.get(id);
      } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
      finally { c.endReady = null; }
    });
  }
  pause(id) { return this._control(id, 'pause'); }
  resume(id) { return this._control(id, 'resume'); }
  seek(id, input) {
    const { requestId, residentEpoch, begin, end, requestWindow } = input;
    if (residentEpoch !== this.residentEpoch) return Promise.reject(failure('PLAYBACK_REQUEST_EXPIRED'));
    if (typeof requestId !== 'string' || !requestId.trim()) return Promise.reject(failure('CONTROL_CONTEXT_UNAVAILABLE'));
    const key = fingerprint({ operation: 'seek', fromSessionId: id, begin, end, requestWindow });
    const old = this.requests.get(requestId);
    if (old) return old.fingerprint === key ? old.promise : Promise.reject(failure('PLAYBACK_REQUEST_CONFLICT'));
    if (this.stopping) return Promise.reject(failure('SERVICE_STOPPING'));
    if (this.operation) return Promise.reject(failure('SERVICE_BUSY'));
    const from = this._find(id);
    if (from !== this.current || from.closed || !from.media) return Promise.reject(failure('PLAYBACK_STALE_SESSION'));
    const request = { id: requestId, operation: 'seek', fromSessionId: id, fingerprint: key, state: 'pending' };
    this.requests.set(requestId, request);
    const promise = this._exclusive(async () => {
      try {
        from.state = 'closing'; clearTimeout(from.pauseTimer); from.pauseExpiresAt = null;
        if (!from.error && from.p2p?.isConnected() && this._owned(from)) {
          this._idle(from, from.originalIdle); await this._command(from, 'stop', marker => from.p2p.stopContinuousPlayback(marker)); from.stopConfirmed = true;
        }
        await this._dispose(from);
        const c = this._context({ serial: from.serial, begin, end, speed: 1, media: true, requestId, requestWindow });
        request.session = c; return await this._start(c);
      } catch (error) { throw safeError(error); }
    });
    request.promise = promise.then(value => { request.state = 'succeeded'; return value; }, error => { request.state = 'failed'; request.error = error; throw error; });
    return request.promise;
  }
  close(id) {
    const found = this._find(id); if (found.closed) return Promise.resolve(this.get(id));
    return this._exclusive(async () => {
      const c = this._find(id); if (c.closed) return this.get(id);
      if (c !== this.current) throw failure('PLAYBACK_STALE_SESSION');
      try {
        return await this._finish(c);
      } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
    });
  }
  async _finish(c) {
    if (!c.error) c.state = 'closing'; clearTimeout(c.pauseTimer); c.pauseExpiresAt = null;
    if (!c.error && c.p2p?.isConnected() && this._owned(c)) {
      this._idle(c, c.originalIdle); await this._command(c, 'stop', marker => c.p2p.stopContinuousPlayback(marker)); c.stopConfirmed = true;
    }
    await this._dispose(c); return this.get(c.id);
  }
  _end(c, error) {
    if (error) { c.firstFrameReject?.(error); c.epochFrameReject?.(error); c.firstFrameReject = c.epochFrameReject = null; }
    if (!c.cleanup) this._dispose(c, error).catch(() => {});
  }
  _dispose(c, error) {
    if (error) { c.error ||= error; c.state = 'failed'; }
    if (c.cleanup) return c.cleanup;
    if (!error && !c.closed) c.state = 'closing';
    c.cleanup = (async () => {
      c.abortController?.abort(error || failure('CONTROL_INACTIVE'));
      for (const timer of [c.pauseTimer, c.attachTimer, c.mediaTimer, c.durationTimer, c.authTimer, c.scopeTimer, c.slowTimer]) clearTimeout(timer);
      c.pauseExpiresAt = null; c.pendingFrame = c.pendingKeyframe = c.lastFrame = null;
      if (c.client) { const response = c.client; c.client = null; response.end(); }
      let cleanupError;
      try { await this._closeDecoder(c); } catch { cleanupError = failure('CONTROL_CLEANUP_FAILED'); }
      for (const stream of c.streams || []) stream.destroy();
      const p2p = c.p2p;
      if (p2p) {
        if (c.owner && p2p.continuousPlayback && p2p.continuousPlayback !== c.owner) cleanupError ||= failure('CONTROL_INACTIVE');
        if (c.frame) { p2p.off('continuous playback frame', c.frame); p2p.off('livestream started', c.drain); p2p.off('close', c.disconnected); p2p.off('livestream stopped', c.stopped); }
        if (c.originalIdle !== undefined) p2p.setStreamTimeouts({ streamDataWait: c.originalIdle });
        clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
        const originalClose = p2p.close; let closing;
        p2p.close = () => closing ||= Promise.resolve().then(() => originalClose.call(p2p));
        try {
          try {
            const work = (async () => { if (p2p.isConnected()) await p2p.close(); await c.connection.close(); if (closing) await closing;
              if (p2p.isConnected()) throw failure('CONTROL_CLEANUP_FAILED'); })();
            let timeout; try { await Promise.race([work, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(failure('CONTROL_CLEANUP_FAILED')), this.cleanupMs); })]); }
            finally { clearTimeout(timeout); work.catch(() => {}); }
          }
          catch { cleanupError ||= failure('CONTROL_CLEANUP_FAILED'); }
        } finally { p2p.close = originalClose; if (c.originalEndStream) p2p.endStream = c.originalEndStream; }
      } else try {
        const work = Promise.resolve(c.connecting).catch(() => {}).then(() => c.connection?.close());
        let timeout; try { await Promise.race([work, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(failure('CONTROL_CLEANUP_FAILED')), this.cleanupMs); })]); }
        finally { clearTimeout(timeout); work.catch(() => {}); }
      } catch { cleanupError ||= failure('CONTROL_CLEANUP_FAILED'); }
      if (cleanupError) throw cleanupError;
      c.connectionClosed = true; c.closed = true; c.state = c.error ? 'failed' : 'closed';
    })().catch(() => { c.error = failure('CONTROL_CLEANUP_FAILED'); c.state = 'failed'; throw c.error; });
    return c.cleanup;
  }
  async closeActive() { await this.operation?.catch(() => {}); if (this.current && !this.current.closed) await this.close(this.current.id); }
  async shutdown() { this.stopping = true; await this.closeActive(); }
}

module.exports = { PlaybackSessions, MAX_PAUSE_MS, MEDIA_TYPE, statuses };
