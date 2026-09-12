const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { P2PClientProtocol, DeviceType } = require('../../adapters/eufy');
const { queryDevice } = require('../devices/capabilities.cjs');
const { PlaybackSessions } = require('./playback-session.cjs');

const raw = [
  { device_sn: 'base', device_model: 'T8030', device_type: DeviceType.HB3, main_sw_version: 'b1', sec_sw_version: 'b2' },
  { device_sn: 'camera', parent_sn: 'base', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247,
    device_channel: 1, main_sw_version: 'c1', sec_sw_version: 'c2' },
];
function verified() {
  const scope = queryDevice(raw, 'camera').verificationScope;
  return queryDevice(raw, 'camera', { records: [{ capability: 'continuousPlaybackControls', status: 'verified', scope,
    reason: 'fixture', evidence: [{ source: 'fixture', observedAt: '2026-09-12', outcome: 'commands_media' }],
    controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1, 2, 4, 16] } }] });
}
async function tick(t, ms = 0) { await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(ms); await new Promise(resolve => setImmediate(resolve)); }
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const p2p = new EventEmitter(), sent = [], closes = [];
  Object.assign(p2p, { connected: true, deviceSNs: {}, sendQueue: [], messageStates: new Map(),
    streamTimeouts: { streamDataWait: 5000 }, currentMessageState: { 1: { p2pStreaming: false, p2pStreamNotStarted: true, invalidStream: false, queuedData: new Map() } } });
  p2p.isConnected = () => p2p.connected;
  p2p.isCurrentlyStreaming = () => p2p.currentMessageState[1].p2pStreaming;
  for (const method of ['startContinuousPlayback', 'stopContinuousPlayback', 'waitForStreamData', 'endStream', 'emitStreamStopEvent', 'setStreamTimeouts']) p2p[method] = P2PClientProtocol.prototype[method];
  p2p.initializeMessageBuilder = p2p.initializeMessageState = p2p.initializeStream = p2p.closeEnergySavingDevice = () => {};
  const frame = (timestamp, channel = 1) => {
    p2p.waitForStreamData(1, true);
    p2p.emit('continuous playback frame', { kind: 'video', channel, timestamp, data: Buffer.from('private-media') });
    p2p.currentMessageState[1].p2pStreamNotStarted = false;
  };
  p2p.sendCommandWithStringPayload = (command, customData) => {
    const payload = JSON.parse(command.value); sent.push({ payload, customData, channel: command.channel });
    if (options.noReply === payload.data.cmd) return;
    queueMicrotask(() => {
      p2p.emit('command', { command_type: 6001, channel: 2, customData, return_code: 0 });
      p2p.emit('command', { command_type: 6001, channel: 1, customData: {}, return_code: 0 });
      p2p.emit('command', { command_type: 6001, channel: 1, customData, return_code: options.reject === payload.data.cmd ? 7 : 0 });
      if (payload.data.cmd === 0 && !options.noFrame) options.firstFrameDelay ? setTimeout(() => frame(101000), options.firstFrameDelay) : frame(101000);
      if (payload.data.cmd === 2) frame(102000);
    });
  };
  p2p.queryContinuousRecordings = (_serial, channel, begin, end) => p2p.emit('continuous recording ranges', channel,
    { begin_time: begin, end_time: end, videos: [{ start_time: begin, stop_time: end,
      ...(Object.hasOwn(options, 'filePath') ? { file_path: options.filePath } : {}) }] });
  p2p.close = async () => { closes.push('p2p'); await options.closeGate; clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
    p2p.connected = false; p2p.continuousPlayback = undefined; p2p.currentMessageState[1].p2pStreaming = false; p2p.emit('close'); };
  const connection = { station: { p2pSession: p2p, getSerial: () => 'base', getModel: () => 'T8030' },
    camera: { getSerial: () => 'camera', getStationSerial: () => 'base', getModel: () => 'T8600', getChannel: () => 1 },
    userId: 'private-account', connect: async () => { if (options.connectError) throw new Error('private-connect-error'); },
    close: async () => { closes.push('service'); if (options.closeError) throw new Error('private-cleanup-error'); } };
  const session = { api: {}, isAuthenticated: () => true };
  let device = verified(), created = 0, resolveGate;
  const service = new PlaybackSessions({ session, resolveDevice: async () => { await resolveGate; return device; },
    createConnection: () => { created++; return connection; } });
  t.after(async () => { await service.shutdown().catch(error => { if (!options.closeError) throw error; }); });
  return { service, p2p, sent, closes, frame, session, setDevice: value => { device = value; }, setResolveGate: value => { resolveGate = value; }, created: () => created,
    start: speed => service.start({ serial: 'camera', begin: 100, end: 160, speed }) };
}

