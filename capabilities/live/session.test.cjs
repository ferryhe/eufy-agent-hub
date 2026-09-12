const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LiveSessions } = require('./session.cjs');
const { CommandName } = require('../../adapters/eufy');

function fixture(t, options = {}) {
  const scope = { serial: 'camera', model: 'T8600', firmware: { main: 'c1', secondary: 'c2' },
    homeBase: { serial: 'base', model: 'T8030', firmware: { main: 'b1', secondary: 'b2' } }, channel: 1 };
  const device = { serial: 'camera', homeBaseId: 'base', channel: 1, verificationScope: scope,
    availability: 'unknown', capabilities: { liveVideo: { status: 'protocol_hint', evidence: [], reason: 'fixture' } } };
  const session = { api: {}, isAuthenticated: () => true };
  const p2p = new EventEmitter(), station = new EventEmitter(), calls = [], streams = [];
  let decoder, connected = false;
  p2p.isConnected = () => connected; p2p.isCurrentlyStreaming = () => false;
  Object.assign(station, { p2pSession: p2p, getSerial: () => 'base', getModel: () => 'T8030',
    getSoftwareVersion: () => 'b1', getHardwareVersion: () => 'hardware', isLiveStreaming: () => connected,
    startLivestream() {
      calls.push('start');
      queueMicrotask(() => {
        station.emit('command result', station, { channel: 2, customData: { command: { name: CommandName.DeviceStartLivestream } }, return_code: 9 });
        if (!options.noAck) station.emit('command result', station, { channel: 1,
          customData: { command: { name: CommandName.DeviceStartLivestream } }, return_code: options.reject ? 7 : 0 });
        if (!options.noMedia && !options.reject) {
          const video = new PassThrough(), audio = new PassThrough(); streams.push(video, audio);
          station.emit('livestream start', station, 1, { videoCodec: 0, videoFPS: 15 }, video, audio);
        }
      });
    },
    stopLivestream() { calls.push('stop'); queueMicrotask(() => {
      station.emit('livestream stop', station, 1);
      if (!options.noStopAck) station.emit('command result', station, { channel: 1,
        customData: { command: { name: CommandName.DeviceStopLivestream } }, return_code: options.stopReject ? 7 : 0 });
    }); },
  });
  const connection = { station, camera: { getSerial: () => 'camera', getStationSerial: () => 'base',
    getModel: () => 'T8600', getChannel: () => 1 },
    async connect() { calls.push('connect'); await options.connectGate; if (options.connectError) throw new Error('private-connection'); connected = true; },
    async close() { calls.push('close'); await options.closeGate; if (options.closeError) throw new Error('private-close'); connected = false; },
  };
  const live = new LiveSessions({ session, resolveDevice: async serial => { await options.inventoryGate; return serial === 'camera' ? device : null; },
    createConnection: () => connection, startupMs: 50, commandMs: 30, attachMs: 1000, authPollMs: 20,
    createDecoder: input => { calls.push('decode'); decoder = input; if (!options.noFrame) queueMicrotask(() => input.onFrame(Buffer.from([255,216,1,255,217])));
      return { async close() { calls.push('decoder-close'); await options.decoderGate; } }; },
  });
  t.after(() => live.shutdown().catch(error => { if (!options.closeError) throw error; }));
  return { live, session, device, p2p, station, calls, streams, decoder: () => decoder,
    start: (requestId = 'request') => live.start({ serial: 'camera', requestId, maxDurationMs: 1000 }) };
}

