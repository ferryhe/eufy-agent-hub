// Maintainer-only acceptance orchestration. All controls cross the real v1 HTTP
// routes; temporary authorization exists only in this process's repository copy.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { OUTPUT } = require('../continuous-export.cjs');
const { createServer } = require('../../../interface/server.cjs');
const { queryDevice, recordCapability, scopeKey } = require('../../devices/capabilities.cjs');
const { DeviceVerificationRepository } = require('../../devices/verification-store.cjs');
const { contract } = require('../../../api/v1-contract.cjs');
const knownErrors = new Set(contract.definitions.error.properties.error.properties.code.enum);
class HostError extends Error { constructor(code) { super(code); this.code = code; } }
const requireFact = (condition, code) => { if (!condition) throw new HostError(code); };

async function closeConnection(service) {
  if (!service) return;
  const p2p = service.station?.p2pSession, original = p2p?.close; let closing;
  if (p2p) p2p.close = () => closing ||= Promise.resolve().then(() => original.call(p2p));
  try { if (p2p?.isConnected()) await p2p.close(); }
  finally {
    try { await service.close(); if (closing) await closing; requireFact(!p2p?.isConnected(), 'HOST_CLOSE_FAILED'); }
    finally { if (p2p) { p2p.close = original; p2p.socket?.unref(); } }
  }
}
function ranges(p2p, serial, channel, begin, end) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); p2p.off('continuous recording ranges', receive); p2p.off('close', lost); };
    const fail = code => { clean(); reject(new HostError(code)); };
    const lost = () => fail('HOST_CONNECTION_UNAVAILABLE');
    const receive = (receivedChannel, data) => {
      if (receivedChannel !== channel || data?.begin_time !== begin || data?.end_time !== end) return;
      if (!Array.isArray(data.videos)) return fail('HOST_QUERY_INVALID');
      clean(); resolve(data.videos);
    };
    const timer = setTimeout(() => fail('HOST_QUERY_TIMEOUT'), 15000);
    p2p.on('continuous recording ranges', receive); p2p.on('close', lost);
    try { p2p.queryContinuousRecordings(serial, channel, begin, end); } catch { fail('HOST_QUERY_FAILED'); }
  });
}
function selectMinute(rows) {
  // Public window syntax is HH:mm and same-day. Select only representable,
  // completely retained minutes; never round the requested media outside a row.
  return rows.map(row => {
    let end = Math.floor(row.end / 60) * 60;
    if (new Date(end * 1000).getUTCDate() !== new Date((end - 60) * 1000).getUTCDate()) end -= 60;
    return { begin: end - 60, end, retainedBegin: row.begin };
  }).filter(row => row.begin >= row.retainedBegin).sort((a, b) => b.end - a.end)[0];
}