test('resident playback holds the same owner across a pause longer than five seconds and confirms resume/close', async t => {
  const f = fixture(t), started = await f.start(1), owner = f.p2p.continuousPlayback;
  assert.equal(started.state, 'playing'); assert.notEqual(started.sessionId, 'camera');
  const paused = await f.service.pause(started.sessionId);
  assert.equal(paused.state, 'paused'); assert.ok(paused.pauseExpiresAtMs > Date.now());
  await tick(t, 6000);
  assert.equal(f.p2p.continuousPlayback, owner);
  const resumed = await f.service.resume(started.sessionId);
  assert.equal(resumed.state, 'playing'); assert.equal(resumed.positionMs, 102000);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
  const closed = await f.service.close(started.sessionId);
  assert.equal(closed.state, 'closed'); assert.equal(closed.stopConfirmed, true);
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1, 2, 3]);
  assert.equal(new Set(f.sent.map(row => row.customData)).size, 4);
  assert.deepEqual(f.closes, ['p2p', 'service']); assert.equal(f.created(), 1);
  assert.equal(JSON.stringify(resumed).includes('private-'), false);
});

for (const path of [undefined, null, '', 'private-current-path']) test(`resident resume uses current query path (${String(path)})`, async t => {
  const f = fixture(t, { filePath: path }), started = await f.start(1);
  await f.service.pause(started.sessionId); await f.service.resume(started.sessionId);
  const resume = f.sent.find(row => row.payload.data.cmd === 2).payload.data;
  assert.equal(Object.hasOwn(resume, 'file_path'), typeof path === 'string');
  if (typeof path === 'string') assert.equal(resume.file_path, path);
  assert.equal(resume.begin_time, 101);
});

test('unverified records and speed 8 or arbitrary values never create a connection', async t => {
  const f = fixture(t);
  for (const speed of [8, 3, 32]) await assert.rejects(f.start(speed), { code: 'CONTROL_NOT_VERIFIED' });
  f.setDevice(queryDevice(raw, 'camera'));
  await assert.rejects(f.start(1), { code: 'CONTROL_NOT_VERIFIED' }); assert.equal(f.created(), 0);
});
for (const speed of [2, 4, 16]) test(`verified start ${speed} never exposes fixed-speed-1 pause/resume`, async t => {
  const f = fixture(t), started = await f.start(speed);
  assert.equal(f.sent[0].payload.data.play_speed, speed);
  await assert.rejects(f.service.pause(started.sessionId), { code: 'CONTROL_NOT_VERIFIED' });
  await assert.rejects(f.service.resume(started.sessionId), { code: 'CONTROL_NOT_VERIFIED' });
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0]);
});
test('scope changes and replaced cloud sessions invalidate the old owner before another control', async t => {
  const f = fixture(t), started = await f.start(1), changed = verified();
  changed.verificationScope.firmware.main = 'changed'; f.setDevice(changed);
  await assert.rejects(f.service.pause(started.sessionId), { code: 'CONTROL_SCOPE_CHANGED' });
  assert.equal(f.p2p.connected, false); assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0]);
});
test('command rejection and an uncorrelated timeout close the owner with explicit errors', async t => {
  const f = fixture(t, { reject: 1 }), started = await f.start(1);
  await assert.rejects(f.service.pause(started.sessionId), { code: 'CONTROL_REJECTED' });
  assert.equal(f.p2p.connected, false);
});
test('unconfirmed command closes without a subsequent stop and concurrent calls fail busy', async t => {
  const f = fixture(t, { noReply: 1 }), started = await f.start(1);
  const pending = f.service.pause(started.sessionId); const rejection = assert.rejects(pending, { code: 'CONTROL_TIMEOUT' });
  await tick(t);
  await assert.rejects(f.service.resume(started.sessionId), { code: 'SERVICE_BUSY' });
  await tick(t, 1500); await rejection;
  assert.equal(f.p2p.connected, false); assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1]);
});
test('pause has a bounded local lease and cannot silently become a permanent session', async t => {
  const f = fixture(t), started = await f.start(1); await f.service.pause(started.sessionId);
  await tick(t, 30000);
  assert.equal(f.service.get(started.sessionId).state, 'closed'); assert.equal(f.p2p.connected, false);
});

