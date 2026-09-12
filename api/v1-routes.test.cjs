const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const Ajv = require('ajv');
const { createServer } = require('../interface/server.cjs');
const { LocalEufySession } = require('../capabilities/auth/session.cjs');
const { OUTPUT } = require('../capabilities/recordings/continuous-export.cjs');
const { contract } = require('./v1-contract.cjs');
const { DeviceType } = require('../adapters/eufy');
const { DeviceVerificationRepository } = require('../capabilities/devices/verification-store.cjs');
const { JobService } = require('../jobs/service.cjs');
const { normalizeWindow } = require('../capabilities/recordings/time-window.cjs');
const { cli } = require('../cli/test-helper.cjs');
const { RecordingTools } = require('../agent/tools.cjs');
const { EventEmitter } = require('node:events');
const { P2PClientProtocol } = require('../adapters/eufy');

const ajv = new Ajv({ strict: false }); ajv.addSchema(contract);
function check(name, value) {
  const validate = ajv.getSchema(`${contract.$id}#/definitions/${name}`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}`);
}
const request = { requestId: 'first', serial: 'camera', day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto' };
const begin = 1787862600, end = begin + 60;
const inventory = () => [
  { device_sn: 'base', device_model: 'T8030', device_type: DeviceType.HB3, device_name: 'HomeBase', local_ip: '192.0.2.1' },
  { device_sn: 'camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247, device_name: 'Drive Way', parent_sn: 'base', device_channel: 0 },
  { device_sn: 'unsupported', device_model: 'OTHER', device_name: 'Other camera', parent_sn: 'base', device_channel: 1 },
];
function captureFixture() {
  return { begin, end, reachedEnd: true, ranges: [{ start_time: begin, stop_time: end }],
    segments: [{ begin, end, reachedEnd: true, boundaryTimestampMs: end * 1000 }], diagnostics: [],
    frames: Array.from({ length: 1200 }, (_, i) => ({ kind: 'video', timestamp: begin * 1000 + i * 50,
      keyFrame: i % 20 === 0, length: 1, offset: i, streamType: 1 })) };
}
function media({ short = false, fail = false } = {}) {
  return async (_executable, args, { stage, directory, signal }) => {
    signal.throwIfAborted();
    fs.writeFileSync(path.join(directory, `${stage}.stdout.log`), stage === 'decode' ? `frame=${short ? 20 : 1200}\nprogress=end\n` : '');
    fs.writeFileSync(path.join(directory, `${stage}.stderr.log`), '');
    if (fail) throw new Error('Runtime is unavailable');
    if (stage === 'mux') fs.writeFileSync(path.join(args[1], 'timed.ts'), 'ts');
    if (stage === 'convert') fs.writeFileSync(args.at(-1), 'fixture-mp4');
    if (stage === 'timeline') fs.writeFileSync(path.join(args[1], 'media-timeline.json'), JSON.stringify({ muxStartMs: 0,
      streams: { video: { count: short ? 20 : 1200, firstTimestampMs: 0, lastTimestampMs: short ? 950 : 59950, lastDurationMs: 50 } } }));
  };
}
async function fixture(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'v1-test-'));
  await options.beforeStart?.(path.join(directory, 'jobs'));
  const calls = { capture: 0, range: 0, sessionClosed: false, captureClosed: false };
  const raw = inventory();
  const api = { init: async () => {}, estimateDomain: async () => {}, login: async () => ({ code: 0 }),
    hasValidSession: () => true, getDevsListDecrypted: async () => ({ devices: raw }) };
  const session = new LocalEufySession(() => api);
  if (options.authenticatedAtStartup) session.restore = async () => {
    session.api = api; session.authenticated = true; session.state.phase = 'ready';
  };
  session.close = () => { calls.sessionClosed = true; };
  const server = createServer({ port: 0, session, recordings: options.recordings || { close() {} }, outputRoot: directory,
    capabilityRecordsPath: options.capabilityRecordsPath || path.join(directory, 'devices', 'verification.json'),
    deviceRepository: options.deviceRepository,
    playback: options.playback,
    exports: { outputRoot: path.join(directory, 'jobs'), execute: options.execute || media(), createCapture: () => ({
      close() { calls.captureClosed = true; },
      async captureRange(serial, start, stop, destination, control) {
        calls.capture++; calls.captureArguments = { serial, start, stop };
        if (options.captureRange) return options.captureRange(destination, control, calls);
        fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'frames.bin'), Buffer.alloc(1200));
        if (options.gate) await options.gate;
        const capture = captureFixture(); fs.writeFileSync(path.join(destination, 'frames.json'), JSON.stringify(capture));
        return capture;
      },
    }) },
    createRanges: () => ({ close() {}, async listRange(serial, start, stop) {
      calls.range++; calls.rangeArguments = { serial, start, stop };
      if (options.rangeError) throw new Error('HomeBase connection timed out');
      if (options.rangeGate) await options.rangeGate;
      return { videos: options.empty ? [] : [{ start_time: start, stop_time: stop }] };
    } }),
  });
  await new Promise(resolve => server.start(resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await server.shutdown(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function json(route, data, schema) {
    const response = await fetch(origin + route, data === undefined ? { headers: { Connection: 'close' } } : {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Connection: 'close' }, body: JSON.stringify(data),
    });
    const value = await response.json();
    if (response.status >= 400 && route.startsWith('/api/v1')) check('error', value);
    else if (schema) check(schema, value);
    return { status: response.status, value };
  }
  async function login() {
    assert.equal((await json('/login', { email: 'fixture@example.test', password: 'offline-fixture', country: 'CA' })).status, 202);
    const state = await json('/api/v1/session', undefined, 'session');
    assert.equal(state.value.authenticated, true);
  }
  async function terminal(id) {
    for (let attempt = 0; attempt < 1200; attempt++) {
      const { value } = await json(`/api/v1/jobs/${id}`, undefined, 'jobResponse');
      if (['succeeded', 'failed', 'cancelled'].includes(value.job.state)) return value.job;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Job did not finish');
  }
  return { directory, calls, raw, api, session, server, origin, json, login, terminal,
    deviceRepository: options.deviceRepository || new DeviceVerificationRepository(options.capabilityRecordsPath || path.join(directory, 'devices', 'verification.json')) };
}

function capabilityObservation(scope, capability, status = 'verified') {
  return { scope, capability, status, reason: 'offline_fixture_observation',
    evidence: [{ source: 'offline-api-fixture', observedAt: '2026-09-11', outcome: 'partial' }] };
}

function playbackFixture() {
  const p = new EventEmitter(), commands = [];
  Object.assign(p, { connected: true, deviceSNs: {}, sendQueue: [], messageStates: new Map(), streamTimeouts: { streamDataWait: 5000 },
    currentMessageState: { 1: { p2pStreaming: false, p2pStreamNotStarted: true, invalidStream: false, queuedData: new Map() } } });
  for (const name of ['startContinuousPlayback', 'stopContinuousPlayback', 'waitForStreamData', 'endStream', 'emitStreamStopEvent', 'setStreamTimeouts']) p[name] = P2PClientProtocol.prototype[name];
  p.isConnected = () => p.connected; p.isCurrentlyStreaming = () => p.currentMessageState[1].p2pStreaming;
  p.initializeMessageBuilder = p.initializeMessageState = p.initializeStream = p.closeEnergySavingDevice = () => {};
  p.queryContinuousRecordings = (_serial, channel, start, stop) => p.emit('continuous recording ranges', channel,
    { begin_time: start, end_time: stop, videos: [{ start_time: start, stop_time: stop, file_path: 'private-fixture-path' }] });
  p.sendCommandWithStringPayload = (command, customData) => {
    const cmd = JSON.parse(command.value).data.cmd; commands.push(cmd);
    queueMicrotask(() => {
      p.emit('command', { command_type: 6001, channel: 0, return_code: 0, customData });
      if (cmd === 0 || cmd === 2) {
        p.emit('continuous playback frame', { kind: 'video', channel: 0, timestamp: begin * 1000 + (cmd === 0 ? 1000 : 2000) });
        p.currentMessageState[1].p2pStreamNotStarted = false;
      }
    });
  };
  let created = 0, closed = false, closeGate;
  p.close = async () => { await closeGate; clearTimeout(p.currentMessageState[1].p2pStreamingTimeout); p.connected = false; p.continuousPlayback = undefined; closed = true; p.emit('close'); };
  return { commands, p, created: () => created, closed: () => closed, delayClose: gate => { closeGate = gate; },
    createConnection: () => { created++; return { connect: async () => {}, close: async () => {}, userId: 'private-fixture-account',
      station: { p2pSession: p, getSerial: () => 'base', getModel: () => 'T8030' },
      camera: { getSerial: () => 'camera', getModel: () => 'T8600', getStationSerial: () => 'base', getChannel: () => 0 } }; } };
}
async function enablePlayback(f) {
  for (const row of f.raw) { row.main_sw_version = 'main-fixture'; row.sec_sw_version = 'secondary-fixture'; }
  const { value } = await f.json('/api/v1/devices/camera', undefined, 'deviceResponse');
  f.deviceRepository.record({ ...capabilityObservation(value.device.verificationScope, 'continuousPlaybackControls'),
    controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1, 2, 4, 16] } });
}
const playbackInput = () => { const { requestId, ...input } = request; return { ...input, speed: 1 }; };

test('production playback HTTP requires durable scoped controls and returns the same owner across opaque session actions', async t => {
  const p = playbackFixture(), f = await fixture(t, { playback: { createConnection: p.createConnection } }); await f.login();
  assert.equal((await f.json('/api/v1/playback-sessions', playbackInput())).value.error.code, 'CONTROL_NOT_VERIFIED');
  assert.equal(p.created(), 0); await enablePlayback(f);
  const controls = await f.json('/api/v1/devices/camera/capabilities/continuousPlaybackControls', undefined, 'capabilityResponse');
  assert.deepEqual(controls.value.controls, { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1, 2, 4, 16] });
  await f.json('/api/v1/devices/camera/capabilities/rtsp', undefined, 'capabilityResponse');
  assert.equal((await f.json('/api/v1/playback-sessions', { ...playbackInput(), speed: 8 })).value.error.code, 'CONTROL_NOT_VERIFIED');
  const started = await f.json('/api/v1/playback-sessions', playbackInput(), 'playbackResponse');
  assert.equal(started.status, 201); const id = started.value.playback.sessionId;
  assert.equal((await f.json('/api/v1/session')).value.busy, true);
  assert.equal((await f.json('/api/v1/exports', request)).value.error.code, 'SERVICE_BUSY');
  assert.equal((await f.json('/api/v1/devices/camera/recording-ranges', request)).value.error.code, 'SERVICE_BUSY');
  assert.equal((await f.json('/recordings/query', {})).status, 409);
  assert.equal((await f.json(`/api/v1/playback-sessions/${id}/pause`, { channel: 2 })).status, 400);
  for (const action of ['pause', 'resume', 'close']) {
    const result = await f.json(`/api/v1/playback-sessions/${id}/${action}`, {}, 'playbackResponse');
    assert.equal(result.status, 200); assert.equal(result.value.playback.sessionId, id);
    assert.equal(JSON.stringify(result.value).includes('private-fixture'), false);
  }
  assert.deepEqual(p.commands, [0, 1, 2, 3]); assert.equal(p.created(), 1); assert.equal(p.closed(), true);
  assert.equal((await f.json('/api/v1/session')).value.busy, false);
});

for (const action of ['logout', 'shutdown']) test(`production playback ${action} waits for dedicated cleanup before releasing the cloud session`, async t => {
  const p = playbackFixture(), f = await fixture(t, { playback: { createConnection: p.createConnection } }); await f.login(); await enablePlayback(f);
  await f.json('/api/v1/playback-sessions', playbackInput(), 'playbackResponse');
  let release; p.delayClose(new Promise(resolve => { release = resolve; }));
  let settled = false;
  const pending = (action === 'logout' ? f.json('/api/v1/session/logout', {}) : f.server.shutdown()).then(value => { settled = true; return value; });
  try {
    for (let i = 0; i < 20 && !p.commands.includes(3); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(p.commands.includes(3), true); assert.equal(settled, false);
    assert.equal(f.session.isAuthenticated(), true); assert.equal(f.calls.sessionClosed, false);
  } finally { release(); }
  await pending; assert.equal(p.closed(), true);
  if (action === 'logout') assert.equal(f.session.isAuthenticated(), false); else assert.equal(f.calls.sessionClosed, true);
});

test('device discovery HTTP responses deduplicate capped inventory and expose unverified completeness', async t => {
  const f = await fixture(t); await f.login();
  f.api.getDevsListDecrypted = async () => ({ devices: Array.from({ length: 100 }, (_, i) => ({
    device_sn: `fixture-${i % 99}`, device_model: 'FUTURE_MODEL',
  })) });
  for (const [route, schema] of [['/api/v1/devices', 'devices'], ['/api/v1/devices/fixture-0', 'deviceResponse'],
    ['/api/v1/devices/fixture-0/capabilities/rtsp', 'capabilityResponse']]) {
    const { status, value } = await f.json(route, undefined, schema);
    assert.equal(status, 200);
    assert.equal(value.discovery.status, 'succeeded');
    assert.equal(value.discovery.completeness, 'unknown');
    assert.equal(value.discovery.pagination, 'unverified');
    assert.equal(value.discovery.limitReached, true);
    assert.equal(value.discovery.receivedCount, 100);
    assert.equal(value.discovery.uniqueCount, 99);
    if (value.devices) {
      assert.equal(value.devices.length, 99);
      assert.equal(value.devices[98].model, 'FUTURE_MODEL');
    }
  }
  const missing = await f.json('/api/v1/devices/not-returned');
  assert.equal(missing.status, 404);
  assert.equal(missing.value.discovery.completeness, 'unknown');
});

test('device discovery HTTP failures expose incomplete retryable status and clear it after retry', async t => {
  const f = await fixture(t); await f.login();
  for (const response of [null, { devices: [{}] }]) {
    f.api.getDevsListDecrypted = async () => {
      if (response === null) throw new Error('offline inventory failure');
      return response;
    };
    const failed = await f.json('/api/v1/devices');
    assert.equal(failed.status, 503);
    assert.equal(failed.value.error.code, 'DEVICE_UNAVAILABLE');
    assert.equal(failed.value.discovery.status, 'failed');
    assert.equal(failed.value.discovery.completeness, 'incomplete');
    assert.equal(failed.value.discovery.failedPage, 1);
    assert.equal(failed.value.discovery.retryable, true);
  }
  f.api.getDevsListDecrypted = async () => ({ devices: f.raw });
  const retried = await f.json('/api/v1/devices', undefined, 'devices');
  assert.equal(retried.status, 200);
  assert.equal(retried.value.discovery.status, 'succeeded');
  assert.equal(retried.value.discovery.completeness, 'unknown');
  assert.equal(retried.value.discovery.retryable, false);
});

test('device discovery preserves the capped read facts when the later verification-record stage fails', async t => {
  let fail = true;
  const f = await fixture(t, { deviceRepository: { read() {
    if (fail) throw new Error('offline record store failure');
    return { records: [], reachability: [] };
  } } });
  await f.login();
  f.api.getDevsListDecrypted = async () => ({ devices: Array.from({ length: 100 }, (_, i) => ({ device_sn: `fixture-${i}` })) });
  const failed = await f.json('/api/v1/devices');
  assert.equal(failed.status, 503);
  assert.equal(failed.value.error.code, 'CAPABILITY_RECORDS_UNAVAILABLE');
  assert.equal(failed.value.discovery.status, 'failed');
  assert.equal(failed.value.discovery.completeness, 'incomplete');
  assert.equal(failed.value.discovery.pagesRead, 1);
  assert.equal(failed.value.discovery.uniqueCount, 100);
  assert.equal(failed.value.discovery.failedPage, null);
  assert.equal(failed.value.discovery.limitReached, true);
  assert.equal(failed.value.discovery.retryable, true);
  assert.ok(failed.value.discovery.reasons.includes('capability_records_unavailable'));
  fail = false;
  assert.equal((await f.json('/api/v1/devices', undefined, 'devices')).value.discovery.status, 'succeeded');
});

test('HTTP operator cancel is local, persists pending cleanup, preserves FIFO and exposes cancelled evidence', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), cleanup = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { captureRange: async (directory, { signal }) => {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'frames.bin'), 'partial');
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup; return captureFixture();
  } });
  await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job;
  await ready;
  const second = (await f.json('/api/v1/exports', { ...request, requestId: 'second' }, 'submission')).value.job;
  f.api.hasValidSession = () => false;
  const cancelling = await f.json(`/api/v1/jobs/${first.jobId}/cancel`, {}, 'jobResponse');
  assert.equal(cancelling.status, 202); assert.equal(cancelling.value.job.state, 'running');
  assert.ok(cancelling.value.job.cancellationRequestedAt);
  assert.equal((await f.json(`/api/v1/jobs/${second.jobId}`)).value.job.state, 'queued');
  assert.equal((await f.json(`/api/v1/jobs/${second.jobId}/cancel`, {}, 'jobResponse')).value.job.state, 'cancelled');
  release(); const done = await f.terminal(first.jobId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.stage, 'capture');
  assert.equal(done.error.code, 'JOB_CANCELLED'); assert.match(done.error.message, /cancel/i);
  assert.ok(done.artifacts.some(item => item.path.endsWith('frames.bin')));
  assert.equal((await f.json(`/api/v1/jobs/${first.jobId}/cancel`, {}, 'jobResponse')).status, 200);
  assert.equal((await f.json('/api/v1/exports', { requestId: request.requestId }, 'submission')).value.job.jobId, first.jobId);
  assert.equal((await f.json('/api/v1/jobs/missing/cancel', {})).status, 404);
});

test('HTTP explicit retry preserves original diagnostics and request identity, validates input and login', async t => {
  let fail = true;
  const f = await fixture(t, { execute: (...args) => media({ fail })(...args) }); await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job;
  const failed = await f.terminal(first.jobId); assert.equal(failed.state, 'failed');
  assert.equal((await f.json(`/api/v1/jobs/${first.jobId}/retry`, {})).status, 400);
  assert.equal((await f.json(`/api/v1/jobs/${first.jobId}/retry`, { requestId: 'try', serial: 'changed' })).status, 400);
  f.api.hasValidSession = () => false;
  assert.equal((await f.json(`/api/v1/jobs/${first.jobId}/retry`, { requestId: 'try' })).status, 401);
  f.api.hasValidSession = () => true; fail = false;
  const retry = await f.json(`/api/v1/jobs/${first.jobId}/retry`, { requestId: 'try' }, 'submission');
  assert.equal(retry.status, 202); assert.equal(retry.value.job.retryOfJobId, first.jobId); assert.equal(retry.value.job.attempt, 2);
  const done = await f.terminal(retry.value.job.jobId); assert.equal(done.state, 'succeeded');
  assert.deepEqual((await f.json(`/api/v1/jobs/${first.jobId}`, undefined, 'jobResponse')).value.job, failed);
  f.api.hasValidSession = () => false;
  const duplicate = await f.json(`/api/v1/jobs/${first.jobId}/retry`, { requestId: 'try' }, 'submission');
  assert.equal(duplicate.status, 200); assert.equal(duplicate.value.reused, true); assert.equal(duplicate.value.job.jobId, done.jobId);
  assert.equal((await f.json('/api/v1/exports', { requestId: request.requestId }, 'submission')).value.job.jobId, first.jobId);
  f.api.hasValidSession = () => true;
  assert.equal((await f.json(`/api/v1/jobs/${done.jobId}/retry`, { requestId: 'no' })).status, 409);
  assert.equal((await f.json(`/api/v1/jobs/${done.jobId}/cancel`, {})).status, 409);
});

test('HTTP startup recovers queued work without a triggering request and shows interrupted historical evidence', async t => {
  let interruptedId, queuedId;
  const f = await fixture(t, { beforeStart: async outputRoot => {
    const jobs = new JobService({ outputRoot, worker: async () => ({ outcome: 'failed' }) });
    const input = { serial: request.serial, window: normalizeWindow(request) };
    const interrupted = jobs.submit({ requestId: 'old', homeBaseId: 'base', input });
    const queued = jobs.submit({ requestId: 'waiting', homeBaseId: 'base', input });
    interruptedId = interrupted.jobId; queuedId = queued.jobId; await jobs.whenIdle();
    fs.writeFileSync(path.join(interrupted.partialDir, 'evidence.log'), 'interrupted');
    fs.writeFileSync(interrupted.metadataPath, JSON.stringify({ ...interrupted, state: 'running', stage: 'mux',
      artifacts: [{ path: 'partial/evidence.log', metadata: { role: 'diagnostic' } }] }));
    fs.writeFileSync(queued.metadataPath, JSON.stringify(queued));
  } });
  // This fixture starts logged out: recovered work must explicitly fail LOGIN_REQUIRED, never capture.
  const disk = () => JSON.parse(fs.readFileSync(path.join(f.directory, 'jobs', queuedId, 'metadata.json')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disk().state, 'failed'); assert.equal(disk().error.code, 'LOGIN_REQUIRED');
  const old = (await f.json(`/api/v1/jobs/${interruptedId}`, undefined, 'jobResponse')).value.job;
  assert.equal(old.state, 'failed'); assert.equal(old.stage, 'mux'); assert.equal(old.error.code, 'JOB_INTERRUPTED');
  assert.equal(old.artifacts[0].playable, false);
  assert.equal(await fetch(f.origin + old.artifacts[0].url).then(r => r.text()), 'interrupted');
  assert.equal(f.calls.capture, 0);
  for (const command of ['get', 'wait']) {
    const response = await cli(['--url', f.origin, '--json', '--timeout', '2000', 'jobs', command, interruptedId]);
    assert.equal(response.code, 8); assert.equal(response.value.job.error.code, 'JOB_INTERRUPTED');
  }
  const tools = new RecordingTools({ baseUrl: f.origin });
  const observed = await tools.wait({ jobId: interruptedId, timeoutMs: 100, pollMs: 10 });
  assert.equal(observed.status, 'failed'); assert.equal(observed.error.code, 'JOB_INTERRUPTED');
  assert.equal(observed.complete, false);
});

test('HTTP recovered authenticated work owns the session and cancellation controls before any new submission', async t => {
  let queuedId, entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), cleanup = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, { authenticatedAtStartup: true, beforeStart: async outputRoot => {
    const jobs = new JobService({ outputRoot, worker: async () => ({ outcome: 'failed' }) });
    const queued = jobs.submit({ requestId: 'recovered', homeBaseId: 'base', input: { serial: request.serial, window: normalizeWindow(request) } });
    queuedId = queued.jobId; await jobs.whenIdle(); fs.writeFileSync(queued.metadataPath, JSON.stringify(queued));
  }, captureRange: async (directory, { signal }) => {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'frames.bin'), 'recovered bytes');
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup; return captureFixture();
  } });
  await ready;
  assert.equal((await f.json('/api/v1/session', undefined, 'session')).value.busy, true);
  assert.equal((await f.json('/api/v1/session/refresh', {})).status, 409);
  assert.equal((await f.json('/api/v1/devices/camera/recording-ranges', { day: request.day, start: request.start, end: request.end })).status, 409);
  assert.equal((await f.json(`/api/v1/jobs/${queuedId}/cancel`, {}, 'jobResponse')).status, 202);
  release(); assert.equal((await f.terminal(queuedId)).state, 'cancelled');
  assert.equal(f.calls.capture, 1);
});

test('HTTP concurrent retry identities create one attempt and recheck expiry after inventory waits', async t => {
  const f = await fixture(t, { execute: media({ fail: true }) }); await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job; await f.terminal(first.jobId);
  for (const expired of [false, true]) {
    let entered, release, count = 0;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.api.getDevsListDecrypted = async () => { if (++count === 2) entered(); await gate; return { devices: f.raw }; };
    const requestId = expired ? 'expired-retry' : 'shared-retry';
    const attempts = [1, 2].map(() => f.json(`/api/v1/jobs/${first.jobId}/retry`, { requestId }));
    await ready;
    if (expired) f.api.hasValidSession = () => false;
    release(); const results = await Promise.all(attempts);
    assert.deepEqual(results.map(r => r.status).sort(), expired ? [401, 401] : [200, 202]);
    if (!expired) {
      for (const result of results) check('submission', result.value);
      assert.equal(results[0].value.job.jobId, results[1].value.job.jobId);
      await f.terminal(results[0].value.job.jobId);
    }
  }
});

test('HTTP continuous playback controls queries preserve device scope without advertising verified controls or speeds', async t => {
  const f = await fixture(t); await f.login();
  f.raw[0].main_sw_version = 'base-1'; f.raw[1].main_sw_version = 'camera-1';
  f.raw.push({ ...f.raw[1], device_sn: 'second-camera', device_channel: 1, main_sw_version: 'camera-2' });
  const list = (await f.json('/api/v1/devices', undefined, 'devices')).value.devices;
  for (const device of list) {
    const expected = ['camera', 'second-camera'].includes(device.serial) ? {
      status: 'protocol_hint', reason: 'android_6001_controls_require_device_firmware_verification', evidence: [],
    } : { status: 'unknown', reason: 'no_verified_continuous_playback_controls_path', evidence: [] };
    expected.controls = { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] };
    assert.deepEqual(device.capabilities.continuousPlaybackControls, expected);
    const route = `/api/v1/devices/${device.serial}`;
    const single = (await f.json(route, undefined, 'deviceResponse')).value.device;
    assert.deepEqual(single.verificationScope, device.verificationScope);
    assert.deepEqual(single.capabilities.continuousPlaybackControls, expected);
    const capability = await f.json(`${route}/capabilities/continuousPlaybackControls`, undefined, 'capabilityResponse');
    assert.equal(capability.status, 200);
    assert.deepEqual(capability.value, {
      serial: device.serial, capability: 'continuousPlaybackControls', ...expected, discovery: capability.value.discovery,
      verificationScope: device.verificationScope,
    });
  }
  for (const [serial, main, channel] of [['camera', 'camera-1', 0], ['second-camera', 'camera-2', 1]]) {
    assert.deepEqual(list.find(device => device.serial === serial).verificationScope, {
      serial, model: 'T8600', firmware: { main, secondary: null }, channel,
      homeBase: { serial: 'base', model: 'T8030', firmware: { main: 'base-1', secondary: null } },
    });
  }
  assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0);
  assert.deepEqual(f.deviceRepository.read().records, []);
});

test('HTTP capability queries consume durable incremental records, expose four states and survive repository reopen', async t => {
  const f = await fixture(t);
  f.raw[0].main_sw_version = 'base-1'; f.raw[1].main_sw_version = 'camera-1';
  const route = '/api/v1/devices/camera/capabilities/continuousRecordingQuery';
  assert.equal((await f.json(route)).status, 401);
  await f.login();
  const initial = (await f.json('/api/v1/devices/camera', undefined, 'deviceResponse')).value.device;
  assert.deepEqual(initial.firmware, { main: 'camera-1', secondary: null });
  assert.equal(initial.recordingExport.status, 'protocol_hint');
  f.deviceRepository.record(capabilityObservation(initial.verificationScope, 'continuousRecordingQuery'));
  f.deviceRepository.record(capabilityObservation(initial.verificationScope, 'liveVideo', 'unsupported'));
  const updated = await f.json(route, undefined, 'capabilityResponse');
  assert.equal(updated.status, 200); assert.equal(updated.value.status, 'verified');
  assert.equal(updated.value.serial, 'camera'); assert.equal(updated.value.capability, 'continuousRecordingQuery');
  assert.deepEqual(updated.value.verificationScope, initial.verificationScope);
  const oldScope = structuredClone(initial.verificationScope); oldScope.firmware.main = 'camera-old';
  f.deviceRepository.record(capabilityObservation(oldScope, 'continuousRecordingQuery'));
  const otherScope = structuredClone(initial.verificationScope); otherScope.serial = 'another-device';
  f.deviceRepository.record(capabilityObservation(otherScope, 'continuousRecordingQuery'));
  new DeviceVerificationRepository(f.deviceRepository.path).record(capabilityObservation(initial.verificationScope, 'continuousRecordingExport'));
  const list = (await f.json('/api/v1/devices', undefined, 'devices')).value.devices;
  const current = list.find(item => item.serial === 'camera');
  assert.equal(current.capabilities.continuousRecordingQuery.status, 'verified');
  assert.equal(current.capabilities.liveVideo.status, 'unsupported');
  assert.equal(current.capabilities.eventRecordings.status, 'protocol_hint');
  assert.equal(current.capabilities.rtsp.status, 'unknown');
  assert.equal(current.recordingExport.supported, true);
  assert.equal(current.recordingExport.status, 'verified');
  assert.equal(current.capabilities.continuousRecordingExport.evidence[0].outcome, 'partial');
  assert.equal(current.verificationHistory.length, 4);
  assert.equal(current.verificationHistory.every(item => item.scope.serial === 'camera'), true);
  for (const capability of ['liveVideo', 'rtsp', 'eventRecordings', 'futureControl', 'toString']) {
    const result = await f.json(`/api/v1/devices/camera/capabilities/${capability}`, undefined, 'capabilityResponse');
    assert.equal(result.status, 200);
    assert.deepEqual(result.value.verificationScope, current.verificationScope);
    if (['futureControl', 'toString'].includes(capability)) assert.equal(result.value.reason, 'capability_not_catalogued');
  }
  assert.equal((await f.json('/api/v1/devices/absent/capabilities/rtsp')).value.error.code, 'DEVICE_NOT_FOUND');
  assert.equal((await f.json('/api/v1/session/logout', {})).status, 202);
  assert.equal((await f.json(route)).status, 401);
  assert.equal(f.deviceRepository.read().records.length, 5, 'Logout must retain long-lived capability evidence');
  const reopened = await fixture(t, { capabilityRecordsPath: f.deviceRepository.path });
  reopened.raw[0].main_sw_version = 'base-1'; reopened.raw[1].main_sw_version = 'camera-1';
  await reopened.login();
  assert.equal((await reopened.json(route, undefined, 'capabilityResponse')).value.status, 'verified');
});

test('HTTP keeps unknown metadata, absent parent identities and changed firmware/channel explanatory', async t => {
  const f = await fixture(t); await f.login();
  f.raw[0].main_sw_version = 'base-1'; f.raw[1].main_sw_version = 'camera-1';
  const route = '/api/v1/devices/camera';
  const scope = (await f.json(route, undefined, 'deviceResponse')).value.device.verificationScope;
  f.deviceRepository.record(capabilityObservation(scope, 'continuousRecordingQuery'));
  for (const [row, key, value] of [[1, 'main_sw_version', 'camera-2'], [0, 'main_sw_version', 'base-2'],
    [1, 'device_channel', 2], [1, 'parent_sn', 'missing-base-A'], [1, 'main_sw_version', undefined]]) {
    const previous = f.raw[row][key]; f.raw[row][key] = value;
    const device = (await f.json(route, undefined, 'deviceResponse')).value.device;
    assert.notEqual(device.capabilities.continuousRecordingQuery.status, 'verified');
    assert.equal(device.verificationHistory.length, 1);
    const controls = await f.json(`${route}/capabilities/continuousPlaybackControls`, undefined, 'capabilityResponse');
    assert.deepEqual(controls.value.verificationScope, device.verificationScope);
    f.raw[row][key] = previous;
  }
  f.raw[1].parent_sn = 'missing-base-A'; delete f.raw[1].device_channel;
  let missing = (await f.json(route, undefined, 'deviceResponse')).value.device;
  assert.equal(missing.homeBaseId, null); assert.equal(missing.channel, null);
  assert.equal(missing.verificationScope.homeBase.serial, 'missing-base-A');
  assert.equal(missing.verificationScope.homeBase.firmware.main, null);
  f.deviceRepository.record(capabilityObservation(missing.verificationScope, 'continuousRecordingQuery'));
  f.raw[1].parent_sn = 'missing-base-B';
  missing = (await f.json(route, undefined, 'deviceResponse')).value.device;
  assert.equal(missing.capabilities.continuousRecordingQuery.status, 'unknown');
  assert.equal(missing.verificationScope.homeBase.serial, 'missing-base-B');
  assert.equal(missing.verificationHistory.length, 2);
  f.raw[1].parent_sn = 'base'; f.raw[1].device_channel = 0; delete f.raw[1].main_sw_version;
  const unversioned = (await f.json(route, undefined, 'deviceResponse')).value.device;
  f.deviceRepository.record(capabilityObservation(unversioned.verificationScope, 'liveVideo'));
  assert.equal((await f.json(`${route}/capabilities/liveVideo`, undefined, 'capabilityResponse')).value.status, 'protocol_hint');
  f.raw[1].main_sw_version = 'camera-1';
  const restored = (await f.json(route, undefined, 'deviceResponse')).value.device;
  assert.equal(restored.capabilities.liveVideo.status, 'protocol_hint');
  assert.equal(restored.verificationHistory.some(item => item.scope.firmware.main === null), true);
  delete f.raw[2].device_model;
  const unknown = (await f.json('/api/v1/devices/unsupported', undefined, 'deviceResponse')).value.device;
  assert.equal(unknown.model, null); assert.equal(unknown.capabilities.rtsp.status, 'unknown');
});

test('HTTP shows persisted offline observations separately from capability evidence and range failures', async t => {
  const f = await fixture(t, { rangeError: true }); await f.login();
  f.raw[1].status = 0;
  const deviceRoute = '/api/v1/devices/camera';
  let device = (await f.json(deviceRoute, undefined, 'deviceResponse')).value.device;
  assert.equal(device.availability, 'unknown'); assert.equal(device.state.inventoryStatus, 0);
  const { requestId, serial, ...window } = request;
  assert.equal((await f.json(`${deviceRoute}/recording-ranges`, window)).value.error.code, 'DEVICE_UNAVAILABLE');
  device = (await f.json(deviceRoute, undefined, 'deviceResponse')).value.device;
  assert.equal(device.capabilities.continuousRecordingQuery.status, 'protocol_hint');
  assert.equal(device.availability, 'unknown');
  f.deviceRepository.observeReachability({ serial: 'camera', status: 'offline', reason: 'explicit_reachability_observation', observedAt: '2026-09-11' });
  device = (await f.json(deviceRoute, undefined, 'deviceResponse')).value.device;
  assert.equal(device.availability, 'offline'); assert.equal(device.state.observedAt, '2026-09-11');
  assert.equal(device.state.reason, 'explicit_reachability_observation');
  assert.equal(device.recordingExport.status, 'protocol_hint');
});

test('capability reads preserve inventory admission ownership and recheck logout or expiry after the wait', async t => {
  for (const mode of ['logout', 'expiry', 'login-guard']) await t.test(mode, async t => {
    const f = await fixture(t); await f.login();
    let release, entered; const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; }); t.after(() => release());
    f.api.getDevsListDecrypted = async () => { entered(); await gate; return { devices: f.raw }; };
    const pending = f.json('/api/v1/devices/camera/capabilities/rtsp');
    await started;
    if (mode === 'logout') assert.equal((await f.json('/api/v1/session/logout', {})).status, 202);
    if (mode === 'expiry') f.api.hasValidSession = () => false;
    if (mode === 'login-guard') assert.equal((await f.json('/api/v1/session/login', { email: 'fixture@example.test', password: 'fixture', country: 'CA' })).status, 409);
    release(); const result = await pending;
    assert.equal(result.status, mode === 'login-guard' ? 200 : 401);
    if (mode === 'login-guard') check('capabilityResponse', result.value);
    else assert.equal(result.value.error.code, 'UNAUTHENTICATED');
  });
});

test('capability query rejects a busy login and exposes storage errors without discarding records', async t => {
  const f = await fixture(t); await f.login();
  f.session.state.phase = 'busy';
  assert.equal((await f.json('/api/v1/devices/camera/capabilities/rtsp')).value.error.code, 'SERVICE_BUSY');
  f.session.state.phase = 'ready';
  fs.mkdirSync(path.dirname(f.deviceRepository.path), { recursive: true });
  fs.writeFileSync(f.deviceRepository.path, 'invalid-json');
  const result = await f.json('/api/v1/devices/camera/capabilities/rtsp');
  assert.equal(result.status, 503); assert.equal(result.value.error.code, 'CAPABILITY_RECORDS_UNAVAILABLE');
  assert.equal(fs.readFileSync(f.deviceRepository.path, 'utf8'), 'invalid-json');
});

test('embedded device repository supplies observations only after authentication', async t => {
  let reads = 0;
  const deviceRepository = { read() {
    reads++;
    return { records: [], reachability: [{ serial: 'camera', status: 'online', reason: 'embedded_observation', observedAt: '2026-09-11' }] };
  } };
  const f = await fixture(t, { deviceRepository });
  assert.equal((await f.json('/api/v1/devices')).status, 401); assert.equal(reads, 0);
  await f.login();
  const device = (await f.json('/api/v1/devices/camera', undefined, 'deviceResponse')).value.device;
  assert.equal(device.availability, 'online'); assert.equal(device.state.reason, 'embedded_observation');
  assert.equal(reads, 1);
});

// Deliver a normal JSON body across two writes, with another request between them.
async function splitBody(f, route, data) {
  const text = JSON.stringify(data), middle = Math.floor(text.length / 2);
  const admitted = new Promise(resolve => f.server.prependOnceListener('request', () => setImmediate(resolve)));
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(f.origin + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: f.origin, Connection: 'close',
    } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(body) }));
    });
    request.on('error', reject); request.write(text.slice(0, middle));
  });
  await admitted;
  return { finish: () => { request.end(text.slice(middle)); return response; } };
}

test('legacy recording admissions reject expired sessions before and after a split body', async t => {
  for (const split of [false, true]) await t.test(String(split), async t => {
    let queries = 0;
    const f = await fixture(t, { recordings: { close() {}, listWindow: async () => { queries++; return []; } } });
    await f.login();
    const data = { serial: 'CAMERA123', day: '2026-08-27', start: '16:30', end: '16:31' };
    const pending = split ? await splitBody(f, '/recordings/query', data) : null;
    f.api.hasValidSession = () => false;
    const response = pending ? await pending.finish() : await f.json('/recordings/query', data);
    assert.equal(response.status, 401);
    assert.equal(queries, 0);
  });
});

test('versioned login and legacy verification share one captcha/email flow; CLI may omit Origin', async t => {
  const f = await fixture(t); const codes = [100032, 26052, 26050, 0]; let loginCalls = 0;
  f.api.login = async () => { loginCalls++; return { code: codes.shift() }; };
  f.api.generateCaptcha = async () => ({ captcha_id: 'shared-image', item: 'image' });
  f.api.sendVerifyCode = async () => ({ code: 0 });
  const login = await fetch(f.origin + '/api/v1/session/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture', country: 'CA' }) });
  assert.equal(login.status, 202);
  let state = (await f.json('/api/v1/session', undefined, 'session')).value;
  assert.equal(state.phase, 'captcha'); assert.match(state.captcha, /^data:image/);
  assert.equal((await f.json('/verify', { code: 'image-answer' })).status, 202);
  assert.equal((await f.json('/status')).value.phase, 'tfa');
  assert.equal((await f.json('/api/v1/session/verify', { code: 'wrong' })).status, 202);
  assert.equal((await f.json('/api/v1/session', undefined, 'session')).value.phase, 'tfa');
  assert.equal((await f.json('/api/v1/session/verify', { code: '123456' })).status, 202);
  state = (await f.json('/api/v1/session', undefined, 'session')).value;
  assert.equal(state.authenticated, true); assert.equal(state.captcha, null);
  assert.equal(f.session.api, f.api); assert.equal(loginCalls, 4);
  assert.equal((await f.json('/api/v1/session/logout', {})).status, 202);
  assert.equal((await f.json('/status')).value.phase, 'login_required');
  assert.equal((await f.json('/api/v1/devices')).status, 401);
  assert.equal((await f.json('/refresh', {})).status, 401);
});

test('logout ends queued work with LOGIN_REQUIRED while an owned capture finishes and remains readable', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { gate }); await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job;
  const second = (await f.json('/api/v1/exports', { ...request, requestId: 'queued-logout' }, 'submission')).value.job;
  assert.equal(f.calls.capture, 1);
  const logout = await splitBody(f, '/api/v1/session/logout', {});
  assert.equal((await logout.finish()).status, 202);
  assert.equal(f.session.api, undefined); assert.equal(f.session.credentials, undefined);
  const cancelled = (await f.json(`/api/v1/jobs/${second.jobId}`, undefined, 'jobResponse')).value.job;
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.error.code, 'LOGIN_REQUIRED');
  assert.equal(cancelled.result.outcome, 'cancelled');
  const stored = JSON.parse(fs.readFileSync(path.join(f.directory, 'jobs', second.jobId, 'metadata.json')));
  assert.equal(stored.error.code, 'LOGIN_REQUIRED');
  const reused = await f.json('/api/v1/exports', { requestId: second.requestId }, 'submission');
  assert.equal(reused.status, 200); assert.equal(reused.value.job.jobId, second.jobId);
  assert.equal((await f.json('/api/v1/exports', { ...request, requestId: 'new-logout' })).status, 401);
  assert.equal((await f.json('/login', {})).status, 409);
  release(); const finished = await f.terminal(first.jobId);
  assert.equal(finished.state, 'succeeded'); assert.equal(f.calls.capture, 1);
  const artifact = finished.artifacts.find(item => item.playable);
  assert.equal((await fetch(f.origin + artifact.url)).status, 200);
  await f.login(); assert.equal((await f.json('/api/v1/devices')).status, 200);
});

test('expiry projects waiting jobs as LOGIN_REQUIRED and blocks capture when their turn arrives', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { gate }); await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job;
  const second = (await f.json('/api/v1/exports', { ...request, requestId: 'queued-expiry' }, 'submission')).value.job;
  f.api.hasValidSession = () => false;
  const waiting = (await f.json(`/api/v1/jobs/${second.jobId}`, undefined, 'jobResponse')).value.job;
  assert.equal(waiting.state, 'queued'); assert.equal(waiting.stage, 'login_required'); assert.equal(waiting.error.code, 'LOGIN_REQUIRED');
  assert.equal((await f.json('/api/v1/session', undefined, 'session')).value.phase, 'login_required');
  release(); await f.terminal(first.jobId);
  const failed = await f.terminal(second.jobId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'LOGIN_REQUIRED');
  assert.equal(failed.result.validation.passed, false); assert.ok(failed.artifacts.some(item => item.name === 'result.json'));
  assert.equal(f.calls.capture, 1);
});

test('logout while cloud admissions wait rejects new work after body and inventory boundaries', async t => {
  for (const boundary of ['body', 'inventory']) for (const route of ['/api/v1/exports', '/api/v1/devices/camera/recording-ranges'])
    await t.test(`${boundary} ${route}`, async t => {
      const f = await fixture(t); await f.login();
      const data = route.endsWith('exports') ? request : { day: request.day, start: request.start, end: request.end };
      let pending, release;
      if (boundary === 'body') pending = await splitBody(f, route, data);
      else {
        let entered; const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
        f.api.getDevsListDecrypted = async () => { entered(); await gate; return { devices: f.raw }; };
        pending = f.json(route, data); await started;
      }
      assert.equal((await f.json('/logout', {})).status, 202);
      const response = boundary === 'body' ? await pending.finish() : (release(), await pending);
      assert.equal(response.status, 401); assert.equal(response.value.error.code, 'UNAUTHENTICATED');
      assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0);
    });
});

test('versioned auth replacement keeps final body admission guards', async t => {
  for (const route of ['/api/v1/session/login', '/api/v1/session/verify', '/api/v1/session/refresh'])
    await t.test(route, async t => {
      let release; const rangeGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      const f = await fixture(t, { rangeGate }); await f.login();
      const data = route.endsWith('login') ? { email: 'new@example.test', password: 'new', country: 'CA' } : { code: '123456' };
      const pending = await splitBody(f, route, data);
      const range = f.json('/api/v1/devices/camera/recording-ranges', { day: request.day, start: request.start, end: request.end });
      while (!f.calls.range) await new Promise(resolve => setImmediate(resolve));
      const response = await pending.finish(); assert.equal(response.status, 409); assert.equal(f.session.api, f.api);
      release(); await range;
    });
});

test('logout while media preparation is pending prevents new capture and preserves diagnostics', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); t.after(() => release());
  const execute = media();
  const f = await fixture(t, { execute: async (...args) => {
    if (args[2].stage === 'python-runtime') { entered(); await gate; }
    return execute(...args);
  } }); await f.login();
  const first = (await f.json('/api/v1/exports', request, 'submission')).value.job;
  await started;
  assert.equal((await f.json('/api/v1/session/logout', {})).status, 202);
  release(); const failed = await f.terminal(first.jobId);
  assert.equal(failed.error.code, 'LOGIN_REQUIRED'); assert.equal(f.calls.capture, 0);
  assert.ok(failed.artifacts.some(item => item.name === 'result.json'));
});

test('split-body auth admissions cannot replace or refresh a session after v1 acquires it', async t => {
  for (const route of ['/login', '/refresh', '/verify']) {
    await t.test(route, async t => {
      let release; const rangeGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      const f = await fixture(t, { rangeGate }); await f.login();
      const api = f.session.api; let mutations = 0;
      f.session.login = async () => { mutations++; f.session.api = { ...api }; };
      f.session.refresh = async () => { mutations++; };
      f.session.verify = async () => { mutations++; f.session.authenticated = true; f.session.state.phase = 'connected'; };
      if (route === '/verify') { f.session.authenticated = false; f.session.state.phase = 'tfa'; }
      const pending = await splitBody(f, route, route === '/login'
        ? { email: 'fixture@example.test', password: 'fixture', country: 'CA' } : route === '/verify' ? { code: 'fixture' } : {});
      if (route === '/verify') {
        // Another ordinary verification completes before the delayed duplicate request.
        assert.equal((await f.json('/verify', { code: 'fixture' })).status, 202); mutations = 0;
      }
      const { requestId, serial, ...window } = request;
      const range = f.json('/api/v1/devices/camera/recording-ranges', window, 'ranges');
      while (!f.calls.range) await new Promise(resolve => setTimeout(resolve, 5));
      const result = await pending.finish();
      assert.equal(result.status, 409, `${route} admitted while v1 range active; side effects=${mutations}`);
      assert.equal(mutations, 0); assert.equal(f.session.api, api);
      release(); await range;
    });
  }
});

test('split-body legacy query/download cannot acquire playback after v1 acquires it', async t => {
  for (const route of ['/recordings/query', '/recordings/download']) {
    await t.test(route, async t => {
      let release; const rangeGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      let acquisitions = 0;
      const f = await fixture(t, { rangeGate, recordings: {
        close() {}, async listWindow() { acquisitions++; return [{ record_id: 1, start_time: new Date(begin * 1000), end_time: new Date(end * 1000) }]; },
        async download() { acquisitions++; throw new Error('Unexpected competing download'); },
      } }); await f.login();
      const { requestId, serial, ...window } = request;
      if (route === '/recordings/download') {
        assert.equal((await f.json('/recordings/query', { ...window, serial: 'CAMERA123' })).status, 202);
        while ((await f.json('/recordings/status')).value.busy) await new Promise(resolve => setTimeout(resolve, 5));
        acquisitions = 0;
      }
      const pending = await splitBody(f, route, route.endsWith('/query') ? { ...window, serial: 'CAMERA123' } : { recordId: '1' });
      const range = f.json('/api/v1/devices/camera/recording-ranges', window, 'ranges');
      while (!f.calls.range) await new Promise(resolve => setTimeout(resolve, 5));
      const result = await pending.finish();
      assert.equal(result.status, 409, `${route} admitted while v1 range active; competing acquisitions=${acquisitions}`);
      assert.equal(acquisitions, 0); release(); await range;
    });
  }
});

test('split-body v1 admissions recheck legacy ownership after their bodies arrive', async t => {
  for (const route of ['/api/v1/exports', '/api/v1/devices/camera/recording-ranges']) {
    await t.test(route, async t => {
      let release;
      const legacyGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      const f = await fixture(t, { recordings: { close() {}, listWindow: async () => { await legacyGate; return []; } } }); await f.login();
      const { requestId, serial, ...window } = request;
      const pending = await splitBody(f, route, route.endsWith('/exports') ? request : window);
      assert.equal((await f.json('/recordings/query', { ...window, serial: 'CAMERA123' })).status, 202);
      const result = await pending.finish();
      assert.equal(result.status, 409); assert.equal(result.value.error.code, 'SERVICE_BUSY');
      assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0); release();
    });
  }
});

test('split-body v1 admissions recheck authentication after a login changes session state', async t => {
  for (const route of ['/api/v1/exports', '/api/v1/devices/camera/recording-ranges']) {
    await t.test(route, async t => {
      const f = await fixture(t); await f.login();
      const { requestId, serial, ...window } = request;
      const pending = await splitBody(f, route, route.endsWith('/exports') ? request : window);
      f.session.login = async () => { f.session.authenticated = false; f.session.state.phase = 'tfa'; };
      assert.equal((await f.json('/login', { email: 'fixture@example.test', password: 'fixture', country: 'CA' })).status, 202);
      const result = await pending.finish();
      assert.equal(result.status, 401, `Unauthenticated v1 admission; captures=${f.calls.capture}, ranges=${f.calls.range}`);
      assert.equal(result.value.error.code, 'UNAUTHENTICATED'); assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0);
    });
  }
});

test('split-body login cannot replace a session during v1 inventory admission', async t => {
  for (const route of ['/api/v1/exports', '/api/v1/devices/camera/recording-ranges']) {
    await t.test(route, async t => {
      let release; const inventoryGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
      const f = await fixture(t); await f.login(); let started = false, replacements = 0;
      f.api.getDevsListDecrypted = async () => { started = true; await inventoryGate; return { devices: f.raw }; };
      f.session.login = async () => { replacements++; f.session.api = {}; };
      const pending = await splitBody(f, '/login', { email: 'fixture@example.test', password: 'fixture', country: 'CA' });
      const { requestId, serial, ...window } = request;
      const operation = f.json(route, route.endsWith('/exports') ? request : window);
      while (!started) await new Promise(resolve => setTimeout(resolve, 5));
      const response = await pending.finish();
      // Release and collect the v1 request even if an assertion fails.
      release(); await operation;
      assert.equal(response.status, 409, `Session replacements during inventory=${replacements}`);
      assert.equal(replacements, 0); assert.equal(f.session.api, f.api);
    });
  }
});

test('known expired login is unauthenticated for session and new cloud-dependent admissions', async t => {
  const f = await fixture(t); await f.login();
  let inventoryCalls = 0;
  f.api.getDevsListDecrypted = async () => { inventoryCalls++; throw new Error('Expired fixture session'); };
  f.api.hasValidSession = () => false;
  const state = await f.json('/api/v1/session', undefined, 'session');
  const admissions = [];
  const { requestId, serial, ...window } = request;
  for (const [route, data] of [['/api/v1/devices', undefined], ['/api/v1/devices/camera', undefined],
    ['/api/v1/devices/camera/recording-ranges', window], ['/api/v1/exports', request]]) {
    const response = await f.json(route, data);
    admissions.push({ route, status: response.status, code: response.value.error.code });
  }
  assert.deepEqual({ authenticated: state.value.authenticated, admissions, inventoryCalls }, {
    authenticated: false, inventoryCalls: 0, admissions: admissions.map(item => ({ ...item, status: 401, code: 'UNAUTHENTICATED' })),
  });
  assert.equal(inventoryCalls, 0); assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0);
  assert.equal(f.session.authenticated, true, 'Validity reporting must not mutate resident ownership');
  assert.equal(f.session.api, f.api);
  f.api.hasValidSession = () => true;
  const unavailable = await f.json('/api/v1/devices');
  assert.equal(unavailable.status, 503); assert.equal(unavailable.value.error.code, 'DEVICE_UNAVAILABLE');
  assert.equal(inventoryCalls, 1);
});

test('known expiry is rechecked after request bodies and inventory waits', async t => {
  for (const stage of ['body', 'inventory-success', 'inventory-error']) {
    for (const route of ['/api/v1/exports', '/api/v1/devices/camera/recording-ranges']) {
      await t.test(`${stage} ${route}`, async t => {
        const f = await fixture(t); await f.login(); let inventoryCalls = 0;
        const { requestId, serial, ...window } = request;
        const data = route.endsWith('/exports') ? request : window;
        let response;
        if (stage === 'body') {
          f.api.getDevsListDecrypted = async () => { inventoryCalls++; return { devices: f.raw }; };
          const pending = await splitBody(f, route, data); f.api.hasValidSession = () => false;
          response = await pending.finish();
        } else {
          let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
          f.api.getDevsListDecrypted = async () => {
            inventoryCalls++; await gate;
            if (stage === 'inventory-error') throw new Error('Expired while inventory was in flight');
            return { devices: f.raw };
          };
          const pending = f.json(route, data);
          while (!inventoryCalls) await new Promise(resolve => setTimeout(resolve, 5));
          f.api.hasValidSession = () => false; release(); response = await pending;
        }
        assert.equal(response.status, 401, `Expired ${stage} admitted with captures=${f.calls.capture}, ranges=${f.calls.range}`);
        assert.equal(response.value.error.code, 'UNAUTHENTICATED');
        assert.equal(inventoryCalls, stage === 'body' ? 0 : 1);
        assert.equal(f.calls.capture, 0); assert.equal(f.calls.range, 0);
      });
    }
  }
});

test('known expiry preserves accepted jobs, local reads, global identity reuse and active ownership', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { gate }); await f.login();
  const accepted = await f.json('/api/v1/exports', request, 'submission'); const id = accepted.value.job.jobId;
  f.api.hasValidSession = () => false;
  const running = await f.json(`/api/v1/jobs/${id}`, undefined, 'jobResponse');
  assert.equal(running.status, 200); assert.equal(running.value.job.state, 'running');
  const reused = await f.json('/api/v1/exports', { requestId: request.requestId }, 'submission');
  assert.equal(reused.status, 200); assert.equal(reused.value.reused, true); assert.equal(reused.value.job.jobId, id);
  const denied = await f.json('/api/v1/exports', { ...request, requestId: 'new-after-expiry' });
  assert.equal(denied.status, 401); assert.equal(denied.value.error.code, 'UNAUTHENTICATED');
  assert.equal((await f.json('/login', {})).status, 409);
  assert.equal(f.calls.capture, 1); assert.equal(f.session.authenticated, true); assert.equal(f.session.api, f.api);
  release(); const job = await f.terminal(id);
  assert.equal(job.state, 'succeeded'); assert.equal(job.result.outcome, 'complete');
  const artifacts = await f.json(`/api/v1/jobs/${id}/artifacts`, undefined, 'artifacts');
  assert.equal(artifacts.status, 200);
  const playable = artifacts.value.artifacts.find(item => item.playable);
  const bytes = await fetch(f.origin + playable.url); assert.equal(bytes.status, 200); assert.equal(await bytes.text(), 'fixture-mp4');
});

test('HTTP golden path: login, mapped device, ranges, detached durable job, progress and owned artifact', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { gate });
  assert.equal((await f.json('/api/v1/session', undefined, 'session')).value.authenticated, false);
  assert.equal((await f.json('/api/v1/devices')).value.error.code, 'UNAUTHENTICATED');
  await f.login();
  const list = await f.json('/api/v1/devices', undefined, 'devices');
  const device = list.value.devices.find(item => item.serial === 'camera');
  assert.equal(device.homeBaseId, 'base'); assert.equal(device.channel, 0); assert.equal(device.recordingExport.supported, true);
  assert.deepEqual((await f.json('/api/v1/devices/camera', undefined, 'deviceResponse')).value.device, device);
  const { requestId, serial, ...window } = request;
  const ranges = await f.json('/api/v1/devices/camera/recording-ranges', window, 'ranges');
  assert.equal(ranges.value.coverage, null); assert.equal(ranges.value.ranges[0].start, '2026-08-27T20:30:00.000Z');
  const submitted = await f.json('/api/v1/exports', request, 'submission');
  assert.equal(submitted.status, 202); const id = submitted.value.job.jobId;
  assert.equal(submitted.value.job.state, 'queued');
  const stored = JSON.parse(fs.readFileSync(path.join(f.directory, 'jobs', id, 'metadata.json')));
  assert.equal(stored.requestId, request.requestId); assert.equal(stored.homeBaseId, 'base');
  const running = await f.json(`/api/v1/jobs/${id}`, undefined, 'jobResponse');
  assert.equal(running.value.job.state, 'running'); assert.equal(running.value.job.stage, 'capture');
  assert.equal(running.value.job.progress, 0.05); assert.equal(running.value.job.metadataPath, undefined);
  const reused = await f.json('/api/v1/exports', { requestId: 'first', serial: 'does-not-exist', timezone: 'nonsense' }, 'submission');
  assert.equal(reused.status, 200); assert.equal(reused.value.job.jobId, id); assert.equal(reused.value.reused, true);
  for (const route of ['/login', '/refresh', '/recordings/query', '/recordings/download'])
    assert.equal((await f.json(route, {})).value.error.code, 'SERVICE_BUSY');
  const second = await f.json('/api/v1/exports', { ...request, requestId: 'second' }, 'submission');
  assert.equal(second.status, 202); assert.equal(f.calls.capture, 1);
  release();
  const job = await f.terminal(id); await f.terminal(second.value.job.jobId);
  assert.equal(job.state, 'succeeded'); assert.equal(job.result.outcome, 'complete');
  const files = await f.json(`/api/v1/jobs/${id}/artifacts`, undefined, 'artifacts');
  const playable = files.value.artifacts.find(item => item.playable);
  assert.equal(playable.validated, true); assert.equal(playable.outcome, 'complete');
  const bytes = await fetch(f.origin + playable.url, { headers: { Range: 'bytes=0-6' } });
  assert.equal(bytes.status, 206); assert.equal(await bytes.text(), 'fixture');
  const diagnostic = files.value.artifacts.find(item => item.name === 'frames.bin');
  assert.equal(diagnostic.playable, false); assert.equal(diagnostic.validated, false);
  assert.equal((await fetch(f.origin + diagnostic.url)).status, 200);
  assert.equal((await f.json(`/api/v1/jobs/${id}/artifacts/unregistered`)).value.error.code, 'ARTIFACT_NOT_FOUND');
  const missing = await f.json('/api/v1/jobs/missing'); assert.equal(missing.value.error.code, 'JOB_NOT_FOUND');
  assert.equal((await f.json('/refresh', {})).status, 202);
  await new Promise(resolve => f.server.close(resolve)); await f.server.shutdown();
  const reopened = createServer({ port: 0, session: f.session, recordings: { close() {} }, outputRoot: f.directory,
    exports: { outputRoot: path.join(f.directory, 'jobs'), createCapture: () => assert.fail('Reusing a durable job must not capture again') } });
  t.after(async () => { await new Promise(resolve => reopened.close(resolve)); await reopened.shutdown(); });
  await new Promise(resolve => reopened.start(resolve));
  const again = await fetch(`http://127.0.0.1:${reopened.address().port}/api/v1/exports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'first' }),
  });
  assert.equal(again.status, 200); const replay = await again.json(); check('submission', replay);
  assert.equal(replay.job.jobId, id); assert.equal(replay.job.state, 'succeeded'); assert.equal(f.calls.capture, 2);
});

