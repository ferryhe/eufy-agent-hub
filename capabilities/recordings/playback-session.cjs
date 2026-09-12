const { randomUUID } = require('node:crypto');
const { LocalContinuousRecordings } = require('./continuous.cjs');
const { isAuthenticated } = require('../auth/session.cjs');
const { playbackControls, scopeKey } = require('../devices/capabilities.cjs');

const STARTUP_MS = 15000, COMMAND_MS = 1500, MAX_PAUSE_MS = 30000;
const statuses = { UNAUTHENTICATED: 401, PLAYBACK_SESSION_NOT_FOUND: 404, CONTROL_NOT_VERIFIED: 409,
  SERVICE_BUSY: 409, CONTROL_INACTIVE: 409, CONTROL_SCOPE_CHANGED: 409, CONTROL_CONTEXT_UNAVAILABLE: 409,
  CONTROL_CONNECTION_LOST: 503, CONTROL_REJECTED: 502, CONTROL_RESPONSE_INVALID: 502, CONTROL_SEND_FAILED: 502,
  CONTROL_TIMEOUT: 504, CONTROL_STARTUP_TIMEOUT: 504, CONTROL_MEDIA_TIMEOUT: 504, CONTROL_CLEANUP_FAILED: 503,
  PAUSE_MEDIA_ADVANCED: 502, SERVICE_STOPPING: 503 };
const failure = code => Object.assign(new Error(code), { code, status: statuses[code] || 502 });
const safeError = error => statuses[error?.code] ? error : failure('CONTROL_SEND_FAILED');

