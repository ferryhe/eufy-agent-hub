const { randomUUID } = require('node:crypto');
const { isAuthenticated } = require('../auth/session.cjs');
const { scopeKey } = require('../devices/capabilities.cjs');
const { LiveConnection } = require('../../adapters/eufy/live-connection.cjs');
const { createRuntime } = require('./runtime.cjs');
const { failure, safeError } = require('./errors.cjs');

class LiveSessions {
  constructor({ session, jobs, resolveDevice, createConnection = () => new LiveConnection(session),
    createRuntime: runtime = createRuntime, startupMs = 15000, attachMs = 10000, idleMs = 15000,
    authPollMs = 1000, commandMs = 1500, drainMs = 10000, ffmpeg } = {}) {
    Object.assign(this, { session, jobs, resolveDevice, createConnection, createRuntime: runtime,
      startupMs, attachMs, idleMs, authPollMs, commandMs, drainMs, ffmpeg });
    this.sessions = new Map(); this.requests = new Map(); this.stopping = false;
  }
  isBusy() { return [...this.sessions.values()].some(c => !c.cleanupComplete); }
  _find(id) { const c = this.sessions.get(id); if (!c) throw failure('LIVE_SESSION_NOT_FOUND'); return c; }
  get(id) {
    const c = this._find(id);
    return { sessionId: c.id, requestId: c.requestId, serial: c.serial, state: c.state,
      verificationScope: structuredClone(c.scope), capabilityStatus: c.capabilityStatus,
      createdAt: c.createdAt, updatedAt: c.updatedAt, startedAt: c.startedAt || null, stoppedAt: c.stoppedAt || null,
      attachDeadline: c.attachDeadline || null, mediaUrl: `/api/v1/live-sessions/${c.id}/media`,
      media: { container: 'fragmented_mp4', videoCodec: 'h264', audio: false, inputCodec: c.inputCodec || null, bytesReceived: c.bytesReceived },
      cleanupComplete: c.cleanupComplete, stopConfirmed: Boolean(c.stopConfirmed),
      diagnostics: structuredClone(c.diagnostics), error: c.error ? { code: c.error.code, message: c.error.code } : null };
  }
  _update(c, state) { c.state = state; c.updatedAt = new Date().toISOString(); }
  _check(c) {
    c.abort.signal.throwIfAborted();
    if (!isAuthenticated(this.session) || this.session.api !== c.api) throw failure('UNAUTHENTICATED');
  }
  start({ serial, requestId, allowUnverified = false }) {
    const existing = this.requests.get(requestId);
    if (existing) {
      if (existing.serial !== serial) return Promise.reject(failure('LIVE_REQUEST_CONFLICT'));
      return existing.opening.then(() => this.get(existing.id));
    }
    if (this.stopping) return Promise.reject(failure('SERVICE_STOPPING'));
    const now = new Date().toISOString();
    const c = { id: randomUUID(), requestId, serial, api: this.session.api, scope: null, capabilityStatus: 'unknown',
      state: 'starting', createdAt: now, updatedAt: now, cleanupComplete: false, bytesReceived: 0,
      diagnostics: [], abort: new AbortController(), listeners: [] };
    this.sessions.set(c.id, c); this.requests.set(requestId, c);
    c.opening = this._open(c, allowUnverified);
    return c.opening;
  }
  _listen(c, emitter, event, listener) { emitter.on(event, listener); c.listeners.push(() => emitter.off(event, listener)); }
  _fail(c, error) { this._dispose(c, safeError(error)).catch(() => {}); }
  _idle(c) {
    clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => this._fail(c, failure('LIVE_MEDIA_TIMEOUT')), this.idleMs);
  }
  async _open(c, allowUnverified) {
    try {
      this._check(c);
      const device = await this.resolveDevice(c.serial); this._check(c);
      if (!device) throw failure('DEVICE_NOT_FOUND');
      c.scope = structuredClone(device.verificationScope); c.capabilityStatus = device.capabilities?.liveVideo?.status || 'unknown';
      if (c.scope?.model !== 'T8600' || c.scope.homeBase?.model !== 'T8030' || !Number.isInteger(c.scope.channel)
        || c.scope.channel < 0 || c.capabilityStatus === 'unsupported') throw failure('LIVE_UNSUPPORTED');
      if (c.capabilityStatus !== 'verified' && !allowUnverified) throw failure('LIVE_NOT_VERIFIED');
      if (['offline', 'unavailable'].includes(device.availability)) throw failure('DEVICE_OFFLINE');
      c.release = this.jobs.acquireMedia(c.scope.homeBase.serial);
      c.startupTimer = setTimeout(() => this._fail(c, failure('LIVE_MEDIA_TIMEOUT')), this.startupMs);
      c.authTimer = setInterval(() => { try { this._check(c); } catch (e) { this._fail(c, e); } }, this.authPollMs);
      c.connection = this.createConnection();
      c.connecting = Promise.resolve(c.connection.connect(c.serial, c.abort.signal));
      await c.connecting; this._check(c);
      const { station, camera } = c.connection; c.p2p = station.p2pSession;
      if (camera.getSerial() !== c.scope.serial || camera.getModel() !== c.scope.model || camera.getStationSerial() !== c.scope.homeBase.serial
        || camera.getChannel() !== c.scope.channel || station.getSerial() !== c.scope.homeBase.serial || station.getModel() !== c.scope.homeBase.model)
        throw failure('LIVE_SCOPE_CHANGED');
      if (!c.p2p.isConnected()) throw failure('LIVE_CONNECTION_LOST');
      const fresh = await this.resolveDevice(c.serial); this._check(c);
      if (!fresh || scopeKey(fresh.verificationScope) !== scopeKey(c.scope)) throw failure('LIVE_SCOPE_CHANGED');
      if (['offline', 'unavailable'].includes(fresh.availability)) throw failure('DEVICE_OFFLINE');
      const ready = new Promise((resolve, reject) => {
        const aborted = () => reject(c.abort.signal.reason);
        c.abort.signal.addEventListener('abort', aborted, { once: true });
        c.listeners.push(() => c.abort.signal.removeEventListener('abort', aborted));
        this._listen(c, c.p2p, 'command', result => {
          if (result.channel !== c.scope.channel || ![1003, 1004].includes(result.command_type)) return;
          c.diagnostics.push({ event: 'command', command: result.command_type, channel: result.channel,
            returnCode: result.return_code, at: new Date().toISOString() });
          if (result.command_type === 1003 && result.return_code !== 0) this._fail(c, failure('LIVE_COMMAND_REJECTED'));
        });
        this._listen(c, c.p2p, 'close', () => this._fail(c, failure('LIVE_CONNECTION_LOST')));
        this._listen(c, station, 'connection error', () => this._fail(c, failure('LIVE_CONNECTION_LOST')));
        this._listen(c, c.p2p, 'livestream stopped', channel => { if (channel === c.scope.channel) this._fail(c, failure('LIVE_CONNECTION_LOST')); });
        this._listen(c, c.p2p, 'livestream started', (channel, meta, video, audio) => {
          if (channel !== c.scope.channel || c.runtime || c.abort.signal.aborted) { video.destroy(); audio?.destroy(); return; }
          c.streams = [video, audio].filter(Boolean);
          c.inputCodec = meta.videoCodec === 0 ? 'h264' : meta.videoCodec === 1 ? 'hevc' : null;
          c.diagnostics.push({ event: 'media', channel, videoCodec: meta.videoCodec, audioCodec: meta.audioCodec, at: new Date().toISOString() });
          if (!c.inputCodec) return this._fail(c, failure('LIVE_DECODER_ERROR'));
          for (const stream of c.streams) this._listen(c, stream, 'error', () => this._fail(c, failure('LIVE_CONNECTION_LOST')));
          this._listen(c, video, 'data', chunk => { c.bytesReceived += chunk.length; this._idle(c); });
          this._listen(c, video, 'end', () => this._fail(c, failure('LIVE_CONNECTION_LOST')));
          audio?.resume(); this._idle(c);
          try {
            c.runtime = this.createRuntime({ video, codec: c.inputCodec, ffmpeg: this.ffmpeg });
            this._listen(c, c.runtime, 'failure', error => this._fail(c, error));
            this._listen(c, c.runtime, 'ready', resolve);
          } catch { this._fail(c, failure('LIVE_RUNTIME_ERROR')); }
        });
        c.startRequested = true;
        try { station.startLivestream(camera, 0); } catch { this._fail(c, failure('LIVE_COMMAND_REJECTED')); }
      });
      await ready; this._check(c);
      clearTimeout(c.startupTimer); c.startedAt = new Date().toISOString(); this._update(c, 'streaming');
      c.attachDeadline = new Date(Date.now() + this.attachMs).toISOString();
      c.attachTimer = setTimeout(() => this._fail(c, failure('LIVE_CLIENT_TIMEOUT')), this.attachMs);
      return this.get(c.id);
    } catch (error) { const safe = c.error || safeError(error); await this._dispose(c, safe); throw safe; }
  }
  attach(id, res) {
    const c = this._find(id); this._check(c);
    if (c.state !== 'streaming') throw c.error || failure('LIVE_INACTIVE');
    if (c.response) throw failure('LIVE_MEDIA_CLAIMED');
    c.response = res; clearTimeout(c.attachTimer); c.attachDeadline = null;
    c.responseDone = new Promise(resolve => {
      res.once('finish', () => resolve(true));
      res.once('close', () => {
        if (!res.writableFinished) c.drainAbort?.abort(failure('LIVE_CONNECTION_LOST'));
        resolve(Boolean(res.writableFinished)); this.stop(id).catch(() => {});
      });
      res.once('error', () => {
        c.drainAbort?.abort(failure('LIVE_CONNECTION_LOST'));
        resolve(false); this._fail(c, failure('LIVE_CONNECTION_LOST'));
      });
    });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Live-Session-Id': c.id });
    c.runtime.output.pipe(res);
  }
  stop(id) { const c = this._find(id); return this._dispose(c).then(() => this.get(id)); }
  cancelRequest(requestId) { const c = this.requests.get(requestId); if (c) this.stop(c.id).catch(() => {}); }
  _dispose(c, error) {
    if (c.cleanup) return c.cleanup;
    if (error) c.error = error;
    this._update(c, 'stopping'); c.abort.abort(error || failure('LIVE_INACTIVE'));
    for (const timer of ['startupTimer', 'attachTimer', 'idleTimer', 'authTimer']) clearTimeout(c[timer]);
    for (const remove of c.listeners.splice(0)) remove();
    const graceful = !c.error && c.response && !c.response.destroyed;
    let drainTimer;
    if (graceful) {
      c.drainAbort = new AbortController();
      c.drainAbort.signal.addEventListener('abort', () => {
        c.error ||= safeError(c.drainAbort.signal.reason); c.response.destroy();
      }, { once: true });
      drainTimer = setTimeout(() => c.drainAbort.abort(failure('LIVE_MEDIA_TIMEOUT')), this.drainMs);
      // Once all response bytes finish, slow protocol cleanup must not relabel
      // already completed media as a drain timeout. The lease still stays owned.
      c.responseDone.then(finished => { if (finished) clearTimeout(drainTimer); });
    }
    c.cleanup = (async () => {
      await c.connecting?.catch(() => {});
      if (c.startRequested && c.p2p?.isConnected()) {
        await new Promise(resolve => {
          let timer;
          const done = () => { clearTimeout(timer); c.p2p.off('command', command); resolve(); };
          const command = result => { if (result.channel === c.scope.channel && result.command_type === 1004) {
            c.stopConfirmed = result.return_code === 0;
            c.diagnostics.push({ event: 'command', command: 1004, channel: result.channel,
              returnCode: result.return_code, at: new Date().toISOString() });
            if (!c.stopConfirmed) c.error ||= failure('LIVE_COMMAND_REJECTED');
            done();
          } };
          c.p2p.on('command', command); timer = setTimeout(() => {
            c.error ||= failure('LIVE_COMMAND_TIMEOUT'); done();
          }, this.commandMs);
          try { c.connection.station.stopLivestream(c.connection.camera); } catch { done(); }
        });
      }
      for (const stream of c.streams || []) stream.destroy();
      if (c.error) c.drainAbort?.abort(c.error);
      if (!graceful) c.response?.destroy();
      // Attempt both cleanup branches even if one fails. Never release on failure.
      const mediaClose = Promise.resolve().then(() => c.runtime?.close({ graceful, signal: c.drainAbort?.signal, drainMs: this.drainMs }))
        .then(result => {
          if (result?.error) { c.error ||= safeError(result.error); c.drainAbort?.abort(c.error); }
        }, error => { c.response?.destroy(); throw error; });
      const cleaned = await Promise.allSettled([mediaClose, c.connection?.close(), graceful ? c.responseDone : undefined]);
      clearTimeout(drainTimer);
      if (cleaned.some(result => result.status === 'rejected')) throw failure('LIVE_CLEANUP_FAILED');
      c.cleanupComplete = true; c.release?.(); c.stoppedAt = new Date().toISOString();
      this._update(c, c.error ? 'failed' : 'stopped');
    })().catch(error => { clearTimeout(drainTimer); c.error = failure('LIVE_CLEANUP_FAILED'); this._update(c, 'failed'); throw c.error; });
    return c.cleanup;
  }
  async closeActive() { await Promise.all([...this.sessions.values()].filter(c => !c.cleanupComplete).map(c => this._dispose(c))); }
  async shutdown() { this.stopping = true; await this.closeActive(); }
}
module.exports = { LiveSessions };
