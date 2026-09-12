const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cli } = require('./test-helper.cjs');
const { createServer } = require('../interface/server.cjs');
const { LocalEufySession } = require('../capabilities/auth/session.cjs');
const { OUTPUT } = require('../capabilities/recordings/continuous-export.cjs');
const { DeviceType } = require('../adapters/eufy');

const windowArgs = ['--day', '2026-08-27', '--start', '16:30', '--end', '16:31', '--timezone', 'America/Toronto'];
const window = { day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto' };
const begin = 1787862600, end = begin + 60;
const raw = [
  { device_sn: 'base', device_model: 'T8030', device_type: DeviceType.HB3, device_name: 'Synthetic base', local_ip: '192.0.2.1' },
  { device_sn: 'camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247, device_name: 'Synthetic camera', parent_sn: 'base', device_channel: 0, status: 0 },
];
function captureFixture(destination) {
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'frames.bin'), Buffer.alloc(1200));
  const capture = { begin, end, reachedEnd: true, ranges: [{ start_time: begin, stop_time: end }],
    segments: [{ begin, end, reachedEnd: true, boundaryTimestampMs: end * 1000 }], diagnostics: [],
    frames: Array.from({ length: 1200 }, (_, i) => ({ kind: 'video', timestamp: begin * 1000 + i * 50,
      keyFrame: i % 20 === 0, length: 1, offset: i, streamType: 1 })) };
  fs.writeFileSync(path.join(destination, 'frames.json'), JSON.stringify(capture)); return capture;
}
function media(mode) {
  return async (_executable, args, { stage, directory }) => {
    fs.writeFileSync(path.join(directory, `${stage}.stdout.log`), stage === 'decode' ? `frame=${mode === 'partial' ? 20 : 1200}\nprogress=end\n` : '');
    fs.writeFileSync(path.join(directory, `${stage}.stderr.log`), '');
    if (mode === 'failed') throw new Error('Synthetic conversion failure');
    if (stage === 'mux') fs.writeFileSync(path.join(args[1], 'timed.ts'), 'ts');
    if (stage === 'convert') fs.writeFileSync(args.at(-1), 'synthetic-media-bytes');
    if (stage === 'timeline') fs.writeFileSync(path.join(args[1], 'media-timeline.json'), JSON.stringify({ muxStartMs: 0,
      streams: { video: { count: mode === 'partial' ? 20 : 1200, firstTimestampMs: 0, lastTimestampMs: mode === 'partial' ? 950 : 59950, lastDurationMs: 50 } } }));
  };
}
async function fixture(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'cli-resident-'));
  let valid = false;
  const calls = { create: 0, login: [], capture: 0 };
  const session = new LocalEufySession(() => {
    calls.create++;
    return { init: async () => {}, estimateDomain: async () => {}, hasValidSession: () => valid,
      login: async (...args) => {
        calls.login.push(args);
        await new Promise(resolve => setTimeout(resolve, 15));
        const code = options.codes?.shift() ?? 0; valid = code === 0; return { code };
      }, generateCaptcha: async () => ({ captcha_id: 'synthetic', item: 'aW1hZ2U=' }),
      sendVerifyCode: async () => ({ code: 0 }), getDevsListDecrypted: async () => ({ devices: raw }),
    };
  });
  const server = createServer({ port: 0, session, recordings: { close() {} }, outputRoot: directory,
    capabilityRecordsPath: path.join(directory, 'verification.json'),
    createRanges: () => ({ close() {}, listRange: async () => ({ videos: options.empty ? [] : [{ start_time: begin, stop_time: end }] }) }),
    exports: { outputRoot: path.join(directory, 'jobs'),
      ...(options.realMedia ? {} : { execute: media(options.mode) }),
      createCapture: () => ({ close() {}, captureRange: async (_serial, _begin, _end, destination) => {
        calls.capture++;
        if (options.gate) await options.gate;
        return options.capture ? options.capture(destination) : captureFixture(destination);
      } }),
    },
  });
  await new Promise(resolve => server.start(resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); await server.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = (args, input) => cli(['--json', '--poll-interval', '10', ...args], input, { EUFY_URL: url });
  async function http(route, body) {
    const response = await fetch(url + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  }
  async function login() {
    const result = await run(['auth', 'login', '--email', 'fixture@example.test', '--password', 'offline-only', '--country', 'CA']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  return { directory, run, http, login, calls, expire: () => { valid = false; } };
}

test('CLI completes real resident captcha and email lifecycle, including wrong-code continuation across processes', async t => {
  const f = await fixture(t, { codes: [100032, 26052, 26050, 0] });
  const first = await f.run(['auth', 'login', '--email', 'fixture@example.test', '--password', 'offline-only', '--country', 'CA', '--no-interactive']);
  assert.equal(first.code, 4); assert.equal(first.value.phase, 'captcha');
  const second = await f.run(['auth', 'login', '--interactive'], 'image-answer\nwrong\n123456\n');
  assert.equal(second.code, 0); assert.deepEqual(second.value, await f.http('/api/v1/session'));
  assert.equal(f.calls.create, 1); assert.equal(f.calls.login.length, 4);
  assert.deepEqual(f.calls.login[1][3], { captchaId: 'synthetic', answer: 'image-answer' });
  assert.equal(f.calls.login[3][2], '123456');
  assert.equal((await f.run(['auth', 'refresh'])).code, 0);
  assert.equal((await f.run(['auth', 'logout'])).code, 0);
  assert.equal((await f.run(['devices', 'list'])).value.error.code, 'UNAUTHENTICATED');
});

test('real resident devices, capability, normalized ranges and DST rejection exactly match direct HTTP', async t => {
  const f = await fixture(t); await f.login();
  for (const [args, route] of [[['devices', 'list'], '/api/v1/devices'], [['devices', 'get', 'camera'], '/api/v1/devices/camera'],
    [['devices', 'capabilities', 'camera', 'continuousRecordingExport'], '/api/v1/devices/camera/capabilities/continuousRecordingExport'],
    [['devices', 'capabilities', 'camera', 'futureCapability'], '/api/v1/devices/camera/capabilities/futureCapability']]) {
    assert.deepEqual((await f.run(args)).value, await f.http(route));
  }
  const ranges = await f.run(['recordings', 'ranges', 'camera', ...windowArgs]);
  assert.equal(ranges.code, 0); assert.deepEqual(ranges.value, await f.http('/api/v1/devices/camera/recording-ranges', window));
  assert.equal(ranges.value.window.normalized.start, '2026-08-27T20:30:00.000Z'); assert.equal(ranges.value.coverage, null);
  for (const input of [{ day: '2026-11-01', start: '01:15', end: '01:45' }, { day: '2026-03-08', start: '02:15', end: '03:15' }, { ...window, endDay: '2026-08-28' }]) {
    const args = Object.entries(input).flatMap(([key, value]) => [`--${key === 'endDay' ? 'end-day' : key}`, value]);
    const r = await f.run(['recordings', 'ranges', 'camera', ...args]);
    assert.equal(r.code, 9); assert.deepEqual(r.value, await f.http('/api/v1/devices/camera/recording-ranges', input));
  }
  const absent = await f.run(['devices', 'get', 'absent']); assert.equal(absent.code, 5); assert.equal(absent.value.error.code, 'DEVICE_NOT_FOUND');
  f.expire(); assert.equal((await f.run(['devices', 'list'])).code, 4);
});

test('real resident no-recording remains an explicit unchanged result', async t => {
  const f = await fixture(t, { empty: true }); await f.login();
  const r = await f.run(['recordings', 'ranges', 'camera', ...windowArgs]);
  assert.equal(r.code, 6); assert.deepEqual(r.value, await f.http('/api/v1/devices/camera/recording-ranges', window));
});

for (const action of ['logout', 'login', 'verify']) {
  test(`R1: auth ${action} recognizes its completed goal while owned resident capture remains busy`, async t => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const capturing = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, { capture: async destination => {
      started(); await gate; return captureFixture(destination);
    } });
    try {
      await f.login();
      const submitted = await f.run(['recordings', 'export', '--request-id', `auth-busy-${action}`, '--serial', 'camera', ...windowArgs]);
      assert.equal(submitted.code, 0); const id = submitted.value.job.jobId;
      await capturing;
      const before = await f.http('/api/v1/session');
      assert.equal(before.authenticated, true); assert.equal(before.busy, true); assert.equal(before.phase, 'connected');
      assert.deepEqual((await f.run(['auth', 'status'])).value, before);
      // Mutations that replace/refresh authentication remain blocked by the resident capture owner.
      for (const args of [['auth', 'refresh'], ['auth', 'verify', '--code', '123456']]) {
        const blocked = await f.run(args); assert.equal(blocked.code, 9); assert.equal(blocked.value.error.code, 'SERVICE_BUSY');
      }
      const result = await f.run(['auth', action, '--no-interactive', '--timeout', '250']);
      const after = await f.http('/api/v1/session');
      assert.equal(after.authenticated, action !== 'logout');
      assert.equal(after.phase, action === 'logout' ? 'login_required' : 'connected');
      assert.equal(after.busy, true, 'The gated capture still owns the resident job after the CLI exits');
      assert.equal((await f.http(`/api/v1/jobs/${id}`)).job.state, 'running');
      assert.equal(f.calls.create, 1); assert.equal(f.calls.login.length, 1, 'No command replaces the existing provider');
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(result.value, after, 'Return the unchanged, confirmed session despite recording busy');
      release();
      assert.equal((await f.run(['jobs', 'wait', id])).value.job.state, 'succeeded');
    } finally { release(); }
  });
}

test('submitting CLI exits while capture is gated; resident finishes durable job and serves files after logout', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { gate }); t.after(release); await f.login();
  const submit = await f.run(['recordings', 'export', '--request-id', 'durable-cli', '--serial', 'camera', ...windowArgs]);
  assert.equal(submit.code, 0); const id = submit.value.job.jobId; assert.ok(id);
  assert.equal(submit.value.job.state, 'queued');
  assert.ok(fs.existsSync(path.join(f.directory, 'jobs', id, 'metadata.json')));
  assert.ok(['queued', 'running'].includes((await f.run(['jobs', 'get', id])).value.job.state));
  release();
  const waited = await f.run(['jobs', 'wait', id]); assert.equal(waited.code, 0); assert.equal(waited.value.job.state, 'succeeded');
  assert.deepEqual(waited.value, await f.http(`/api/v1/jobs/${id}`));
  assert.equal((await f.run(['auth', 'logout'])).code, 0);
  const replay = await f.run(['recordings', 'export', '--request-id', 'durable-cli']);
  assert.equal(replay.code, 0); assert.equal(replay.value.reused, true); assert.deepEqual(replay.value.job, waited.value.job); assert.equal(f.calls.capture, 1);
  assert.deepEqual((await f.run(['jobs', 'get', id])).value, waited.value);
  const artifacts = await f.run(['artifacts', 'list', id]); assert.deepEqual(artifacts.value, await f.http(`/api/v1/jobs/${id}/artifacts`));
  const artifact = artifacts.value.artifacts.find(item => item.playable);
  const file = path.join(f.directory, 'download.mp4');
  const download = await f.run(['artifacts', 'get', id, artifact.id, '--output', file]); assert.equal(download.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic-media-bytes');
});

