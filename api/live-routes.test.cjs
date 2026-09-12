const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Ajv = require('ajv');
const { createServer } = require('../interface/server.cjs');
const { DeviceType } = require('../adapters/eufy');
const { transport } = require('../capabilities/live/fixtures/transport.cjs');
const { contract } = require('./v1-contract.cjs');
const OUTPUT = path.resolve(__dirname, '../output');
const window = { day: '2026-09-10', start: '12:00', end: '12:01', timezone: 'UTC' };
function fakeRuntime() {
  const r = new EventEmitter(); r.output = new PassThrough();
  r.close = async () => r.output.end();
  queueMicrotask(() => { r.output.write('offline-fixture'); r.emit('ready'); }); return r;
}
async function fixture(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true }); const directory = fs.mkdtempSync(path.join(OUTPUT, 'live-api-'));
  const connection = transport(options.transport);
  const raw = [
    { device_sn: 'base', device_model: 'T8030', device_type: DeviceType.HB3, device_name: 'Base', local_ip: '192.0.2.1' },
    { device_sn: 'camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247, device_name: 'Camera', parent_sn: 'base', device_channel: 1 },
    { device_sn: 'other', device_model: 'OTHER', device_name: 'Other', parent_sn: 'base', device_channel: 2 },
  ];
  const session = { authenticated: true, state: { phase: 'connected' }, api: { hasValidSession: () => true,
    getDevsListDecrypted: async () => ({ devices: raw }) }, close() { this.closed = true; }, logout() { this.authenticated = false; } };
  const server = createServer({ port: 0, session, recordings: { close() {}, listWindow: async () => [] }, outputRoot: directory,
    capabilityRecordsPath: path.join(directory, 'capabilities.json'),
    exports: { outputRoot: path.join(directory, 'jobs'), execute: async () => { throw new Error('Offline runtime'); } },
    live: { createConnection: () => connection, createRuntime: fakeRuntime, startupMs: 100, attachMs: 500, idleMs: 500, commandMs: 20, ...options.live },
  });
  await new Promise(resolve => server.start(resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await server.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const ajv = new Ajv({ strict: false }); ajv.addSchema(contract);
  const json = async (route, data, headers = {}) => {
    const res = await fetch(origin + route, { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers } });
    const value = await res.json();
    if (res.status < 400 && value.live) {
      const valid = ajv.getSchema(`${contract.$id}#/definitions/liveResponse`); assert.ok(valid(value), ajv.errorsText(valid.errors));
    }
    return { status: res.status, value };
  };
  const start = () => json('/api/v1/live-sessions', { serial: 'camera', requestId: 'live', allowUnverified: true });
  return { origin, json, start, session, server, connection, directory };
}
test('v1 live has strict opt-in, scoped idempotency, local guards and truthful capability projection', async t => {
  const f = await fixture(t);
  assert.equal((await f.json('/api/v1/live-sessions', { serial: 'camera', requestId: 'not-opted-in' })).value.error.code, 'LIVE_NOT_VERIFIED');
  assert.equal((await f.json('/api/v1/live-sessions', { serial: 'camera', requestId: 'bad', homeBaseId: 'forged' })).status, 400);
  assert.equal((await f.json('/api/v1/live-sessions', { serial: 'camera', requestId: 'foreign' }, { Origin: 'https://example.org' })).status, 403);
  const started = await f.start(); assert.equal(started.status, 201);
  assert.equal(started.value.live.capabilityStatus, 'protocol_hint');
  const again = await f.start(); assert.equal(again.value.live.sessionId, started.value.live.sessionId); assert.equal(f.connection.counts().opened, 1);
  const id = started.value.live.sessionId;
  assert.equal((await f.json(`/api/v1/live-sessions/${id}`)).value.live.state, 'streaming');
  const capabilities = (await f.json('/api/v1/devices/camera')).value.device.capabilities;
  assert.equal(capabilities.liveVideo.status, 'protocol_hint'); assert.notEqual(capabilities.talkback.status, 'verified'); assert.equal(capabilities.rtsp.status, 'unknown');
  assert.equal((await f.json(`/api/v1/live-sessions/${id}/stop`, {})).value.live.cleanupComplete, true);
  assert.equal((await f.json(`/api/v1/live-sessions/${id}/stop`, {})).value.live.state, 'stopped');
});
test('live excludes export/retry/range/legacy/playback and login/refresh mutations without preemption', async t => {
  const f = await fixture(t); const started = await f.start(); assert.equal(started.status, 201);
  for (const [route, data] of [
    ['/api/v1/exports', { requestId: 'history', serial: 'camera', ...window }],
    ['/api/v1/devices/camera/recording-ranges', window],
    ['/api/v1/playback-sessions', { serial: 'camera', ...window }],
    ['/recordings/query', { serial: 'camera', ...window }],
    ['/recordings/download', { recordId: 1 }],
    ['/api/v1/session/login', { email: 'a@example.test', password: 'fixture', country: 'CA' }],
    ['/api/v1/session/refresh', {}], ['/refresh', {}],
  ]) assert.equal((await f.json(route, data, { Origin: f.origin })).status, 409, route);
  assert.equal(f.connection.counts().stopped, 0);
});
for (const cause of ['disconnect', 'shutdown', 'logout', 'explicit-stop']) test(`HTTP media ${cause} cleans connection and completes server shutdown`, async t => {
  const f = await fixture(t); const started = await f.start(); const id = started.value.live.sessionId;
  const req = http.get(f.origin + started.value.live.mediaUrl);
  const res = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); }); res.resume();
  const ended = new Promise(resolve => { res.once('end', resolve); res.once('close', resolve); });
  if (cause === 'disconnect') req.destroy();
  if (cause === 'shutdown') await f.server.shutdown();
  if (cause === 'logout') assert.equal((await f.json('/api/v1/session/logout', {})).status, 202);
  if (cause === 'explicit-stop') assert.equal((await f.json(`/api/v1/live-sessions/${id}/stop`, {})).status, 200);
  await ended;
  for (let i = 0; i < 50 && !f.connection.counts().closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.connection.counts().closed, 1);
  if (cause !== 'shutdown') assert.equal((await f.json(`/api/v1/live-sessions/${id}`)).value.live.cleanupComplete, true);
});
for (const [serial, expected] of [['missing', 'DEVICE_NOT_FOUND'], ['other', 'LIVE_UNSUPPORTED']]) test(`v1 live ${expected} is structured`, async t => {
  const f = await fixture(t); assert.equal((await f.json('/api/v1/live-sessions', { serial, requestId: 'bad', allowUnverified: true })).value.error.code, expected);
});
module.exports = { fixture };