async function runPublicAcceptance({ runtime, repository, scratchDir, evidenceSource, saveEvidence, fetchImpl = fetch, persist = true }) {
  const result = { version: 1, status: 'failed', mode: 'public_speed1', error: null, recorded: false,
    serverClosed: true, ownerClosed: false, operations: [], channelIsolation: 'unverified',
    excludedSpeeds: { 2: 'historical_complete_scope_missing', 4: 'historical_serial_scope_missing',
      8: 'completion_unconfirmed', 16: 'historical_serial_scope_missing' } };
  const now = runtime.nowMs || Date.now, pauseWait = runtime.pauseWait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let stage = 'restore', selection, server, id, api, scope, playbackP2P, playbackConnections = 0, finalView;
  const fail = error => { result.error ||= { code: error instanceof HostError ? error.code : 'HOST_OPERATION_FAILED', stage }; };
  const observe = view => {
    requireFact(view && (!id || view.sessionId === id) && scopeKey(view.verificationScope) === scopeKey(scope), 'HOST_SESSION_BINDING_CHANGED');
    finalView = view;
    result.operations = view.operations.map(row => ({ operation: row.operation, sentAtMs: row.sentAtMs,
      receivedAtMs: row.receivedAtMs, returnCode: row.returnCode }));
    result.channelChecks = { ...view.channelChecks };
    return view;
  };
  try {
    await runtime.session.restore();
    requireFact(runtime.session.isAuthenticated() && runtime.session.state.phase === 'connected', 'HOST_SESSION_UNAVAILABLE');
    stage = 'bind';
    const inventory = (await runtime.session.api.getDevsListDecrypted())?.devices;
    requireFact(Array.isArray(inventory), 'HOST_TARGET_UNAVAILABLE');
    const matches = inventory.filter(row => row.device_name === 'Drive Way' && row.device_model === 'T8600'
      && inventory.filter(base => base.device_sn === row.parent_sn && base.device_model === 'T8030').length === 1);
    requireFact(matches.length === 1, matches.length ? 'HOST_TARGET_AMBIGUOUS' : 'HOST_TARGET_UNAVAILABLE');
    const target = matches[0], device = queryDevice(inventory, target.device_sn); scope = device.verificationScope;
    requireFact(device.recordingExport.supported && Number.isInteger(scope.channel)
      && inventory.filter(row => row.device_sn === target.device_sn).length === 1
      && inventory.filter(row => row.parent_sn === target.parent_sn && row.device_channel === scope.channel).length === 1,
    'HOST_TARGET_AMBIGUOUS');
    requireFact([scope.firmware.main, scope.firmware.secondary, scope.homeBase?.firmware.main, scope.homeBase?.firmware.secondary]
      .every(value => typeof value === 'string' && value.trim()), 'HOST_SCOPE_UNAVAILABLE');
    result.deviceScope = { cameraModel: scope.model, cameraFirmware: scope.firmware,
      homeBaseModel: scope.homeBase.model, homeBaseFirmware: scope.homeBase.firmware, channel: scope.channel };
    stage = 'selection'; selection = runtime.createService(); await selection.connect(target.device_sn);
    requireFact(selection.station?.p2pSession.isConnected() && selection.camera.getSerial() === target.device_sn
      && selection.camera.getChannel() === scope.channel && selection.camera.getStationSerial() === scope.homeBase.serial
      && selection.station.getSerial() === scope.homeBase.serial, 'HOST_TARGET_CHANGED');
    const end = Math.floor(now() / 1000), begin = end - 86400, middle = begin + 43200, rows = [];
    for (const [start, stop] of [[begin, middle], [middle, end]]) {
      const found = await ranges(selection.station.p2pSession, target.device_sn, scope.channel, start, stop);
      for (const row of found) if (Number.isSafeInteger(row?.start_time) && Number.isSafeInteger(row.stop_time))
        rows.push({ begin: Math.max(start, row.start_time), end: Math.min(stop, row.stop_time) });
    }
    const minute = selectMinute(rows); requireFact(minute, 'HOST_RECORDING_UNAVAILABLE');
    result.window = { begin: minute.begin, end: minute.end };
    await closeConnection(selection); selection = undefined;
    stage = 'bootstrap';
    const dated = { source: evidenceSource, observedAt: new Date(now()).toISOString(), outcome: 'temporary_acceptance_bootstrap_not_persisted' };
    const bootstrap = { ...repository.read(), records: recordCapability(repository.read().records, { scope,
      capability: 'continuousPlaybackControls', status: 'verified', reason: 'temporary_authorized_acceptance_only', evidence: [dated],
      controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1] } }) };
    server = createServer({ port: 0, session: runtime.session, deviceRepository: { read: () => structuredClone(bootstrap) },
      outputRoot: scratchDir, exports: { outputRoot: path.join(scratchDir, 'jobs') },
      playback: { createConnection: () => {
        playbackConnections++; const service = runtime.createService(), connect = service.connect.bind(service);
        service.connect = async (...args) => { await connect(...args); playbackP2P = service.station.p2pSession; };
        return service;
      } } });
    // Already restored above for selection; do not call start(), which restores
    // again. These are the unchanged interface/server request handlers.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    result.serverClosed = false;
    const origin = `http://127.0.0.1:${server.address().port}`;
    api = async (route, body) => {
      let response;
      try { response = await fetchImpl(origin + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Connection: 'close' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) }); }
      catch { throw new HostError('HOST_HTTP_UNAVAILABLE'); }
      const value = await response.json();
      if (!response.ok) throw new HostError(knownErrors.has(value.error?.code) ? value.error.code : 'HOST_HTTP_FAILED');
      return value;
    };
    stage = 'preflight';
    const session = await api('/api/v1/session');
    requireFact(session.authenticated && session.phase === 'connected' && !session.busy, 'HOST_SESSION_UNAVAILABLE');
    const current = (await api(`/api/v1/devices/${encodeURIComponent(target.device_sn)}`)).device;
    requireFact(scopeKey(current.verificationScope) === scopeKey(scope), 'HOST_SCOPE_CHANGED');
    stage = 'start';
    const startDate = new Date(minute.begin * 1000).toISOString(), endDate = new Date(minute.end * 1000).toISOString();
    const started = observe((await api('/api/v1/playback-sessions', { serial: target.device_sn, day: startDate.slice(0, 10),
      start: startDate.slice(11, 16), end: endDate.slice(11, 16), timezone: 'UTC', speed: 1 })).playback);
    id = started.sessionId;
    requireFact(started.state === 'playing' && Number.isSafeInteger(started.positionMs), 'HOST_START_UNCONFIRMED');
    stage = 'pause'; const paused = observe((await api(`/api/v1/playback-sessions/${id}/pause`, {})).playback);
    const pausedAt = now(); requireFact(paused.state === 'paused', 'HOST_PAUSE_UNCONFIRMED');
    await pauseWait(6000);
    stage = 'pause_observation'; const quiet = observe((await api(`/api/v1/playback-sessions/${id}`)).playback);
    result.pauseWindow = { elapsedMs: now() - pausedAt, beforeMs: paused.positionMs, afterMs: quiet.positionMs };
    requireFact(result.pauseWindow.elapsedMs >= 6000 && quiet.state === 'paused' && quiet.positionMs === paused.positionMs
      && !quiet.error, 'HOST_PAUSE_UNCONFIRMED');
    stage = 'resume'; const resumed = observe((await api(`/api/v1/playback-sessions/${id}/resume`, {})).playback);
    requireFact(resumed.state === 'playing' && resumed.positionMs > paused.positionMs, 'HOST_RESUME_UNCONFIRMED');
    result.media = { beforePauseMs: paused.positionMs, afterResumeMs: resumed.positionMs };
  } catch (error) { fail(error); }
  finally {
    stage = 'close';
    if (id) {
      try {
        const closed = observe((await api(`/api/v1/playback-sessions/${id}/close`, {})).playback);
        requireFact(closed.state === 'closed' && closed.stopConfirmed && !closed.error, 'HOST_CLOSE_UNCONFIRMED');
        const session = await api('/api/v1/session');
        requireFact(session.authenticated && session.phase === 'connected' && !session.busy, 'HOST_SESSION_UNAVAILABLE');
      } catch (error) { fail(error); }
    }
    try { await closeConnection(selection); } catch { fail(new HostError('HOST_CLOSE_FAILED')); }
    if (server) {
      try { await server.shutdown(); } catch { fail(new HostError('HOST_SERVER_CLOSE_FAILED')); }
      finally {
        // Explicit shutdown was awaited above. Remove its automatic console-error
        // fallback so a failed close cannot print an exception stack or paths.
        server.removeAllListeners('close');
        if (server.listening) await new Promise(resolve => server.close(resolve)); result.serverClosed = !server.listening;
      }
    }
    result.ownerClosed = Boolean(playbackP2P && !playbackP2P.isConnected());
    // Release known UDP references after protocol close. The standalone CLI
    // separately owns HTTP-client shutdown and exits only after final output;
    // embedded callers retain ownership of their process lifetime.
    playbackP2P?.socket?.unref();
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { fail(new HostError('HOST_SCRATCH_CLOSE_FAILED')); }
  }
  try {
    if (!result.error) {
      stage = 'verification';
      requireFact(playbackConnections === 1 && result.ownerClosed && result.serverClosed
        && result.operations.map(row => row.operation).join(',') === 'start,pause,resume,stop'
        && result.operations.every(row => row.returnCode === 0 && Number.isFinite(row.receivedAtMs))
        && finalView.channelChecks.commandMatched === 4 && finalView.channelChecks.queryMatched === 1
        && finalView.channelChecks.mediaMatched >= 2, 'HOST_ACCEPTANCE_UNCONFIRMED');
      result.status = 'completed';
      result.verifiedStartSpeeds = [1];
    }
    // Evidence is written before the final atomic repository write. It describes
    // the completed HTTP observation, not whether a later disk write succeeded.
    stage = 'evidence'; const { recorded, ...proof } = result;
    await saveEvidence({ ...proof, verificationWrite: result.error ? 'not_attempted' : 'separate_following_atomic_step' });
    if (!result.error && persist) {
      stage = 'record';
      repository.record({ scope, capability: 'continuousPlaybackControls', status: 'verified',
        reason: 'scoped_public_speed1_acceptance',
        controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: result.verifiedStartSpeeds },
        evidence: [{ source: evidenceSource, observedAt: new Date(now()).toISOString(), outcome: 'public_speed1_start_pause_6s_resume_media_stop_closed' }] });
      result.recorded = true;
    }
  } catch (error) { fail(error); result.status = 'failed'; }
  return result;
}