test('HTTP errors distinguish unsupported, unavailable, empty index, malformed request and shared time semantics', async t => {
  const f = await fixture(t, { empty: true }); await f.login();
  const { requestId, serial, ...window } = request;
  assert.equal((await f.json('/api/v1/devices/missing')).value.error.code, 'DEVICE_NOT_FOUND');
  assert.equal((await f.json('/api/v1/devices/unsupported/recording-ranges', window)).value.error.code, 'UNSUPPORTED_DEVICE');
  assert.equal((await f.json('/api/v1/exports', { ...request, homeBaseId: 'caller-chosen' })).value.error.code, 'INVALID_REQUEST');
  const empty = await f.json('/api/v1/devices/camera/recording-ranges', window, 'ranges');
  assert.equal(empty.value.code, 'NO_RECORDING'); assert.equal(empty.value.availability, 'none');
  assert.deepEqual(empty.value.ranges, []); assert.equal(empty.value.coverage, null);
  for (const [change, code] of [
    [{ timezone: 'invalid-zone' }, 'INVALID_TIMEZONE'],
    [{ day: '2026-03-08', start: '02:10', end: '03:30' }, 'AMBIGUOUS_OR_NONEXISTENT_TIME'],
    [{ day: '2026-11-01', start: '01:10', end: '02:30' }, 'AMBIGUOUS_OR_NONEXISTENT_TIME'],
    [{ start: '23:50', end: '00:10' }, 'INVALID_WINDOW'],
    [{ endDay: '2026-08-28' }, 'INVALID_WINDOW'],
  ]) {
    assert.equal((await f.json('/api/v1/exports', { ...request, ...change })).value.error.code, code);
    assert.equal((await f.json('/api/v1/devices/camera/recording-ranges', { ...window, ...change })).value.error.code, code);
  }
  const shanghai = await f.json('/api/v1/devices/camera/recording-ranges', { ...window, timezone: 'Asia/Shanghai' }, 'ranges');
  assert.equal(shanghai.value.window.normalized.start, '2026-08-27T08:30:00.000Z');
  assert.equal(f.calls.rangeArguments.start, 1787819400);
  const previousTimezone = process.env.EUFY_RECORDING_TIMEZONE;
  process.env.EUFY_RECORDING_TIMEZONE = 'Europe/London';
  try {
    const { timezone, ...implicit } = window;
    const normalized = await f.json('/api/v1/devices/camera/recording-ranges', implicit, 'ranges');
    assert.equal(normalized.value.window.input.timezone, null);
    assert.equal(normalized.value.window.normalized.timezone, 'Europe/London');
    assert.equal(normalized.value.window.normalized.start, '2026-08-27T15:30:00.000Z');
  } finally {
    if (previousTimezone === undefined) delete process.env.EUFY_RECORDING_TIMEZONE;
    else process.env.EUFY_RECORDING_TIMEZONE = previousTimezone;
  }
  delete f.raw[0].local_ip;
  assert.equal((await f.json('/api/v1/exports', request)).value.error.code, 'DEVICE_UNAVAILABLE');
  const g = await fixture(t, { rangeError: true }); await g.login();
  assert.equal((await g.json('/api/v1/devices/camera/recording-ranges', window)).value.error.code, 'DEVICE_UNAVAILABLE');
});

