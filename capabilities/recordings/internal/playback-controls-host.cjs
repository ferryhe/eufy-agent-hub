// One-shot internal acceptance entry point. No production route or login flow.
const fs = require('node:fs');
const path = require('node:path');
const { runPlaybackControlsProbe, ANDROID_SPEED_CANDIDATES } = require('./playback-controls-probe.cjs');

class HostError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function runPlaybackControlsHost({ runtime, now = () => Math.floor(Date.now() / 1000), probe = runPlaybackControlsProbe, resumeSpeed2 = false, resumeRemaining = false, resumeSpeed16 = false }) {
  const remainingSpeeds = resumeSpeed16 ? [16] : resumeRemaining ? [4, 8, 16] : null;
  const result = { version: 1, status: 'failed', error: null, closed: false, speedObservations: [],
    channelChecks: { queryMatched: 0, queryRejected: 0 },
    channelIsolation: { status: 'unverified', reason: 'single_bound_target_projected_responses_only' } };
  if (resumeSpeed2) result.scope = 'speed_2_only';
  if (resumeRemaining) result.scope = 'speeds_4_8_16_only';
  if (resumeSpeed16) result.scope = 'speed_16_only';
  let service, stage = 'restore', target, base, channel;
  async function closeService() {
    if (!service) return;
    const current = service, p2p = current.station?.p2pSession;
    const originalClose = p2p?.close;
    let closing;
    // Station.close is synchronous. Share one awaited P2P close with it, so
    // cleanup cannot send a second END after an uncertain close attempt.
    if (p2p) p2p.close = () => closing ??= Promise.resolve().then(() => originalClose.call(p2p));
    try { if (p2p?.isConnected()) await p2p.close(); }
    finally {
      try {
        await current.close();
        if (closing) await closing;
        if (p2p?.isConnected()) throw new HostError('HOST_CLOSE_FAILED');
        result.closed = true;
      }
      finally { if (p2p) p2p.close = originalClose; service = undefined; }
    }
  }
  function checkBinding(device = target) {
    if (!runtime.session.isAuthenticated() || runtime.session.state.phase !== 'connected') throw new HostError('HOST_SESSION_UNAVAILABLE');
    if (!service.station?.p2pSession.isConnected()) throw new HostError('HOST_CONNECTION_UNAVAILABLE');
    if (service.camera.getSerial() !== device.device_sn || service.camera.getModel() !== 'T8600'
      || (device === target && service.camera.getName() !== 'Drive Way') || service.camera.getStationSerial() !== base.device_sn
      || service.station.getSerial() !== base.device_sn || service.station.getModel() !== 'T8030'
      || !Number.isInteger(service.camera.getChannel()) || service.camera.getChannel() < 0
      || service.camera.getChannel() !== device.device_channel
      || (device === target && channel !== undefined && channel !== service.camera.getChannel())
      || typeof service.userId !== 'string' || !service.userId) throw new HostError('HOST_TARGET_CHANGED');
    if (device === target) channel = service.camera.getChannel();
  }
  async function connect(device = target) {
    service = runtime.createService(runtime.session);
    result.closed = false;
    await service.connect(device.device_sn);
    checkBinding(device);
  }
  function query(begin, end, device = target, checks = result.channelChecks) {
    checkBinding(device);
    const p2p = service.station.p2pSession;
    const queryChannel = service.camera.getChannel();
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); p2p.off('continuous recording ranges', receive); p2p.off('close', disconnected); };
      const fail = code => { clean(); reject(new HostError(code)); };
      const disconnected = () => fail('HOST_CONNECTION_UNAVAILABLE');
      const receive = (responseChannel, data) => {
        if (responseChannel !== queryChannel) { checks.queryRejected++; return; }
        if (data?.begin_time !== begin || data?.end_time !== end) return;
        checks.queryMatched++;
        if (!Array.isArray(data.videos)) return fail('HOST_QUERY_INVALID');
        clean(); resolve(data.videos);
      };
      const timer = setTimeout(() => fail('HOST_QUERY_TIMEOUT'), 15000);
      p2p.on('continuous recording ranges', receive); p2p.on('close', disconnected);
      try { p2p.queryContinuousRecordings(device.device_sn, queryChannel, begin, end); }
      catch { fail('HOST_QUERY_FAILED'); }
    });
  }
  try {
    await runtime.session.restore();
    if (!runtime.session.isAuthenticated() || runtime.session.state.phase !== 'connected') throw new HostError('HOST_SESSION_UNAVAILABLE');
    stage = 'bind';
    const inventory = await runtime.session.api.getDevsListDecrypted();
    const devices = inventory?.devices;
    if (!Array.isArray(devices)) throw new HostError('HOST_TARGET_UNAVAILABLE');
    const matches = devices.filter(device => device.device_name === 'Drive Way' && device.device_model === 'T8600'
      && devices.filter(parent => parent.device_sn === device.parent_sn && parent.device_model === 'T8030').length === 1);
    if (matches.length !== 1) throw new HostError(matches.length ? 'HOST_TARGET_AMBIGUOUS' : 'HOST_TARGET_UNAVAILABLE');
    target = matches[0]; base = devices.find(device => device.device_sn === target.parent_sn);
    stage = 'connect'; await connect();
    result.binding = { singleTarget: true, cameraModel: 'T8600', homeBaseModel: 'T8030', controlChannel: channel,
      inventoryChannelMatched: true, outboundTargetPolicy: 'only_this_runtime_binding' };
    if (remainingSpeeds) {
      result.binding.outboundTargetPolicy = 'playback_only_this_runtime_binding_peer_read_only';
      const version = value => typeof value === 'string' && value.trim() ? value : null;
      const firmware = device => ({ main: version(device.main_sw_version), secondary: version(device.sec_sw_version) });
      result.deviceScope = { cameraModel: 'T8600', cameraFirmware: firmware(target),
        homeBaseModel: 'T8030', homeBaseFirmware: firmware(base), channel };
    }
    const end = now(), begin = end - 86400, middle = begin + 43200;
    if (!Number.isSafeInteger(end) || begin < 0) throw new HostError('HOST_TIME_INVALID');
    stage = 'query';
    const ranges = [];
    for (const [start, stop] of [[begin, middle], [middle, end]]) {
      for (const row of await query(start, stop)) {
        if (Number.isSafeInteger(row?.start_time) && Number.isSafeInteger(row.stop_time))
          ranges.push({ begin: Math.max(start, row.start_time), end: Math.min(stop, row.stop_time) });
      }
    }
    stage = 'select';
    const available = ranges.filter(row => row.end - row.begin >= 60).sort((a, b) => b.end - a.end);
    if (!available.length) throw new HostError('HOST_RECORDING_UNAVAILABLE');
    const window = { begin: available[0].end - 60, end: available[0].end };
    result.window = window;
    const input = () => {
      checkBinding();
      return { p2p: service.station.p2pSession, serial: target.device_sn, accountId: service.userId, channel, ...window };
    };
    if (remainingSpeeds) {
      // Only the existing T8600 / HB3 recording path is eligible for a peer
      // read. Exclude ambiguous bindings before choosing the lowest channel.
      const { supportsEventRecordings } = require('../../devices/recording-support.cjs');
      const peers = devices.filter(device => typeof device.device_sn === 'string' && device.device_sn.trim()
        && device.device_sn !== target.device_sn && device.parent_sn === base.device_sn
        && device.device_model === 'T8600' && Number.isInteger(device.device_channel) && device.device_channel >= 0
        && device.device_channel !== channel && supportsEventRecordings(device, devices));
      const peer = peers.filter(candidate => devices.filter(device => device.device_sn === candidate.device_sn).length === 1
        && devices.filter(device => device.parent_sn === base.device_sn && device.device_channel === candidate.device_channel).length === 1)
        .sort((a, b) => a.device_channel - b.device_channel)[0];
      result.peerObservation = { status: 'unverified', reason: peer ? 'read_only_peer_query' : peers.length ? 'ambiguous_peer' : 'no_eligible_peer',
        limitation: 'not a playback-isolation proof', channel: peer?.device_channel ?? null, observations: [] };
      async function observePeer(speed, phase) {
        if (!peer) return;
        const observation = { speed, phase, status: 'unverified', queryMatched: 0, queryRejected: 0 };
        result.peerObservation.observations.push(observation);
        try {
          await connect(peer);
          await query(window.begin, window.end, peer, observation);
          observation.status = 'responded';
        } catch (error) {
          observation.error = { code: error instanceof HostError ? error.code : 'HOST_PEER_QUERY_FAILED', stage: 'peer_query' };
        } finally {
          // A query failure is optional evidence; an owner that cannot close
          // prevents admission of another connection, including the target.
          await closeService();
        }
      }
      await closeService(); // The range-selection connection performs no playback.
      for (const candidateSpeed of remainingSpeeds) {
        stage = 'peer_before'; await observePeer(candidateSpeed, 'before');
        stage = 'connect'; await connect();
        stage = 'speed_candidates';
        const observation = await probe({ ...input(), candidateSpeed });
        result.speedObservations.push(observation);
        await closeService();
        if (observation.status !== 'completed') throw new HostError(observation.error?.code === 'CONTROL_REJECTED'
          ? 'HOST_CANDIDATE_REJECTED' : 'HOST_CANDIDATE_UNCONFIRMED');
        stage = 'peer_after'; await observePeer(candidateSpeed, 'after');
      }
      result.status = 'completed';
      return result;
    }
    // The one-shot resume entry starts on the connection created above. It never
    // performs an earlier playback on that connection or retries another speed.
    if (!resumeSpeed2) {
      stage = 'probe'; result.probe = await probe(input());
      if (result.probe.status !== 'completed') throw new HostError('HOST_PROBE_FAILED');
    }
    stage = 'speed_candidates';
    for (const candidateSpeed of resumeSpeed2 ? [2] : ANDROID_SPEED_CANDIDATES) {
      const observation = await probe({ ...input(), candidateSpeed });
      result.speedObservations.push(observation);
      if (observation.status === 'completed') continue;
      if (resumeSpeed2) throw new HostError(observation.error?.code === 'CONTROL_REJECTED'
        ? 'HOST_CANDIDATE_REJECTED' : 'HOST_CANDIDATE_UNCONFIRMED');
      // A correlated rejection has a known result. Close this owner before a
      // serial replacement connection; unconfirmed/timeout failures end the run.
      if (observation.error?.code !== 'CONTROL_REJECTED' || observation.cleanupError)
        throw new HostError('HOST_CANDIDATE_UNCONFIRMED');
      await closeService();
      if (candidateSpeed !== ANDROID_SPEED_CANDIDATES.at(-1)) { stage = 'reconnect'; await connect(); stage = 'speed_candidates'; }
    }
    result.status = 'completed';
  } catch (error) {
    result.error = { code: error instanceof HostError ? error.code : 'HOST_OPERATION_FAILED', stage };
  } finally {
    try { await closeService(); }
    catch { result.error ??= { code: 'HOST_CLOSE_FAILED', stage: 'close' }; }
    if (result.error) result.status = 'failed';
  }
  return result;
}

