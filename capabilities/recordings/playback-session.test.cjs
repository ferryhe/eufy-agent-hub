const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
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
function replyLast(f) {
  const sent = f.sent.at(-1);
  f.p2p.emit('command', { command_type: 6001, channel: sent.channel, customData: sent.customData, return_code: 0 });
}
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const p2p = new EventEmitter(), sent = [], closes = []; let activeBegin = 100;
  Object.assign(p2p, { connected: true, deviceSNs: {}, sendQueue: [], messageStates: new Map(),
    streamTimeouts: { streamDataWait: 5000 }, currentMessageState: { 1: { p2pStreaming: false, p2pStreamNotStarted: true, invalidStream: false, queuedData: new Map() } } });
  p2p.isConnected = () => p2p.connected;
  p2p.isCurrentlyStreaming = () => p2p.currentMessageState[1].p2pStreaming;
  for (const method of ['startContinuousPlayback', 'stopContinuousPlayback', 'waitForStreamData', 'endStream', 'emitStreamStopEvent', 'setStreamTimeouts']) p2p[method] = P2PClientProtocol.prototype[method];
  p2p.initializeMessageBuilder = p2p.initializeMessageState = p2p.initializeStream = p2p.closeEnergySavingDevice = () => {};
  const frame = (timestamp, channel = 1, data = Buffer.from('private-media'), keyFrame = true) => {
    p2p.waitForStreamData(1, true);
    p2p.emit('continuous playback frame', { kind: 'video', channel, timestamp, data, keyFrame });
    p2p.currentMessageState[1].p2pStreamNotStarted = false;
  };
  p2p.sendCommandWithStringPayload = (command, customData) => {
    const payload = JSON.parse(command.value); sent.push({ payload, customData, channel: command.channel });
    if (options.noReply === payload.data.cmd) return;
    queueMicrotask(() => {
      p2p.emit('command', { command_type: 6001, channel: 2, customData, return_code: 0 });
      p2p.emit('command', { command_type: 6001, channel: 1, customData: {}, return_code: 0 });
      p2p.emit('command', { command_type: 6001, channel: 1, customData, return_code: options.reject === payload.data.cmd ? 7 : 0 });
      if (payload.data.cmd === 0 && !options.noFrame) {
        const start = () => { p2p.emit('livestream started', 1, { videoCodec: 0 }, new PassThrough(), new PassThrough()); frame(activeBegin * 1000 + 1000); };
        options.firstFrameDelay ? setTimeout(start, options.firstFrameDelay) : start();
      }
      if (payload.data.cmd === 2) frame(activeBegin * 1000 + 2000);
    });
  };
  p2p.queryContinuousRecordings = (_serial, channel, begin, end) => { activeBegin = begin; p2p.emit('continuous recording ranges', channel,
    { begin_time: begin, end_time: end, videos: [{ start_time: begin, stop_time: end,
      ...(Object.hasOwn(options, 'filePath') ? { file_path: options.filePath } : {}) }] });
  };
  p2p.close = async () => { closes.push('p2p'); await options.closeGate; clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
    p2p.connected = false; p2p.continuousPlayback = undefined; p2p.currentMessageState[1].p2pStreaming = false; p2p.emit('close'); };
  const connection = { station: { p2pSession: p2p, getSerial: () => 'base', getModel: () => 'T8030' },
    camera: { getSerial: () => 'camera', getStationSerial: () => 'base', getModel: () => 'T8600', getChannel: () => 1 },
    userId: 'private-account', connect: async () => { if (options.connectError) throw new Error('private-connect-error'); await options.connectGate;
      p2p.connected = true; p2p.currentMessageState[1].p2pStreaming = false; p2p.currentMessageState[1].p2pStreamNotStarted = true; },
    close: async () => { closes.push('service'); if (options.closeError) throw new Error('private-cleanup-error'); } };
  const session = { api: {}, isAuthenticated: () => true };
  let device = verified(), created = 0, resolveGate;
  const decoderCalls = [];
  const createDecoder = options.createDecoder || (({ video, onFrame }) => {
    const call = { video, closed: false }; decoderCalls.push(call);
    video.once('data', () => queueMicrotask(() => onFrame(Buffer.from([255, 216, decoderCalls.length, 255, 217]))));
    return { close: async () => { call.closed = true; video.destroy(); } };
  });
  const service = new PlaybackSessions({ session, resolveDevice: async () => { await resolveGate; return device; }, createDecoder,
    residentEpoch: 'resident-fixture', attachMs: 1000, mediaIdleMs: options.mediaIdleMs || 5000,
    startupMs: options.startupMs, startupTotalMs: options.startupTotalMs, cleanupMs: options.cleanupMs,
    createConnection: () => { created++; return connection; } });
  t.after(async () => { await service.shutdown().catch(error => { if (!options.closeError && !options.cleanupError) throw error; }); });
  return { service, p2p, sent, closes, frame, session, setDevice: value => { device = value; }, setResolveGate: value => { resolveGate = value; }, created: () => created,
    decoderCalls, start: speed => service.start({ serial: 'camera', begin: 100, end: 160, speed }) };
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
test('media startup aborts a late connect and keeps admission when cleanup cannot be confirmed', async t => {
  let release; const connectGate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { connectGate, startupMs: 5, startupTotalMs: 5, cleanupMs: 5, cleanupError: true });
  const pending = f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'late-connect', residentEpoch: 'resident-fixture' });
  const rejected = assert.rejects(pending, { code: 'CONTROL_CLEANUP_FAILED' });
  await tick(t, 5); assert.equal(f.service.isBusy(), true); await tick(t, 5); await rejected;
  assert.equal(f.service.isBusy(), true); assert.equal(f.service.getRequest('late-connect', 'resident-fixture').state, 'failed');
  release(); await tick(t); assert.deepEqual(f.closes, ['service']);
});