function realRuntime(sessionPath) {
  const { setLoggingLevel, LogLevel } = require('../../../vendor/eufy-security-client/build/logging'); setLoggingLevel('all', LogLevel.Off);
  const { LocalEufySession } = require('../../auth/session.cjs'); const { LocalContinuousRecordings } = require('../continuous.cjs');
  const session = new LocalEufySession(undefined, { sessionPath }); return { session, createService: () => new LocalContinuousRecordings(session) };
}
function preflight(env) {
  const files = [env.EUFY_SESSION_PATH, env.ISSUE9_PROBE_EVIDENCE_PATH, env.EUFY_CAPABILITY_RECORDS_PATH];
  requireFact(files.every(file => typeof file === 'string' && path.isAbsolute(file)), 'HOST_PATH_REQUIRED');
  requireFact(new Set(files.map(file => path.resolve(file).toLowerCase())).size === 3, 'HOST_PATH_INVALID');
  requireFact(fs.statSync(files[0]).isFile() && !fs.existsSync(files[1]), 'HOST_PATH_INVALID');
  fs.accessSync(files[0], fs.constants.R_OK);
  for (const file of files.slice(1)) fs.accessSync(path.dirname(file), fs.constants.W_OK);
}
async function main({ argv = process.argv.slice(2), env = process.env, createRuntime = realRuntime, checkPaths = preflight } = {}) {
  let scratchDir, agent;
  try {
    requireFact(argv.length === 1 && ['--dry-run', '--run-public-speed1'].includes(argv[0]), 'HOST_ARGUMENTS_INVALID');
    const dry = argv[0] === '--dry-run'; if (!dry) checkPaths(env);
    fs.mkdirSync(OUTPUT, { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(OUTPUT, 'issue9-public-'));
    const repository = new DeviceVerificationRepository(dry ? path.join(scratchDir, 'verification.json') : env.EUFY_CAPABILITY_RECORDS_PATH);
    // This CLI owns its local HTTP client, including its shutdown. Do not leave
    // the process-global fetch dispatcher alive when the CLI finishes.
    agent = new http.Agent({ keepAlive: false });
    const fetchImpl = (url, options) => new Promise((resolve, reject) => {
      const request = http.request(url, { agent, method: options.method, headers: options.headers, signal: options.signal }, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300,
          json: async () => JSON.parse(body) }));
      });
      request.once('error', reject); request.end(options.body);
    });
    const result = await runPublicAcceptance({ runtime: dry ? createDryRunRuntime() : createRuntime(env.EUFY_SESSION_PATH), repository, scratchDir,
      fetchImpl,
      evidenceSource: dry ? 'dry-run-not-persisted' : path.basename(env.ISSUE9_PROBE_EVIDENCE_PATH), persist: !dry,
      saveEvidence: proof => { if (!dry) fs.writeFileSync(env.ISSUE9_PROBE_EVIDENCE_PATH, JSON.stringify(proof, null, 2), { flag: 'wx', flush: true }); } });
    return { ...result, mode: dry ? 'dry_run' : result.mode };
  } catch (error) { return { version: 1, status: 'failed', recorded: false, error: { code: error instanceof HostError ? error.code : 'HOST_PREFLIGHT_FAILED', stage: 'preflight' } }; }
  finally { agent?.destroy(); if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true }); }
}

