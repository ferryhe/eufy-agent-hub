const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { LiveSessions } = require('./session.cjs');
const { JobService } = require('../../jobs/service.cjs');
const { transport } = require('./fixtures/transport.cjs');
const scope = { serial: 'camera', model: 'T8600', firmware: { main: '1', secondary: '1' },
  homeBase: { serial: 'base', model: 'T8030', firmware: { main: '1', secondary: '1' } }, channel: 1 };
const device = { serial: 'camera', availability: 'unknown', verificationScope: scope, capabilities: { liveVideo: { status: 'protocol_hint', evidence: [] } } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime() {
  const r = new EventEmitter(); r.output = new PassThrough(); r.closed = false;
  r.close = async () => { r.closed = true; r.output.destroy(); };
  queueMicrotask(() => { r.output.write(Buffer.from('offline media fixture')); r.emit('ready'); });
  return r;
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-session-'));
  const jobs = new JobService({ outputRoot: root, worker: options.worker || (async () => ({})) });
  const connection = transport(options.transport);
  const session = { authenticated: true, state: { phase: 'connected' }, api: { isConnected: () => true } };
  let creates = 0, r;
  const live = new LiveSessions({ session, jobs, resolveDevice: async () => structuredClone(options.device || device),
    createConnection: () => { creates++; return connection; }, createRuntime: () => r = (options.runtime || runtime)(),
    startupMs: 70, attachMs: 150, idleMs: 200, authPollMs: 10, commandMs: 20, ...options.service });
  t.after(async () => { await live.shutdown(); await jobs.whenIdle(); fs.rmSync(root, { recursive: true, force: true }); });
  return { live, jobs, connection, session, creates: () => creates, runtime: () => r };
}
test('repeated start/stop preserves scope and identity without duplicate connection; lease blocks history until cleanup', async t => {
  let release; const closeGate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { transport: { closeGate } });
  const [a, b] = await Promise.all([f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'same' }), f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'same' })]);
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.creates(), 1); assert.deepEqual(a.verificationScope, scope);
  assert.equal(a.state, 'streaming'); assert.equal(a.capabilityStatus, 'protocol_hint');
  await assert.rejects(f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'other' }), { code: 'SERVICE_BUSY' });
  await assert.rejects(f.live.start({ allowUnverified: true, serial: 'different', requestId: 'same' }), { code: 'LIVE_REQUEST_CONFLICT' });
  const job = f.jobs.submit({ requestId: 'history', homeBaseId: 'base' }); await tick(); assert.equal(f.jobs.get(job.jobId).state, 'queued');
  const stopping = f.live.stop(a.sessionId); await tick(); assert.equal(f.jobs.get(job.jobId).state, 'queued');
  release(); const stopped = await stopping; assert.equal(stopped.state, 'stopped'); assert.equal(stopped.cleanupComplete, true);
  assert.equal((await f.live.stop(a.sessionId)).sessionId, a.sessionId); assert.equal(f.runtime().closed, true);
  await f.jobs.whenIdle(); assert.equal(f.jobs.get(job.jobId).state, 'failed');
});
for (const [name, options, code] of [
  ['offline', { device: { ...device, availability: 'offline' } }, 'DEVICE_OFFLINE'],
  ['unsupported', { device: { ...device, capabilities: { liveVideo: { status: 'unsupported' } } } }, 'LIVE_UNSUPPORTED'],
  ['unknown device', { service: { resolveDevice: async () => null } }, 'DEVICE_NOT_FOUND'],
  ['rejection', { transport: { reject: true } }, 'LIVE_COMMAND_REJECTED'],
  ['media timeout', { transport: { media: false } }, 'LIVE_MEDIA_TIMEOUT'],
  ['runtime failure', { runtime: () => { const r = runtime(); queueMicrotask(() => r.emit('failure', Object.assign(new Error(), { code: 'LIVE_RUNTIME_ERROR' }))); return r; } }, 'LIVE_RUNTIME_ERROR'],
]) test(`${name} has a stable outcome and frees owned resources`, async t => {
  const f = fixture(t, options);
  await assert.rejects(f.live.start({ allowUnverified: true, serial: 'camera', requestId: name }), { code });
  assert.equal(f.live.isBusy(), false);
  if (f.creates()) assert.equal(f.connection.counts().closed, 1);
});
for (const cause of ['disconnect', 'authentication', 'shutdown', 'client', 'attach-timeout', 'idle-timeout', 'decoder']) test(`${cause} closes media and connection`, async t => {
  const f = fixture(t, { service: { attachMs: cause === 'attach-timeout' ? 20 : 500, idleMs: cause === 'idle-timeout' ? 20 : 500 } });
  const started = await f.live.start({ allowUnverified: true, serial: 'camera', requestId: cause });
  if (cause === 'disconnect') f.connection.p2p.emit('close');
  if (cause === 'authentication') f.session.authenticated = false;
  if (cause === 'shutdown') await f.live.shutdown();
  if (cause === 'client') { const res = new PassThrough(); res.writeHead = () => {}; f.live.attach(started.sessionId, res); res.destroy(); }
  if (cause === 'decoder') f.runtime().emit('failure', Object.assign(new Error(), { code: 'LIVE_DECODER_ERROR' }));
  for (let i = 0; i < 80 && f.live.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.live.isBusy(), false); assert.equal(f.runtime().closed, true); assert.equal(f.connection.counts().closed, 1);
  assert.equal(f.live.get(started.sessionId).cleanupComplete, true);
});
test('existing queued history rejects live without opening a connection', async t => {
  const f = fixture(t); f.jobs.submit({ requestId: 'history', homeBaseId: 'base' });
  await assert.rejects(f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'live' }), { code: 'SERVICE_BUSY' });
  assert.equal(f.creates(), 0);
});
module.exports = { scope, device, runtime };