test('media opt-in binds immutable request identity and only feeds in-window bytes from the first keyframe', async t => {
  const f = fixture(t, { noFrame: true });
  const pending = f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'media-one', residentEpoch: 'resident-fixture' });
  await tick(t);
  f.p2p.emit('livestream started', 1, { videoCodec: 0 }, new PassThrough(), new PassThrough());
  f.frame(99000, 1, Buffer.from('before'), true);
  f.frame(101000, 2, Buffer.from('wrong-channel'), true);
  f.frame(101000, 1, Buffer.from('delta'), false);
  f.frame(102000, 1, Buffer.from('keyframe'), true);
  const started = await pending;
  assert.equal(started.requestId, 'media-one'); assert.equal(started.residentEpoch, 'resident-fixture');
  assert.equal(started.media.timestampSemantics, 'source-received-position');
  assert.equal(started.media.audio, false); assert.equal(started.media.mediaEpoch, 1);
  assert.equal(f.decoderCalls.length, 1);
  assert.equal(f.decoderCalls[0].video.readableLength, 0, 'the decoder consumed only the accepted keyframe bytes');
  assert.equal(f.service.getRequest('media-one', 'resident-fixture').sessionId, started.sessionId);
  await assert.rejects(f.service.start({ serial: 'camera', begin: 101, end: 160, speed: 1, media: true,
    requestId: 'media-one', residentEpoch: 'resident-fixture' }), { code: 'PLAYBACK_REQUEST_CONFLICT' });
  await assert.rejects(f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'expired', residentEpoch: 'old-resident' }), { code: 'PLAYBACK_REQUEST_EXPIRED' });
});

test('media pause closes the decoder, resume creates a fresh epoch, and seek closes before opening', async t => {
  const f = fixture(t, { mediaIdleMs: 10000 }), opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'media-two', residentEpoch: 'resident-fixture' });
  await f.service.pause(opened.sessionId);
  assert.equal(f.decoderCalls[0].closed, true); assert.equal(f.service.get(opened.sessionId).state, 'paused');
  const resumedPromise = f.service.resume(opened.sessionId); await tick(t); f.frame(103000, 1, Buffer.from('resume-key'), true);
  const resumed = await resumedPromise;
  assert.equal(resumed.media.mediaEpoch, 3); assert.equal(f.decoderCalls.length, 2);
  const sought = await f.service.seek(opened.sessionId, { requestId: 'seek-one', residentEpoch: 'resident-fixture',
    begin: 120, end: 150 });
  assert.notEqual(sought.sessionId, opened.sessionId); assert.equal(sought.requestId, 'seek-one');
  assert.equal(f.service.get(opened.sessionId).cleanupComplete, true);
  assert.equal(f.created(), 2); assert.equal(f.service.getRequest('seek-one', 'resident-fixture').sessionId, sought.sessionId);
});