function createRealRuntime(sessionPath) {
  const { setLoggingLevel, LogLevel } = require('../../../vendor/eufy-security-client/build/logging');
  setLoggingLevel('all', LogLevel.Off);
  const { LocalEufySession } = require('../../auth/session.cjs');
  const { LocalContinuousRecordings } = require('../continuous.cjs');
  return { session: new LocalEufySession(undefined, { sessionPath }), createService: session => new LocalContinuousRecordings(session) };
}

function preflight(sessionPath, outputPath) {
  if (!path.isAbsolute(sessionPath) || !path.isAbsolute(outputPath)
    || path.resolve(sessionPath).toLowerCase() === path.resolve(outputPath).toLowerCase()
    || !fs.statSync(sessionPath).isFile() || fs.existsSync(outputPath)) throw new HostError('HOST_PATH_INVALID');
  fs.accessSync(sessionPath, fs.constants.R_OK);
  fs.accessSync(path.dirname(outputPath), fs.constants.W_OK);
}

async function main({ argv = process.argv.slice(2), env = process.env, createRuntime,
  preflight: checkPaths = preflight, writeEvidence = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }) } = {}) {
  const failure = code => ({ version: 1, status: 'failed', error: { code, stage: 'preflight' } });
  const resumeSpeed2 = (argv.length === 1 && argv[0] === '--resume-speed-2')
    || (argv.length === 2 && argv[0] === '--dry-run' && argv[1] === '--resume-speed-2');
  const resumeRemaining = (argv.length === 1 && argv[0] === '--resume-speeds-4-8-16')
    || (argv.length === 2 && argv[0] === '--dry-run' && argv[1] === '--resume-speeds-4-8-16');
  const resumeSpeed16 = (argv.length === 1 && argv[0] === '--resume-speed-16')
    || (argv.length === 2 && argv[0] === '--dry-run' && argv[1] === '--resume-speed-16');
  if (!resumeSpeed2 && !resumeRemaining && !resumeSpeed16 && (argv.length !== 1 || !['--dry-run', '--run'].includes(argv[0]))) return failure('HOST_ARGUMENTS_INVALID');
  const dryRun = argv[0] === '--dry-run';
  if (!dryRun) {
    if (!env.EUFY_SESSION_PATH?.trim() || !env.ISSUE9_PROBE_EVIDENCE_PATH?.trim()) return failure('HOST_ENV_REQUIRED');
    try { await checkPaths(env.EUFY_SESSION_PATH, env.ISSUE9_PROBE_EVIDENCE_PATH); }
    catch { return failure('HOST_PATH_INVALID'); }
  }
  let result;
  try {
    const runtime = createRuntime ? createRuntime(dryRun ? 'dry-run' : 'run', env.EUFY_SESSION_PATH)
      : dryRun ? createDryRunRuntime() : createRealRuntime(env.EUFY_SESSION_PATH);
    result = await runPlaybackControlsHost({ runtime, resumeSpeed2, resumeRemaining, resumeSpeed16 });
    result.mode = dryRun ? 'dry-run' : 'run';
  } catch { result = { version: 1, status: 'failed', error: { code: 'HOST_RUNTIME_FAILED', stage: 'runtime' } }; }
  if (!dryRun) {
    try { await writeEvidence(env.ISSUE9_PROBE_EVIDENCE_PATH, result); }
    catch { result.status = 'failed'; result.error = { code: 'HOST_EVIDENCE_FAILED', stage: 'output' }; }
  }
  return result;
}