test('resident startup keeps the real adapter alive until six-second video then restores five-second idle', async t => {
  const f = fixture(t, { firstFrameDelay: 6000 }); const pending = f.start(1);
  await tick(t, 5000); assert.equal(f.p2p.streamTimeouts.streamDataWait, 15000); assert.ok(f.p2p.continuousPlayback);
  await tick(t, 1000); assert.equal((await pending).state, 'playing'); assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
});
test('resident startup without valid current media is bounded and restores adapter settings on cleanup', async t => {
  const f = fixture(t, { noFrame: true }), pending = f.start(1), rejected = assert.rejects(pending, { code: 'CONTROL_STARTUP_TIMEOUT' });
  await tick(t); f.frame(99000); f.frame(101000, 2); f.frame(NaN);
  await tick(t, 15000); await rejected;
  assert.equal(f.p2p.connected, false); assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0]);
});
test('resident pause media advance fails without resume and reports only a fixed error', async t => {
  const f = fixture(t), started = await f.start(1); await f.service.pause(started.sessionId);
  f.frame(101000); f.frame(110000, 2); assert.equal(f.service.get(started.sessionId).state, 'paused');
  f.frame(101001); await tick(t);
  await assert.rejects(f.service.resume(started.sessionId), { code: 'PAUSE_MEDIA_ADVANCED' });
  assert.equal(f.p2p.connected, false); assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1]);
});
test('resident connection loss and replaced authentication fail before any further control', async t => {
  const f = fixture(t), started = await f.start(1); f.session.api = {};
  await assert.rejects(f.service.pause(started.sessionId), { code: 'UNAUTHENTICATED' });
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0]); assert.equal(f.p2p.connected, false);
});
test('resident connect and cleanup exceptions have fixed errors without leaking local exception details', async t => {
  const f = fixture(t, { connectError: true });
  await assert.rejects(f.start(1), { code: 'CONTROL_CONNECTION_LOST', message: 'CONTROL_CONNECTION_LOST' });
});
test('resident failed cleanup keeps admission closed and never leaks the underlying error', async t => {
  const f = fixture(t, { closeError: true }), started = await f.start(1);
  await assert.rejects(f.service.close(started.sessionId), { code: 'CONTROL_CLEANUP_FAILED', message: 'CONTROL_CLEANUP_FAILED' });
  assert.equal(f.service.isBusy(), true);
  await assert.rejects(f.start(1), { code: 'SERVICE_BUSY' });
});
test('pause lease expiration also closes while resume waits on a fresh inventory lookup', async t => {
  const f = fixture(t), started = await f.start(1); await f.service.pause(started.sessionId);
  let release; f.setResolveGate(new Promise(resolve => { release = resolve; }));
  const resumed = f.service.resume(started.sessionId), rejection = assert.rejects(resumed, { code: 'CONTROL_INACTIVE' });
  try { await tick(t); await tick(t, 30000); assert.equal(f.p2p.connected, false); }
  finally { release(); }
  await rejection; assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1]);
});

test('expired pause cannot send resume after inventory returns while dedicated close is still pending', async t => {
  let releaseClose, releaseInventory;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  const f = fixture(t, { closeGate }), started = await f.start(1);
  await f.service.pause(started.sessionId);
  f.setResolveGate(new Promise(resolve => { releaseInventory = resolve; }));
  let settled = false;
  const rejected = assert.rejects(f.service.resume(started.sessionId), { code: 'CONTROL_INACTIVE' })
    .then(() => { settled = true; });
  try {
    await tick(t); await tick(t, 30000);
    assert.deepEqual(f.closes, ['p2p']);
    assert.equal(f.p2p.connected, true); // Transport close has started but not completed.
    assert.equal(f.service.get(started.sessionId).error.code, 'CONTROL_INACTIVE');
    releaseInventory(); await tick(t);
    assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1]);
    assert.equal(settled, false); // The failed request must still await cleanup.
    assert.equal(f.service.isBusy(), true);
  } finally { releaseInventory(); releaseClose(); await rejected; }
  assert.equal(f.p2p.connected, false);
  assert.deepEqual(f.closes, ['p2p', 'service']);
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), [0, 1]);
});