for (const mode of ['throw', 'reject']) test(`pause decoder close ${mode} keeps cleanup ownership and fixed admission`, async t => {
  let closeCalls = 0, decoder;
  const f = fixture(t, { cleanupError: true, createDecoder: ({ video, onFrame }) => {
    video.once('data', () => onFrame(Buffer.from([255, 216, 1, 255, 217])));
    return decoder = { close() { closeCalls++; const error = Object.assign(new Error('private decoder cleanup'), { code: 'LIVE_CLEANUP_FAILED' });
      if (mode === 'throw') throw error; return Promise.reject(error); } };
  } });
  const opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: `pause-cleanup-${mode}`, residentEpoch: 'resident-fixture' });
  await assert.rejects(f.service.pause(opened.sessionId), { code: 'CONTROL_CLEANUP_FAILED' });
  const failed = f.service.get(opened.sessionId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'CONTROL_CLEANUP_FAILED');
  assert.equal(failed.cleanupComplete, false); assert.equal(failed.resources.decoderClosed, false); assert.equal(f.service.isBusy(), true);
  assert.equal(f.service.current.decoder, decoder); assert.equal(closeCalls, 1); assert.deepEqual(f.closes, ['p2p', 'service']);
  await assert.rejects(f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: `blocked-${mode}`, residentEpoch: 'resident-fixture' }), { code: 'SERVICE_BUSY' });
  await assert.rejects(f.service.close(opened.sessionId), { code: 'CONTROL_CLEANUP_FAILED' });
  await assert.rejects(f.service.shutdown(), { code: 'CONTROL_CLEANUP_FAILED' });
  assert.equal(f.service.get(opened.sessionId).state, 'failed'); assert.equal(closeCalls, 1); assert.equal(f.created(), 1);
});

test('pause and concurrent cleanup share one rejected decoder close', async t => {
  let closeCalls = 0, rejectClose;
  const f = fixture(t, { cleanupError: true, createDecoder: ({ video, onFrame }) => {
    video.once('data', () => onFrame(Buffer.from([255, 216, 1, 255, 217])));
    return { close() { closeCalls++; return new Promise((_resolve, reject) => { rejectClose = reject; }); } };
  } });
  const opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'pause-concurrent-cleanup', residentEpoch: 'resident-fixture' });
  const pending = f.service.pause(opened.sessionId), rejected = assert.rejects(pending, { code: 'CONTROL_CLEANUP_FAILED' });
  await tick(t); assert.equal(closeCalls, 1); f.p2p.emit('close'); await tick(t); assert.equal(closeCalls, 1);
  rejectClose(new Error('private concurrent decoder cleanup')); await rejected;
  assert.equal(f.service.get(opened.sessionId).cleanupComplete, false); assert.equal(f.service.isBusy(), true);
  assert.equal(closeCalls, 1); assert.deepEqual(f.closes, ['p2p', 'service']);
});

test('pending pause decoder close times out once and blocks start, seek, close and shutdown', async t => {
  let closeCalls = 0;
  const f = fixture(t, { cleanupError: true, cleanupMs: 5, createDecoder: ({ video, onFrame }) => {
    video.once('data', () => onFrame(Buffer.from([255, 216, 1, 255, 217])));
    return { close() { closeCalls++; return new Promise(() => {}); } };
  } });
  const opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'pause-pending-cleanup', residentEpoch: 'resident-fixture' });
  const pending = f.service.pause(opened.sessionId), rejected = assert.rejects(pending, { code: 'CONTROL_CLEANUP_FAILED' });
  await tick(t); assert.equal(closeCalls, 1); await tick(t, 5); await rejected;
  const failed = f.service.get(opened.sessionId); assert.equal(failed.state, 'failed'); assert.equal(failed.cleanupComplete, false);
  assert.equal(failed.resources.decoderClosed, false); assert.equal(f.service.isBusy(), true); assert.equal(closeCalls, 1);
  await assert.rejects(f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'blocked-pending-cleanup', residentEpoch: 'resident-fixture' }), { code: 'SERVICE_BUSY' });
  await assert.rejects(f.service.seek(opened.sessionId, { requestId: 'blocked-seek-cleanup', residentEpoch: 'resident-fixture', begin: 110, end: 120 }), { code: 'CONTROL_CLEANUP_FAILED' });
  await assert.rejects(f.service.close(opened.sessionId), { code: 'CONTROL_CLEANUP_FAILED' });
  await assert.rejects(f.service.shutdown(), { code: 'CONTROL_CLEANUP_FAILED' });
  assert.equal(closeCalls, 1); assert.equal(f.created(), 1);
});

for (const operation of ['pause', 'resume']) test(`media ${operation} pending at EOF returns closed without waiting for a lease or decoder`, async t => {
  const f = fixture(t, { noReply: operation === 'pause' ? 1 : 2 }), opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: `eof-${operation}`, residentEpoch: 'resident-fixture' });
  if (operation === 'resume') await f.service.pause(opened.sessionId);
  const before = Date.now(), pending = f.service[operation](opened.sessionId); await tick(t);
  f.frame(160000, 1, Buffer.from('window-end'), false); replyLast(f);
  const terminal = await pending;
  assert.equal(terminal.state, 'closed'); assert.equal(terminal.cleanupComplete, true); assert.equal(terminal.stopConfirmed, true);
  assert.equal(Date.now(), before); assert.equal(f.service.isBusy(), false); assert.equal(f.p2p.connected, false);
  assert.deepEqual(f.sent.map(row => row.payload.data.cmd), operation === 'pause' ? [0, 1, 3] : [0, 1, 2, 3]);
});