test('protocol hints require an explicit unverified-path opt-in before any connection', async t => {
  const f = fixture(t);
  await assert.rejects(f.live.start({ serial: 'camera', requestId: 'normal' }), { code: 'LIVE_NOT_VERIFIED' });
  assert.equal(f.creates(), 0);
});
for (const [cause, expected] of [['rejected', 'LIVE_COMMAND_REJECTED'], ['timeout', 'LIVE_COMMAND_TIMEOUT']]) test(`stop ${cause} keeps a structured failure after resource cleanup`, async t => {
  const f = fixture(t); const started = await f.live.start({ allowUnverified: true, serial: 'camera', requestId: cause });
  f.connection.station.stopLivestream = () => {
    if (cause === 'rejected') f.connection.p2p.emit('command', { channel: 1, command_type: 1004, return_code: -1 });
  };
  const stopped = await f.live.stop(started.sessionId);
  assert.equal(stopped.error?.code, expected); assert.equal(stopped.state, 'failed');
  assert.equal(stopped.stopConfirmed, false); assert.equal(stopped.cleanupComplete, true);
});
test('shutdown during delayed connect retains ownership until late setup has closed', async t => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { transport: { connectGate: gate }, service: { startupMs: 1000 } });
  const opening = f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'pending' });
  const rejected = assert.rejects(opening, { code: 'LIVE_INACTIVE' }); await tick();
  let done = false; const stopping = f.live.shutdown().then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.throws(() => f.jobs.acquireMedia('base'), { code: 'SERVICE_BUSY' });
  finish(); await stopping; await rejected; assert.equal(f.connection.counts().closed, 1);
});

test('wrong-channel media is destroyed and command rejection cannot fail another camera channel', async t => {
  const f = fixture(t, { transport: { media: false }, service: { startupMs: 1000 } });
  const starting = f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'channels' }); await tick();
  const wrongVideo = new PassThrough(), wrongAudio = new PassThrough();
  f.connection.p2p.emit('command', { channel: 2, command_type: 1003, return_code: -1 });
  f.connection.p2p.emit('livestream started', 2, { videoCodec: 0 }, wrongVideo, wrongAudio);
  assert.equal(wrongVideo.destroyed, true); assert.equal(wrongAudio.destroyed, true);
  f.connection.p2p.emit('livestream started', 1, { videoCodec: 0, audioCodec: 0 }, f.connection.video, f.connection.audio);
  assert.equal((await starting).state, 'streaming');
});

test('completed media drain does not time out while protocol cleanup still owns the lease', { timeout: 2000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { transport: { closeGate: gate }, service: { drainMs: 25 }, runtime: () => {
    const r = runtime(); r.close = async () => { r.closed = true; r.output.end(); }; return r;
  } });
  const started = await f.live.start({ allowUnverified: true, serial: 'camera', requestId: 'drained' });
  const response = new (require('node:stream').Writable)({ write(_chunk, _encoding, done) { done(); } }); response.writeHead = () => {};
  f.live.attach(started.sessionId, response); const stopping = f.live.stop(started.sessionId);
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(response.writableFinished, true); assert.equal(f.live.get(started.sessionId).error, null);
    assert.throws(() => f.jobs.acquireMedia('base'), { code: 'SERVICE_BUSY' });
  } finally { release(); await stopping; }
});