test('HTTP preserves partial versus failed and never labels raw candidates as validated playback', async t => {
  for (const mode of ['short', 'failed']) {
    const f = await fixture(t, { execute: media({ short: mode === 'short', fail: mode === 'failed' }) }); await f.login();
    const accepted = await f.json('/api/v1/exports', request, 'submission');
    const job = await f.terminal(accepted.value.job.jobId);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, mode === 'short' ? 'PARTIAL_RECORDING' : 'EXPORT_FAILED');
    assert.equal(job.result.outcome, mode === 'short' ? 'partial' : 'failed');
    assert.equal(job.result.coverageVerified, false);
    if (mode === 'short') {
      assert.equal(job.result.validation.passed, true);
      assert.ok(job.artifacts.some(item => item.playable && item.outcome === 'partial'));
    } else assert.ok(job.artifacts.every(item => !item.playable && !item.validated));
  }
});

test('session replacement is blocked during range I/O and legacy I/O excludes new v1 acquisition', async t => {
  let release; const rangeGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { rangeGate }); await f.login();
  const { requestId, serial, ...window } = request;
  const response = f.json('/api/v1/devices/camera/recording-ranges', window, 'ranges');
  while (!f.calls.range) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.json('/login', {})).value.error.code, 'SERVICE_BUSY');
  assert.equal((await f.json('/api/v1/exports', request)).value.error.code, 'SERVICE_BUSY');
  release(); await response;
  let finishLegacy;
  const g = await fixture(t, { recordings: { close() {}, listWindow: () => new Promise(resolve => { finishLegacy = () => resolve([]); }) } });
  t.after(() => finishLegacy?.()); await g.login();
  const legacy = await g.json('/recordings/query', { ...window, serial: 'CAMERA123' }); assert.equal(legacy.status, 202);
  assert.equal((await g.json('/api/v1/exports', request)).value.error.code, 'SERVICE_BUSY');
  finishLegacy();
});