test('control-only callers retain a legacy speed and never construct or require a decoder consumer', async t => {
  const f = fixture(t);
  const opened = await f.start(16); await f.service.close(opened.sessionId);
  assert.equal(opened.media, undefined);
  assert.equal(f.decoderCalls.length, 0);
});

test('media request replay creates one owner and no-consumer cleanup is bounded without changing old callers', async t => {
  const f = fixture(t), input = { serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'lost-create', residentEpoch: 'resident-fixture' };
  const [first, repeated] = await Promise.all([f.service.start(input), f.service.start(input)]);
  assert.equal(first.sessionId, repeated.sessionId); assert.equal(f.created(), 1);
  await tick(t, 1000); await tick(t);
  assert.equal(f.service.get(first.sessionId).error.code, 'PLAYBACK_MEDIA_TIMEOUT');
  assert.equal(f.service.getRequest('lost-create', 'resident-fixture').state, 'succeeded');
});

test('media startup rejects raw video without an in-window keyframe and decoder errors immediately', async t => {
  const f = fixture(t, { noFrame: true });
  const missing = f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'no-keyframe', residentEpoch: 'resident-fixture' });
  await tick(t); f.p2p.emit('livestream started', 1, { videoCodec: 0 }, new PassThrough(), new PassThrough());
  f.frame(101000, 1, Buffer.from('delta'), false); const rejected = assert.rejects(missing, { code: 'PLAYBACK_MEDIA_TIMEOUT' });
  await tick(t, 15000); await rejected; assert.equal(f.decoderCalls.length, 0);
});

test('media slow consumer closes the owning session', async t => {
  const f = fixture(t, { mediaIdleMs: 10000 }), opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'slow-client', residentEpoch: 'resident-fixture' });
  const response = new EventEmitter(); Object.assign(response, { writableLength: 0, writeHead() {}, write() { return false; }, end() { this.ended = true; } });
  await f.service.attach(opened.sessionId, response); await tick(t, 5000); await tick(t);
  assert.equal(f.service.get(opened.sessionId).error.code, 'PLAYBACK_MEDIA_SLOW_CLIENT'); assert.equal(response.ended, true);
});

test('media disconnect closes the owner without reconnect or replay', async t => {
  const f = fixture(t), opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'disconnect-client', residentEpoch: 'resident-fixture' });
  const response = new EventEmitter(); Object.assign(response, { writableLength: 0, writeHead() {},
    write(_part, callback) { queueMicrotask(callback); return true; }, end() { this.ended = true; } });
  await f.service.attach(opened.sessionId, response); response.emit('close'); await tick(t);
  assert.equal(f.service.get(opened.sessionId).cleanupComplete, true); assert.equal(f.created(), 1);
});

test('media auth polling and decoder cleanup failure keep fixed errors and admission ownership', async t => {
  const f = fixture(t, { cleanupError: true, createDecoder: ({ video, onFrame }) => { video.once('data', () => onFrame(Buffer.from([255,216,1,255,217])));
    return { close: async () => { throw new Error('private decoder failure'); } }; } });
  const opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'cleanup-failure', residentEpoch: 'resident-fixture' });
  f.session.api = {}; await tick(t, 1000); await tick(t);
  assert.equal(f.service.get(opened.sessionId).error.code, 'CONTROL_CLEANUP_FAILED'); assert.equal(f.service.isBusy(), true);
  assert.equal(f.service.get(opened.sessionId).resources.decoderClosed, false);
});

test('seek keeps admission across old cleanup, rejects an unaccepted rapid target, and stale close cannot affect the replacement', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { closeGate: gate }), opened = await f.service.start({ serial: 'camera', begin: 100, end: 160, speed: 1, media: true,
    requestId: 'seek-origin', residentEpoch: 'resident-fixture' });
  const replacing = f.service.seek(opened.sessionId, { requestId: 'seek-a', residentEpoch: 'resident-fixture', begin: 120, end: 150 });
  await tick(t); assert.equal(f.service.isBusy(), true); assert.equal(f.created(), 1);
  await assert.rejects(f.service.seek(opened.sessionId, { requestId: 'seek-b', residentEpoch: 'resident-fixture', begin: 125, end: 150 }), { code: 'SERVICE_BUSY' });
  assert.throws(() => f.service.getRequest('seek-b', 'resident-fixture'), { code: 'PLAYBACK_REQUEST_NOT_FOUND' });
  release(); const replacement = await replacing; assert.equal(f.created(), 2);
  const staleClose = await f.service.close(opened.sessionId); assert.equal(staleClose.cleanupComplete, true);
  assert.equal(f.service.get(replacement.sessionId).state, 'playing');
});