function createDryRunRuntime() {
  const { EventEmitter } = require('node:events');
  const calls = { connect: 0, close: 0, p2pClose: 0, queries: [] };
  const inventory = { devices: [
    { device_sn: 'fake-base-private', device_model: 'T8030' },
    { device_sn: 'fake-camera-private', device_name: 'Drive Way', device_model: 'T8600', parent_sn: 'fake-base-private', device_channel: 7 },
  ] };
  const session = { state: { phase: 'connected' }, isAuthenticated: () => true, restore: async () => {},
    api: { getDevsListDecrypted: async () => inventory } };
  function makeService() {
    const p2p = new EventEmitter();
    p2p.connected = true; p2p.isConnected = () => p2p.connected;
    p2p.currentMessageState = { 1: { p2pStreaming: false } };
    p2p.streamTimeouts = { streamDataWait: 5000 };
    p2p.setStreamTimeouts = options => { p2p.streamTimeouts = { ...p2p.streamTimeouts, ...options }; };
    p2p.waitForStreamData = () => {};
    p2p.endStream = () => { p2p.continuousPlayback = undefined; p2p.currentMessageState[1].p2pStreaming = false; };
    p2p.isCurrentlyStreaming = () => p2p.currentMessageState[1].p2pStreaming;
    p2p.sendQueue = []; p2p.messageStates = new Map();
    let activeEnd, activeBegin;
    p2p.queryContinuousRecordings = (serial, channel, begin, end) => {
      calls.queries.push({ serial, channel, begin, end });
      activeEnd = end; activeBegin = begin;
      p2p.emit('continuous recording ranges', channel + 1, { begin_time: begin, end_time: end, videos: [] });
      p2p.emit('continuous recording ranges', channel, { begin_time: begin, end_time: end,
        videos: [{ start_time: end - begin > 60 ? end - 300 : begin, stop_time: end - begin > 60 ? end - 60 : end, file_path: 'fake-path-private' }] });
    };
    const frame = timestamp => p2p.emit('continuous playback frame', { kind: 'video', channel: 7, timestamp });
    const reply = (customData, channel) => p2p.emit('command', { command_type: 6001, channel, customData, return_code: 0 });
    p2p.sendCommandWithStringPayload = (command, customData) => {
      const { data } = JSON.parse(command.value);
      queueMicrotask(() => reply(customData, command.channel));
      if (data.cmd === 0) {
        setTimeout(() => frame((activeBegin + 1) * 1000), 1);
        if (customData) setTimeout(() => frame(activeEnd * 1000), 4);
      }
      if (data.cmd === 2) setTimeout(() => frame(activeEnd * 1000), 1);
    };
    p2p.startContinuousPlayback = (serial, channel, accountId, begin) => {
      p2p.continuousPlayback = { deviceSN: serial, channel }; p2p.currentMessageState[1].p2pStreaming = true;
      p2p.sendCommandWithStringPayload({ commandType: 1700, channel, value: JSON.stringify({ commandType: 6001,
        data: { session_id: 125, cmd: 0, play_type: 0, play_speed: 1, begin_time: begin, device_sn: serial, account_id: accountId, index: 0 } }) });
    };
    p2p.stopContinuousPlayback = () => {
      p2p.endStream(1);
      queueMicrotask(() => reply(undefined, 7));
    };
    p2p.close = async () => { calls.p2pClose++; p2p.connected = false; p2p.emit('close'); };
    return { station: { p2pSession: p2p, getSerial: () => 'fake-base-private', getModel: () => 'T8030' },
      camera: { getSerial: () => 'fake-camera-private', getModel: () => 'T8600', getName: () => 'Drive Way',
        getStationSerial: () => 'fake-base-private', getChannel: () => 7 }, userId: 'fake-account-private',
      connect: async () => { calls.connect++; }, close: async () => { calls.close++; if (p2p.isConnected()) await p2p.close(); } };
  }
  const runtime = { session, inventory, calls, service: makeService() };
  let created = false;
  runtime.createService = () => { if (created) runtime.service = makeService(); created = true; return runtime.service; };
  return runtime;
}

if (require.main === module) {
  // The adapter retains a UDP handle after close; this dedicated one-shot process
  // exits only after awaited cleanup and the final sanitized stdout write.
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.status === 'completed' ? 0 : 1)),
    () => process.stdout.write('{"status":"failed","error":{"code":"HOST_FAILED","stage":"main"}}\n', () => process.exit(1)));
}
module.exports = { runPlaybackControlsHost, main, createDryRunRuntime };