function createDryRunRuntime(options = {}) {
  const { EventEmitter } = require('node:events'); const { P2PClientProtocol, DeviceType } = require('../../../adapters/eufy');
  let clock = Date.parse('2026-09-12T12:00:00Z'), live;
  const calls = { commands: [], queries: [], restore: 0, logout: 0, maxOwners: 0, connected: 0, serviceClose: 0 };
  const inventory = { devices: [
    { device_sn: 'private-base', device_model: 'T8030', device_type: DeviceType.HB3, main_sw_version: '3.8.6.0', sec_sw_version: '1.4.0.8' },
    { device_sn: 'private-camera', parent_sn: 'private-base', device_model: 'T8600', device_name: 'Drive Way', device_channel: 1,
      device_type: DeviceType.PROFESSIONAL_247, main_sw_version: '1.0.5.0', sec_sw_version: '18137' },
  ] };
  const session = { state: { phase: 'connected' }, isAuthenticated: () => true, restore: async () => { calls.restore++; }, logout: () => { calls.logout++; },
    api: { getDevsListDecrypted: async () => inventory } };
  return { session, calls, inventory, nowMs: () => clock, pauseWait: async ms => { clock += ms; if (options.advancePause) live.frame(live.begin * 1000 + 1500); },
    createService: () => {
      const channel = inventory.devices[1].device_channel;
      const p = new EventEmitter(); Object.assign(p, { connected: false, deviceSNs: {}, sendQueue: [], messageStates: new Map(), streamTimeouts: { streamDataWait: 5000 },
        currentMessageState: { 1: { p2pStreaming: false, p2pStreamNotStarted: true, invalidStream: false, queuedData: new Map() } } });
      for (const name of ['startContinuousPlayback', 'stopContinuousPlayback', 'waitForStreamData', 'endStream', 'emitStreamStopEvent', 'setStreamTimeouts']) p[name] = P2PClientProtocol.prototype[name];
      p.initializeMessageBuilder = p.initializeMessageState = p.initializeStream = p.closeEnergySavingDevice = () => {};
      p.isConnected = () => p.connected; p.isCurrentlyStreaming = () => p.currentMessageState[1].p2pStreaming;
      p.frame = timestamp => { p.emit('continuous playback frame', { kind: 'video', channel, timestamp }); p.currentMessageState[1].p2pStreamNotStarted = false; };
      p.queryContinuousRecordings = (_serial, channel, begin, end) => {
        calls.queries.push({ begin, end }); p.begin = begin;
        const data = { begin_time: begin, end_time: end, videos: options.noRanges ? [] : [{ start_time: end - begin === 60 ? begin : end - 600, stop_time: end - begin === 60 ? end : end - 60, file_path: 'private-path' }] };
        p.emit('continuous recording ranges', channel + 1, data); p.emit('continuous recording ranges', channel, data);
      };
      p.sendCommandWithStringPayload = (command, customData) => {
        const cmd = JSON.parse(command.value).data.cmd; calls.commands.push(cmd);
        if (options.noReply === cmd) return;
        queueMicrotask(() => { p.emit('command', { command_type: 6001, channel: channel + 1, customData, return_code: 0 });
          p.emit('command', { command_type: 6001, channel, customData, return_code: options.reject === cmd ? 7 : 0 });
          if (cmd === 0 || cmd === 2) p.frame(p.begin * 1000 + (cmd === 0 ? 1000 : 2000)); });
      };
      p.close = async () => { if (p.connected) calls.connected--; p.connected = false; p.continuousPlayback = undefined;
        clearTimeout(p.currentMessageState[1].p2pStreamingTimeout); p.emit('close'); };
      return { station: { p2pSession: p, getSerial: () => 'private-base', getModel: () => 'T8030' },
        camera: { getSerial: () => 'private-camera', getModel: () => 'T8600', getStationSerial: () => 'private-base', getChannel: () => channel },
        userId: 'private-account', connect: async () => { p.connected = true; calls.connected++; calls.maxOwners = Math.max(calls.maxOwners, calls.connected); live = p; },
        close: async () => { calls.serviceClose++; if (options.closeError && calls.commands.length) throw new Error('private-close-error'); } };
    } };
}
if (require.main === module) {
  const finish = result => {
    const code = result.status === 'completed' ? 0 : 1;
    // main has awaited owner/server cleanup and durable evidence/record writes.
    // Flush stdout, then allow HTTP close callbacks to run before ending this
    // exclusive CLI process: SDK UDP handles can outlive protocol close.
    process.stdout.write(`${JSON.stringify(result)}\n`, () => setImmediate(() => setImmediate(() => process.exit(code))));
  };
  main().then(finish, () => finish({ status: 'failed', error: { code: 'HOST_UNEXPECTED_FAILURE' } }));
}
module.exports = { runPublicAcceptance, main, createDryRunRuntime };