// A resident control session owns its connection until awaited cleanup completes.
// No credentials, file paths, payloads or frame buffers are included in views.
class PlaybackSessions {
  constructor({ session, resolveDevice, createConnection = () => new LocalContinuousRecordings(session) }) {
    Object.assign(this, { session, resolveDevice, createConnection, current: null, operation: null, stopping: false });
  }
  isBusy() { return Boolean(this.operation || (this.current && !this.current.closed)); }
  get(id) {
    const c = this._find(id);
    return { sessionId: c.id, state: c.state, verificationScope: structuredClone(c.scope), speed: c.speed,
      positionMs: c.position ?? null, pauseExpiresAtMs: c.pauseExpiresAt ?? null, maxPauseMs: MAX_PAUSE_MS,
      allowedOperations: c.state === 'playing' && c.speed === 1 && c.controls.pauseResumeAtSpeed1 ? ['pause', 'close']
        : c.state === 'paused' && c.speed === 1 ? ['resume', 'close'] : c.closed ? [] : ['close'],
      verifiedStartSpeeds: [...c.controls.verifiedStartSpeeds], stopConfirmed: Boolean(c.stopConfirmed),
      error: c.error ? { code: c.error.code, message: c.error.code } : null,
      operations: structuredClone(c.operations), channelChecks: { ...c.channelChecks },
      channelIsolation: 'unverified' };
  }
  _find(id) {
    if (!this.current || this.current.id !== id) throw failure('PLAYBACK_SESSION_NOT_FOUND');
    return this.current;
  }
  async _exclusive(action) {
    if (this.operation) throw failure('SERVICE_BUSY');
    const operation = Promise.resolve().then(action); this.operation = operation;
    try { return await operation; }
    finally {
      this.operation = null;
      const c = this.current;
      if (c?.endReached && c.state === 'playing' && !c.closed) this.close(c.id).catch(() => {});
    }
  }
  _owned(c) { return c.owner && c.p2p.continuousPlayback === c.owner && c.p2p.currentMessageState[1].p2pStreaming; }
  _requireControl(c) {
    if (c.error || c.closed || c.cleanup) throw c.error || failure('CONTROL_INACTIVE');
  }
  async _check(c) {
    this._requireControl(c);
    if (!isAuthenticated(this.session) || this.session.api !== c.api) throw failure('UNAUTHENTICATED');
    if (!c.p2p.isConnected()) throw failure('CONTROL_CONNECTION_LOST');
    if (c.closed || !this._owned(c)) throw failure('CONTROL_INACTIVE');
    const device = await this.resolveDevice(c.scope.serial);
    this._requireControl(c);
    if (!device || scopeKey(device.verificationScope) !== scopeKey(c.scope)) throw failure('CONTROL_SCOPE_CHANGED');
    const controls = playbackControls(device);
    if (!controls.verifiedStartSpeeds.includes(c.speed)
      || (c.controls.pauseResumeAtSpeed1 && !controls.pauseResumeAtSpeed1)) throw failure('CONTROL_NOT_VERIFIED');
    if (!isAuthenticated(this.session) || this.session.api !== c.api) throw failure('UNAUTHENTICATED');
    if (!c.p2p.isConnected()) throw failure('CONTROL_CONNECTION_LOST');
    if (!this._owned(c)) throw failure('CONTROL_INACTIVE');
  }
  _idle(c, ms) {
    c.p2p.setStreamTimeouts({ streamDataWait: ms });
    if (this._owned(c)) c.p2p.waitForStreamData(1, true);
  }
  _listen(c) {
    // A device/idle stop must never enqueue an uncorrelated cmd3 behind a
    // resident operation. Invalidate this owner and close its dedicated P2P.
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
      c.channelChecks.mediaMatched++;
      c.position = frame.timestamp;
      if (c.starting && frame.timestamp < c.end * 1000) {
        c.starting = false; this._idle(c, c.originalIdle);
      }
      if (c.state === 'paused' && c.position > c.pausePosition) {
        this._dispose(c, failure('PAUSE_MEDIA_ADVANCED')).catch(() => {}); return;
      }
      if (c.position >= c.end * 1000) {
        c.endReached = true;
        if (!this.operation && c.state === 'playing') this.close(c.id).catch(() => {});
      }
    };
    c.drain = (channel, _metadata, video, audio) => { if (channel === c.scope.channel && this._owned(c)) { video.resume(); audio.resume(); } };
    c.disconnected = () => { if (c.state !== 'closing' && !c.closed) this._dispose(c, failure('CONTROL_CONNECTION_LOST')).catch(() => {}); };
    c.stopped = channel => { if (channel === c.scope.channel && c.state !== 'closing' && !c.closed) this._dispose(c, failure('CONTROL_INACTIVE')).catch(() => {}); };
    c.p2p.on('continuous playback frame', c.frame); c.p2p.on('livestream started', c.drain);
    c.p2p.on('close', c.disconnected); c.p2p.on('livestream stopped', c.stopped);
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
      this._requireControl(c);
      c.channelChecks.commandMatched++;
      observation.receivedAtMs = Date.now();
      if (!Number.isInteger(response.return_code)) throw failure('CONTROL_RESPONSE_INVALID');
      observation.returnCode = response.return_code;
      if (response.return_code !== 0) throw failure('CONTROL_REJECTED');
      onAck(); return true;
    }, () => send(marker), ms, 'CONTROL_TIMEOUT', operation === 'stop');
  }
  async start({ serial, begin, end, speed = 1 }) {
    if (this.stopping) throw failure('SERVICE_STOPPING');
    if (this.isBusy()) throw failure('SERVICE_BUSY');
    return this._exclusive(async () => {
      if (!isAuthenticated(this.session)) throw failure('UNAUTHENTICATED');
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin || end - begin > 60) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
      const api = this.session.api, device = await this.resolveDevice(serial), controls = playbackControls(device);
      if (![1, 2, 4, 16].includes(speed) || !controls.verifiedStartSpeeds.includes(speed)) throw failure('CONTROL_NOT_VERIFIED');
      if (!isAuthenticated(this.session) || this.session.api !== api) throw failure('UNAUTHENTICATED');
      const c = this.current = { id: randomUUID(), state: 'opening', scope: structuredClone(device.verificationScope),
        controls, api, begin, end, speed, closed: false, operations: [],
        channelChecks: { queryMatched: 0, queryRejected: 0, commandMatched: 0, commandRejected: 0, mediaMatched: 0, mediaRejected: 0 } };
      try {
        try { c.connection = this.createConnection(); await c.connection.connect(serial); }
        catch { throw failure('CONTROL_CONNECTION_LOST'); }
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
          if (data?.begin_time !== begin || data?.end_time !== end) return;
          c.channelChecks.queryMatched++; return data;
        }, () => c.p2p.queryContinuousRecordings(serial, c.scope.channel, begin, end), STARTUP_MS);
        const records = ranges.videos?.filter(row => Number.isSafeInteger(row.start_time) && Number.isSafeInteger(row.stop_time)
          && row.start_time <= begin && row.stop_time >= end);
        if (records?.length !== 1 || (records[0].file_path != null && typeof records[0].file_path !== 'string')) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
        c.filePath = typeof records[0].file_path === 'string' ? records[0].file_path : undefined;
        if (typeof c.connection.userId !== 'string' || !c.connection.userId) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
        const fresh = await this.resolveDevice(serial);
        if (!isAuthenticated(this.session) || this.session.api !== api) throw failure('UNAUTHENTICATED');
        if (scopeKey(fresh.verificationScope) !== scopeKey(c.scope)) throw failure('CONTROL_SCOPE_CHANGED');
        if (!playbackControls(fresh).verifiedStartSpeeds.includes(speed)) throw failure('CONTROL_NOT_VERIFIED');
        this._listen(c); c.starting = true; this._idle(c, STARTUP_MS); const deadline = Date.now() + STARTUP_MS;
        await this._command(c, 'start', marker => {
          try { c.p2p.startContinuousPlayback(serial, c.scope.channel, c.connection.userId, begin, { speed, filePath: c.filePath, customData: marker }); }
          finally { c.owner = c.p2p.continuousPlayback; }
        }, () => {}, STARTUP_MS);
        if (c.starting) await this._wait(c, 'continuous playback frame', () => !c.starting ? true : undefined,
          () => {}, Math.max(1, deadline - Date.now()), 'CONTROL_STARTUP_TIMEOUT');
        if (c.error) throw c.error;
        await this._check(c); this._requireControl(c); c.state = 'playing'; return this.get(c.id);
      } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
    });
  }
  async _control(id, operation) {
    return this._exclusive(async () => {
      const c = this._find(id);
      if (c.closed || c.error) throw c.error || failure('CONTROL_INACTIVE');
      if (c.speed !== 1 || !c.controls.pauseResumeAtSpeed1) throw failure('CONTROL_NOT_VERIFIED');
      if (c.state !== (operation === 'pause' ? 'playing' : 'paused')) throw failure('CONTROL_INACTIVE');
      try {
        await this._check(c);
        this._requireControl(c);
        if (!Number.isSafeInteger(c.position) || c.position < c.begin * 1000 || c.position >= c.end * 1000) throw failure('CONTROL_CONTEXT_UNAVAILABLE');
        if (operation === 'pause') { c.pausePosition = c.position; c.state = 'pausing'; }
        else { clearTimeout(c.pauseTimer); c.pauseExpiresAt = null; c.state = 'resuming'; this._idle(c, c.originalIdle); }
        await this._command(c, operation, marker => c.p2p.sendCommandWithStringPayload({ commandType: 1700, channel: c.scope.channel,
          value: JSON.stringify({ commandType: 6001, data: { session_id: 125, cmd: operation === 'pause' ? 1 : 2,
            play_type: 0, play_speed: 1, begin_time: operation === 'pause' ? 0 : Math.floor(c.position / 1000),
            file_path: operation === 'pause' ? '' : c.filePath, device_sn: c.scope.serial, index: 0 } }) }, marker), () => {
          c.state = operation === 'pause' ? 'paused' : 'playing';
          if (operation === 'pause') {
            this._idle(c, MAX_PAUSE_MS + COMMAND_MS); c.pauseExpiresAt = Date.now() + MAX_PAUSE_MS;
            c.pauseTimer = setTimeout(() => {
              if (this.operation) this._dispose(c, failure('CONTROL_INACTIVE')).catch(() => {});
              else this.close(c.id).catch(() => {});
            }, MAX_PAUSE_MS);
          }
        });
        if (operation === 'resume' && c.position <= c.pausePosition)
          await this._wait(c, 'continuous playback frame', () => c.position > c.pausePosition ? true : undefined, () => {}, c.originalIdle, 'CONTROL_MEDIA_TIMEOUT');
        if (c.error) throw c.error;
        return this.get(id);
      } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
    });
  }
  pause(id) { return this._control(id, 'pause'); }
  resume(id) { return this._control(id, 'resume'); }
  close(id) {
    return this._exclusive(async () => {
      const c = this._find(id);
      if (c.closed) return this.get(id);
      c.state = 'closing'; clearTimeout(c.pauseTimer); c.pauseExpiresAt = null;
      try {
        if (!c.error && c.p2p?.isConnected() && this._owned(c)) {
          this._idle(c, c.originalIdle);
          await this._command(c, 'stop', marker => c.p2p.stopContinuousPlayback(marker)); c.stopConfirmed = true;
        }
        await this._dispose(c); return this.get(id);
      } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
    });
  }
  _dispose(c, error) {
    if (error) { c.error ||= error; c.state = 'failed'; }
    if (c.cleanup) return c.cleanup;
    c.cleanup = (async () => {
      clearTimeout(c.pauseTimer); c.pauseExpiresAt = null;
      const p2p = c.p2p;
      if (p2p) {
        if (c.owner && p2p.continuousPlayback && p2p.continuousPlayback !== c.owner) throw failure('CONTROL_INACTIVE');
        if (c.frame) { p2p.off('continuous playback frame', c.frame); p2p.off('livestream started', c.drain); p2p.off('close', c.disconnected); p2p.off('livestream stopped', c.stopped); }
        if (c.originalIdle !== undefined) p2p.setStreamTimeouts({ streamDataWait: c.originalIdle });
        clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
        const originalClose = p2p.close; let closing;
        p2p.close = () => closing ||= Promise.resolve().then(() => originalClose.call(p2p));
        try { if (p2p.isConnected()) await p2p.close(); await c.connection.close(); if (closing) await closing;
          if (p2p.isConnected()) throw failure('CONTROL_CLEANUP_FAILED'); }
        finally { p2p.close = originalClose; if (c.originalEndStream) p2p.endStream = c.originalEndStream; }
      } else await c.connection?.close();
      c.closed = true; c.state = c.error ? 'failed' : 'closed';
    })().catch(() => { c.error = failure('CONTROL_CLEANUP_FAILED'); c.state = 'failed'; throw c.error; });
    return c.cleanup;
  }
  async closeActive() {
    await this.operation?.catch(() => {});
    if (this.current && !this.current.closed) await this.close(this.current.id);
  }
  async shutdown() { this.stopping = true; await this.closeActive(); }
}

module.exports = { PlaybackSessions, MAX_PAUSE_MS };