test('offline real FFmpeg: retained HTTP live sample fully decodes after clean explicit stop', { skip: !process.env.EUFY_FFMPEG, timeout: 20000 }, async t => {
  const { spawnSync } = require('node:child_process');
  const { createRuntime } = require('../capabilities/live/runtime.cjs');
  let runtime;
  const f = await fixture(t, { live: { startupMs: 10000, idleMs: 10000, attachMs: 5000,
    createRuntime: args => runtime = createRuntime(args) } });
  const generated = spawnSync(process.env.EUFY_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=160x120:rate=15', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-f', 'h264', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const producer = setInterval(() => { if (!f.connection.video.destroyed) f.connection.video.write(generated.stdout); }, 60);
  t.after(() => clearInterval(producer));
  const started = await f.start(); assert.equal(started.status, 201, JSON.stringify(started.value));
  const req = http.get(f.origin + started.value.live.mediaUrl);
  const res = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  let bytes = 0, enough; const received = new Promise(resolve => { enough = resolve; }); const chunks = [];
  res.on('data', chunk => { chunks.push(chunk); bytes += chunk.length; if (bytes > 30000) enough(); });
  const finished = new Promise(resolve => { res.once('end', resolve); res.once('close', resolve); });
  await received;
  const stopped = await f.json(`/api/v1/live-sessions/${started.value.live.sessionId}/stop`, {});
  clearInterval(producer); await finished;
  assert.equal(stopped.value.live.cleanupComplete, true); assert.equal(res.complete, true, 'explicit stop must finish the chunked MP4 response');
  const file = path.join(f.directory, 'retained-offline-live.mp4'); fs.writeFileSync(file, Buffer.concat(chunks));
  const decoded = spawnSync(process.env.EUFY_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
    '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr); assert.ok(bytes > 30000);
  assert.throws(() => process.kill(runtime.pid, 0), { code: 'ESRCH' });
  assert.equal(f.connection.video.destroyed, true); assert.equal(f.connection.audio.destroyed, true);
});

test('v1 production runtime launch failure returns a stable error and cleans its connection', async t => {
  const { createRuntime } = require('../capabilities/live/runtime.cjs');
  const f = await fixture(t, { live: { createRuntime, ffmpeg: path.join(OUTPUT, 'nonexistent-live-ffmpeg'), startupMs: 2000 } });
  const result = await f.start(); assert.equal(result.status, 503); assert.equal(result.value.error.code, 'LIVE_RUNTIME_ERROR');
  assert.equal(f.connection.counts().closed, 1); assert.equal(f.connection.video.destroyed, true);
});
test('disconnecting a pending HTTP start cancels its connection and permits a new owner after cleanup', async t => {
  const f = await fixture(t, { transport: { media: false }, live: { startupMs: 2000 } });
  const req = http.request(f.origin + '/api/v1/live-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {}); req.end(JSON.stringify({ serial: 'camera', requestId: 'pending', allowUnverified: true }));
  for (let i = 0; i < 100 && !f.connection.counts().opened; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.connection.counts().opened, 1); req.destroy();
  for (let i = 0; i < 100 && !f.connection.counts().closed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.connection.counts().closed, 1);
  assert.equal((await f.json('/api/v1/session')).value.busy, false);
});
