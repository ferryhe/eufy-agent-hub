const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Writable } = require('node:stream');
const { LiveSessions } = require('./session.cjs');
const { createRuntime } = require('./runtime.cjs');
const { transport } = require('./fixtures/transport.cjs');

const enabled = Boolean(process.env.EUFY_FFMPEG);
let source;
function input() {
  if (!source) {
    const result = spawnSync(process.env.EUFY_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=1920x1080:rate=15', '-t', '1.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-g', '15', '-f', 'h264', 'pipe:1'], { maxBuffer: 15 * 1024 * 1024, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr.toString()); source = result.stdout;
  }
  return source;
}
async function fixture(t, { stalled = false, drainMs = 10000 } = {}) {
  const data = input(), connection = transport(); let runtime, released = false;
  const scope = { serial: 'camera', model: 'T8600', firmware: { main: '1', secondary: '1' },
    homeBase: { serial: 'base', model: 'T8030', firmware: { main: '1', secondary: '1' } }, channel: 1 };
  const live = new LiveSessions({ session: { authenticated: true, api: { hasValidSession: () => true } },
    jobs: { acquireMedia: () => () => { released = true; } },
    resolveDevice: async () => ({ verificationScope: scope, capabilities: { liveVideo: { status: 'protocol_hint' } }, availability: 'unknown' }),
    createConnection: () => connection, createRuntime: args => runtime = createRuntime(args),
    startupMs: 10000, attachMs: 10000, idleMs: 10000, drainMs });
  const opening = live.start({ serial: 'camera', requestId: 'backpressure', allowUnverified: true });
  setImmediate(() => connection.video.write(data));
  const started = await opening, chunks = [];
  const response = new Writable({ highWaterMark: 16384,
    write(chunk, _encoding, done) { chunks.push(chunk); if (!stalled) setTimeout(done, 150); } });
  response.writeHead = () => {};
  t.after(async () => { await live.shutdown(); response.destroy(); });
  const ended = new Promise(resolve => { response.once('finish', resolve); response.once('close', resolve); });
  live.attach(started.sessionId, response);
  await new Promise(resolve => setTimeout(resolve, 200));
  return { live, started, response, ended, chunks, connection, runtime: () => runtime, released: () => released };
}
function checkClean(f, stopped) {
  assert.equal(stopped.cleanupComplete, true); assert.equal(f.connection.counts().closed, 1);
  assert.equal(f.released(), true); assert.equal(f.runtime().output.destroyed, true);
  assert.throws(() => process.kill(f.runtime().pid, 0), { code: 'ESRCH' });
}
test('offline R1: slow response retains fully decodable MP4 before healthy stop releases ownership', { skip: !enabled, timeout: 20000 }, async t => {
  const f = await fixture(t); let completed = false;
  const stopping = f.live.stop(f.started.sessionId).then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 200));
  const premature = completed || f.released();
  const stopped = await stopping; await f.ended;
  const decoded = spawnSync(process.env.EUFY_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', 'pipe:0',
    '-map', '0:v:0', '-f', 'null', '-'], { input: Buffer.concat(f.chunks), encoding: 'utf8', timeout: 10000 });
  assert.equal(decoded.status, 0, decoded.stderr); assert.equal(premature, false);
  assert.equal(f.response.writableFinished, true); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.error, null);
  checkClean(f, stopped);
});
for (const cause of ['stalled', 'disconnect', 'runtime']) test(`offline R1: ${cause} during graceful flush is bounded and reports failure after cleanup`,
  { skip: !enabled, timeout: 15000 }, async t => {
    const f = await fixture(t, { stalled: cause === 'stalled', drainMs: cause === 'stalled' ? 150 : 10000 });
    const before = Date.now(), stopping = f.live.stop(f.started.sessionId);
    if (cause === 'disconnect') f.response.destroy();
    if (cause === 'runtime') process.kill(f.runtime().pid, 'SIGKILL');
    const stopped = await stopping;
    assert.equal(stopped.state, 'failed');
    await f.ended;
    assert.equal(stopped.error?.code, { stalled: 'LIVE_MEDIA_TIMEOUT', disconnect: 'LIVE_CONNECTION_LOST', runtime: 'LIVE_DECODER_ERROR' }[cause]);
    assert.ok(Date.now() - before < 3000, 'failure cleanup must not wait for a stalled consumer');
    checkClean(f, stopped);
  });