test('start requires correlated ack and decoded media; request identity, owner and stop remain stable', async t => {
  const f = fixture(t), started = await f.start();
  assert.equal(started.state, 'streaming'); assert.equal(started.media.decodedFrames, 1);
  assert.equal(started.capability.status, 'protocol_hint'); assert.equal(started.verificationScope.channel, 1);
  assert.deepEqual(await f.start(), started);
  await assert.rejects(f.start('another'), { code: 'SERVICE_BUSY' });
  await assert.rejects(f.live.start({ requestId: 'request', serial: 'other' }), { code: 'LIVE_REQUEST_CONFLICT' });
  const [a, b] = await Promise.all([f.live.stop(started.sessionId), f.live.stop(started.sessionId)]);
  assert.equal(a.state, 'stopped'); assert.deepEqual(a, b); assert.equal(a.stopConfirmed, true);
  assert.equal(a.cleanupComplete, true); assert.equal(f.live.isBusy(), false);
  assert.deepEqual(f.calls, ['connect', 'start', 'decode', 'stop', 'decoder-close', 'close']);
  assert.ok(f.streams.every(stream => stream.destroyed));
  assert.equal(f.station.listenerCount('livestream start'), 0);
  assert.equal((await f.start()).sessionId, started.sessionId);
});

for (const [options, code] of [[{ reject: true }, 'LIVE_COMMAND_REJECTED'], [{ noAck: true }, 'LIVE_COMMAND_TIMEOUT'],
  [{ noMedia: true }, 'LIVE_MEDIA_TIMEOUT'], [{ noFrame: true }, 'LIVE_MEDIA_TIMEOUT'], [{ connectError: true }, 'LIVE_CONNECTION_FAILED']]) {
  test(`startup ${code} cleans connection and any decoder`, async t => {
    const f = fixture(t, options); await assert.rejects(f.start(), { code });
    assert.equal(f.live.isBusy(), false); assert.ok(f.calls.includes('close'));
    assert.equal(f.calls.includes('stop'), Boolean(options.noMedia || options.noFrame), 'Only a confirmed start owns a stop');
    assert.equal(f.live.get(f.live.current.id).stopConfirmed, Boolean(options.noMedia || options.noFrame));
    assert.equal(f.station.listenerCount('command result'), 0);
  });
}

test('unknown, unsupported, offline and unknown-capability devices fail before connecting', async t => {
  const f = fixture(t);
  await assert.rejects(f.live.start({ serial: 'missing', requestId: 'missing' }), { code: 'DEVICE_NOT_FOUND' });
  for (const [status, code] of [['unsupported', 'LIVE_UNSUPPORTED'], ['unknown', 'LIVE_CAPABILITY_UNKNOWN']]) {
    f.device.capabilities.liveVideo.status = status;
    await assert.rejects(f.start(status), { code });
  }
  f.device.capabilities.liveVideo.status = 'protocol_hint'; f.device.availability = 'offline';
  await assert.rejects(f.start('offline'), { code: 'LIVE_DEVICE_OFFLINE' });
  assert.deepEqual(f.calls, []);
});

for (const [capabilityStatus, code, status] of [['unsupported', 'LIVE_UNSUPPORTED', 422], ['unknown', 'LIVE_CAPABILITY_UNKNOWN', 409]]) {
  test(`fresh ${capabilityStatus} capability keeps its stable error and awaits connection cleanup`, async t => {
    let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
    const f = fixture(t, { closeGate: gate });
    const fresh = structuredClone(f.device); fresh.capabilities.liveVideo.status = capabilityStatus;
    let lookups = 0;
    f.live.resolveDevice = async () => ++lookups === 1 ? f.device : fresh;
    let settled = false;
    const rejected = assert.rejects(f.start(), { code, status }).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lookups, 2);
    assert.deepEqual(f.calls, ['connect', 'close'], 'Pre-command rejection must not start media');
    assert.equal(settled, false, 'The observable error must wait for owned cleanup');
    assert.equal(f.live.isBusy(), true);
    release(); await rejected;
    assert.equal(f.live.isBusy(), false);
    assert.equal(f.live.get(f.live.current.id).cleanupComplete, true);
  });
}

test('a rejecting Live resolver still safely normalizes unrecognized adapter errors', async t => {
  const f = fixture(t);
  f.live.resolveDevice = async () => { throw Object.assign(new Error('private-adapter-detail'), { code: 'UNRECOGNIZED_ADAPTER_ERROR', status: 418 }); };
  await assert.rejects(f.start(), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'LIVE_CONNECTION_FAILED');
    assert.equal(error.message, 'LIVE_CONNECTION_FAILED');
    return true;
  });
  assert.deepEqual(f.calls, []);
});