test('real resident partial and failed jobs remain HTTP-identical with nonzero CLI status', async t => {
  for (const mode of ['partial', 'failed']) {
    const f = await fixture(t, { mode }); await f.login();
    const submitted = await f.run(['recordings', 'export', '--request-id', mode, '--serial', 'camera', ...windowArgs]);
    const id = submitted.value.job.jobId;
    const r = await f.run(['jobs', 'wait', id]); assert.equal(r.code, mode === 'partial' ? 7 : 8);
    assert.equal(r.value.job.result.outcome, mode); assert.equal(r.value.job.state, 'failed');
    assert.deepEqual(r.value, await f.http(`/api/v1/jobs/${id}`));
    assert.equal((await f.run(['jobs', 'get', id])).code, r.code);
    assert.equal((await f.run(['recordings', 'export', '--request-id', mode])).code, r.code);
    const artifacts = await f.run(['artifacts', 'list', id]); assert.equal(artifacts.code, 0); assert.ok(artifacts.value.artifacts.length);
  }
});

test('configured real PyAV/FFmpeg CLI chain exports synthetic video, fully decodes and downloads registered media',
  { skip: !process.env.EUFY_PYTHON || !process.env.EUFY_FFMPEG }, async t => {
    let source;
    const f = await fixture(t, { realMedia: true, capture: destination => {
      fs.mkdirSync(destination);
      for (const name of ['frames.bin', 'frames.json']) fs.copyFileSync(path.join(source, name), path.join(destination, name));
      return JSON.parse(fs.readFileSync(path.join(destination, 'frames.json')));
    } });
    source = path.join(f.directory, 'synthetic'); fs.mkdirSync(source);
    const run = (executable, args) => {
      const r = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
      assert.equal(r.status, 0, r.error?.message || r.stderr);
    };
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=128x72:r=20:d=60',
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'bframes=0:keyint=20:repeat-headers=1', '-f', 'h264', path.join(source, 'synthetic.h264')]);
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-t', '60', '-c:a', 'aac', '-f', 'adts', path.join(source, 'synthetic.aac')]);
    run(process.env.EUFY_PYTHON, [path.join(__dirname, '../capabilities/recordings/fixtures/synthetic-continuous.py'), source]);
    await f.login();
    const accepted = await f.run(['recordings', 'export', '--request-id', 'real-media', '--serial', 'camera', ...windowArgs]);
    assert.equal(accepted.code, 0); const id = accepted.value.job.jobId;
    const complete = await f.run(['jobs', 'wait', id]); assert.equal(complete.code, 0, complete.stdout);
    assert.equal(complete.value.job.result.outcome, 'complete');
    assert.equal(complete.value.job.result.validation.decode.videoFrames, 1200);
    assert.equal(complete.value.job.result.validation.timingPreserved, true);
    assert.deepEqual(complete.value, await f.http(`/api/v1/jobs/${id}`));
    const artifacts = await f.run(['artifacts', 'list', id]); const artifact = artifacts.value.artifacts.find(item => item.playable);
    const output = path.join(f.directory, 'download.mp4');
    const downloaded = await f.run(['artifacts', 'get', id, artifact.id, '--output', output]); assert.equal(downloaded.code, 0);
    assert.ok(fs.statSync(output).size > 0);
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
  });