test('shutdown waits for owned export cleanup before closing authentication; request disconnect does not own the job', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { captureRange: async (directory, { signal }, calls) => {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'frames.bin'), 'partial');
    started();
    await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 20), { once: true }));
    assert.equal(calls.sessionClosed, false);
    const capture = captureFixture(); capture.diagnostics.push({ stage: 'cancelled', message: 'Resident shutdown' });
    fs.writeFileSync(path.join(directory, 'frames.json'), JSON.stringify(capture)); return capture;
  } });
  await f.login(); const accepted = await f.json('/api/v1/exports', request, 'submission'); await ready;
  await new Promise(resolve => f.server.close(resolve)); await f.server.shutdown();
  assert.equal(f.calls.captureClosed, true); assert.equal(f.calls.sessionClosed, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.directory, 'jobs', accepted.value.job.jobId, 'metadata.json')));
  assert.equal(persisted.state, 'cancelled'); assert.ok(persisted.artifacts.length);
});

test('configured media runtime: actual HTTP export performs real mux, conversion, full decode and artifact access',
  { skip: !process.env.EUFY_PYTHON || !process.env.EUFY_FFMPEG }, async t => {
    let source;
    const f = await fixture(t, { execute: require('../capabilities/recordings/continuous-export.cjs').runProcess,
      captureRange: async destination => {
        fs.mkdirSync(destination);
        for (const file of ['frames.bin', 'frames.json']) fs.copyFileSync(path.join(source, file), path.join(destination, file));
        return JSON.parse(fs.readFileSync(path.join(destination, 'frames.json')));
      },
    });
    source = path.join(f.directory, 'synthetic'); fs.mkdirSync(source);
    const run = (executable, args) => {
      const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    };
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=128x72:r=20:d=60',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'bframes=0:keyint=20:repeat-headers=1', '-f', 'h264', path.join(source, 'synthetic.h264')]);
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-t', '60', '-c:a', 'aac', '-f', 'adts', path.join(source, 'synthetic.aac')]);
    run(process.env.EUFY_PYTHON, [path.join(__dirname, '../capabilities/recordings/fixtures/synthetic-continuous.py'), source]);
    await f.login(); const accepted = await f.json('/api/v1/exports', request, 'submission');
    const job = await f.terminal(accepted.value.job.jobId);
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.equal(job.result.validation.decode.videoFrames, 1200);
    assert.equal(job.result.validation.timingPreserved, true);
    const artifact = job.artifacts.find(item => item.playable);
    const response = await fetch(f.origin + artifact.url, { method: 'HEAD' });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.ok(Number(response.headers.get('content-length')) > 0);
  });