test('media disconnect owns cleanup; a duplicate consumer returns stable conflict', async t => {
  const f = fixture(t), started = await f.start(), res = new PassThrough();
  res.writeHead = () => {}; res.resume();
  f.live.attach(started.sessionId, res);
  assert.throws(() => f.live.attach(started.sessionId, new PassThrough()), { code: 'LIVE_CLIENT_CONFLICT' });
  res.destroy(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.live.get(started.sessionId).state, 'stopped'); assert.equal(f.live.isBusy(), false);
});

for (const [scenario, code, status] of [['first-frame timeout', 'LIVE_MEDIA_TIMEOUT', 504],
  ['decoder failure', 'LIVE_DECODER_FAILED', 502], ['auth expiry', 'UNAUTHENTICATED', 401]]) {
  test(`${scenario} after start ack awaits matching stop and every cleanup stage`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    let releaseDecoder, releaseConnection;
    const decoderGate = new Promise(resolve => { releaseDecoder = resolve; });
    const closeGate = new Promise(resolve => { releaseConnection = resolve; });
    t.after(() => { releaseDecoder(); releaseConnection(); });
    const f = fixture(t, { noFrame: scenario !== 'auth expiry', noStopAck: true, decoderGate, closeGate });
    if (scenario === 'decoder failure') {
      const createDecoder = f.live.createDecoder;
      f.live.createDecoder = input => {
        const decoder = createDecoder(input);
        // Fail in the same turn as the matching start ack, before _start resumes.
        input.onError(Object.assign(new Error('private-decoder-log'), { code }));
        return decoder;
      };
    }
    let opening;
    if (scenario === 'auth expiry') {
      await f.start(); f.session.isAuthenticated = () => false; t.mock.timers.tick(20);
    } else {
      opening = assert.rejects(f.start(), { code, status });
      await new Promise(resolve => setImmediate(resolve));
      if (scenario === 'first-frame timeout') t.mock.timers.tick(50);
    }
    await new Promise(resolve => setImmediate(resolve));
    const id = f.live.current.id;
    const assertOwned = () => {
      const result = f.live.get(id);
      assert.equal(result.error.code, code);
      assert.equal(result.cleanupComplete, false);
      assert.equal(f.live.isBusy(), true);
    };
    assertOwned();
    assert.deepEqual(f.calls, ['connect', 'start', 'decode', 'stop']);
    assert.equal(f.live.get(id).stopConfirmed, false);
    const acknowledge = (name, channel) => f.station.emit('command result', f.station,
      { channel, customData: { command: { name } }, return_code: 0 });
    acknowledge(CommandName.DeviceStartLivestream, 1);
    acknowledge(CommandName.DeviceStopLivestream, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.at(-1), 'stop', 'Unrelated acknowledgements must not release cleanup');
    acknowledge(CommandName.DeviceStopLivestream, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.live.get(id).stopConfirmed, true); assertOwned();
    assert.equal(f.calls.at(-1), 'decoder-close');
    assert.ok(f.streams.every(stream => stream.destroyed));
    releaseDecoder(); await new Promise(resolve => setImmediate(resolve));
    assertOwned();
    assert.deepEqual(f.calls, ['connect', 'start', 'decode', 'stop', 'decoder-close', 'close']);
    releaseConnection(); await f.live.closeActive(); await opening;
    const result = f.live.get(id);
    assert.equal(result.error.code, code); assert.equal(result.state, 'failed');
    assert.equal(result.stopConfirmed, true); assert.equal(result.cleanupComplete, true);
    assert.equal(f.live.isBusy(), false);
    assert.ok(Object.values(result.resources).every(Boolean));
    assert.deepEqual(result.operations.map(({ operation, returnCode }) => ({ operation, returnCode })),
      [{ operation: 'start', returnCode: 0 }, { operation: 'stop', returnCode: 0 }]);
    assert.equal(JSON.stringify(result).includes('private'), false);
  });
}

for (const options of [{ noStopAck: true }, { stopReject: true }]) {
  test(`stop ${options.noStopAck ? 'timeout' : 'rejection'} preserves the primary media error`, async t => {
    const f = fixture(t, { ...options, noFrame: true });
    await assert.rejects(f.start(), { code: 'LIVE_MEDIA_TIMEOUT', status: 504 });
    const result = f.live.get(f.live.current.id);
    assert.equal(result.error.code, 'LIVE_MEDIA_TIMEOUT'); assert.equal(result.stopConfirmed, false);
    assert.equal(result.cleanupComplete, true); assert.equal(f.live.isBusy(), false);
    assert.deepEqual(f.calls, ['connect', 'start', 'decode', 'stop', 'decoder-close', 'close']);
  });
}

test('connection close, stop timeout and cleanup failure have distinct outcomes', async t => {
  const f = fixture(t), started = await f.start();
  f.station.emit('close'); await f.live.closeActive();
  assert.equal(f.live.get(started.sessionId).error.code, 'LIVE_CONNECTION_LOST');
  assert.equal(f.live.get(started.sessionId).stopConfirmed, true);
  assert.deepEqual(f.calls, ['connect', 'start', 'decode', 'stop', 'decoder-close', 'close']);
  const timeout = fixture(t, { noStopAck: true }), opened = await timeout.start();
  const stopped = await timeout.live.stop(opened.sessionId);
  assert.equal(stopped.error.code, 'LIVE_COMMAND_TIMEOUT'); assert.equal(stopped.cleanupComplete, true);
  const broken = fixture(t, { closeError: true }), active = await broken.start();
  await assert.rejects(broken.live.stop(active.sessionId), { code: 'LIVE_CLEANUP_FAILED' });
  assert.equal(broken.live.isBusy(), true); assert.equal(broken.live.get(active.sessionId).cleanupComplete, false);
});

test('shutdown cancels startup and waits for a late connection before releasing admission', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const f = fixture(t, { connectGate: gate }), opening = f.start();
  const rejection = assert.rejects(opening, { code: 'LIVE_INACTIVE' });
  await new Promise(resolve => setImmediate(resolve));
  const closing = f.live.shutdown();
  assert.equal(f.live.isBusy(), true); release(); await closing; await rejection;
  assert.equal(f.live.isBusy(), false); assert.deepEqual(f.calls, ['connect', 'close']);
});

test('maximum duration and absent media consumer automatically stop their owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(t), opened = await f.start();
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.live.get(opened.sessionId).state, 'stopped'); assert.equal(f.live.isBusy(), false);
});

test('optional shared LAN cancellation stops before a late inventory can construct resources', async () => {
  const { LocalRecordings } = require('../recordings/events.cjs');
  let release; const inventory = new Promise(resolve => { release = resolve; });
  const connection = new LocalRecordings({ isAuthenticated: () => true, api: { getDevsListDecrypted: () => inventory } });
  const controller = new AbortController();
  const opening = connection.connect('camera', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
  await assert.rejects(opening, { code: 'CANCELLED' });
  release({ devices: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.station, undefined); assert.equal(connection.camera, undefined);
});

test('shared connect event wait removes its listener immediately on live cancellation', async () => {
  const { waitFor } = require('../recordings/events.cjs'), emitter = new EventEmitter(), controller = new AbortController();
  const pending = waitFor(emitter, 'connect', () => {}, () => true, 45000, controller.signal);
  controller.abort(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(emitter.listenerCount('connect'), 0);
});

test('late request cancellation cannot stop the next resident session', async t => {
  const f = fixture(t), first = await f.start('old'); await f.live.stop(first.sessionId);
  const next = await f.start('next'); await f.live.closeRequest('old');
  assert.equal(f.live.get(next.sessionId).state, 'streaming'); assert.equal(f.live.isBusy(), true);
});

test('stalled decoded video has a deterministic media timeout after startup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(t), opened = await f.live.start({ requestId: 'stalled', serial: 'camera', maxDurationMs: 10000 });
  const response = new PassThrough(); response.writeHead = () => {}; response.resume(); f.live.attach(opened.sessionId, response);
  t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.live.get(opened.sessionId).error.code, 'LIVE_MEDIA_TIMEOUT'); assert.equal(f.live.isBusy(), false);
});

module.exports = { fixture };
