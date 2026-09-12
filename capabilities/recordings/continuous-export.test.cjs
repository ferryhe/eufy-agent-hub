const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { ContinuousExportService, runProcess, OUTPUT } = require('./continuous-export.cjs');

const request = (requestId = 'one') => ({ requestId, serial: 'camera', homeBaseId: 'base',
  day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto' });
const begin = 1787862600, end = begin + 60;
function captureFixture() {
  return { begin, end, reachedEnd: true, ranges: [{ start_time: begin, stop_time: end }],
    segments: [{ begin, end, reachedEnd: true, boundaryTimestampMs: end * 1000 }], diagnostics: [],
    frames: Array.from({ length: 1200 }, (_, index) => ({ kind: 'video', timestamp: begin * 1000 + index * 50,
      keyFrame: index % 20 === 0, length: 1, offset: index, streamType: 1 })) };
}
function output(t) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'continuous-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function fakeMedia({ short = false, corrupt = false, fail, stages = [] } = {}) {
  return async (_executable, args, { directory, stage, signal }) => {
    stages.push(stage); signal.throwIfAborted();
    fs.writeFileSync(path.join(directory, `${stage}.stdout.log`), stage === 'decode'
      ? `frame=${short ? 20 : 1200}\nprogress=end\n` : '');
    fs.writeFileSync(path.join(directory, `${stage}.stderr.log`), '');
    if (stage === fail || (corrupt && stage === 'decode')) throw new Error(`${stage} fixture failure`);
    if (stage === 'mux') fs.writeFileSync(path.join(args[1], 'timed.ts'), 'ts');
    if (stage === 'convert') fs.writeFileSync(args.at(-1), 'mp4');
    if (stage === 'timeline') fs.writeFileSync(path.join(args[1], 'media-timeline.json'), JSON.stringify({ muxStartMs: 0,
      streams: { video: { count: short ? 20 : 1200, firstTimestampMs: 0, lastTimestampMs: short ? 950 : 59950, lastDurationMs: 50 } } }));
  };
}
function service(t, { capture = captureFixture(), execute = fakeMedia(), captureRange, outputRoot = output(t) } = {}) {
  const calls = [];
  let closed = 0;
  const exporter = new ContinuousExportService({ outputRoot, execute, createCapture: () => ({
    close() { closed++; },
    async captureRange(serial, start, stop, directory, options) {
      calls.push({ serial, start, stop, directory });
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'frames.bin'), Buffer.alloc(capture.frames.length));
      if (captureRange) await captureRange(options);
      fs.writeFileSync(path.join(directory, 'frames.json'), JSON.stringify(capture));
      return capture;
    },
  }) });
  return { exporter, calls, closed: () => closed };
}
async function finish(exporter, input = request()) {
  const accepted = exporter.submit(input);
  assert.equal(accepted.state, 'queued');
  await exporter.whenIdle();
  return exporter.get(accepted.jobId);
}

test('one durable submission runs all stages and persists normalized time, observed coverage and validated ownership', async t => {
  const stages = [];
  const { exporter, calls, closed } = service(t, { execute: fakeMedia({ stages }) });
  const job = await finish(exporter);
  assert.equal(job.state, 'succeeded', JSON.stringify({error: job.error, diagnostics: job.result.diagnostics}));
  assert.equal(job.result.outcome, 'complete');
  assert.deepEqual(stages, ['python-runtime', 'ffmpeg-runtime', 'mux', 'convert', 'decode', 'timeline']);
  assert.equal(calls.length, 1); assert.equal(closed(), 1);
  assert.equal(calls[0].start, begin); assert.equal(calls[0].stop, end);
  assert.equal(job.result.window.normalized.start, '2026-08-27T20:30:00.000Z');
  assert.equal(job.result.window.normalized.timezone, 'America/Toronto');
  assert.equal(job.result.coverage.video.lastTimestampMs, end * 1000 - 50);
  assert.equal(job.result.timeline.mp4ZeroUnixMs, begin * 1000);
  assert.equal(job.result.media.path, 'artifacts/playback.mp4');
  assert.equal(job.progress, 1);
  const stored = JSON.parse(fs.readFileSync(job.metadataPath));
  assert.deepEqual(stored, job);
  assert.ok(job.artifacts.find(file => file.path.endsWith('frames.bin') && file.metadata.validated === false));
  assert.ok(job.artifacts.find(file => file.path === 'artifacts/playback.mp4' && file.metadata.playable));
});

test('same identity never captures twice or overwrites; distinct jobs use distinct directories', async t => {
  const { exporter, calls } = service(t);
  const first = exporter.submit(request());
  assert.equal(exporter.submit({ requestId: 'one', serial: null }).jobId, first.jobId);
  await exporter.whenIdle();
  const second = await finish(exporter, request('two'));
  assert.equal(calls.length, 2);
  assert.notEqual(first.partialDir, second.partialDir);
  const reopened = new ContinuousExportService({ outputRoot: exporter.jobs.outputRoot, execute: fakeMedia() });
  assert.equal(reopened.submit({ requestId: 'one' }).jobId, first.jobId);
});

test('zero exit with short media stays partial; corrupt media is never advertised as playable', async t => {
  for (const variant of [{ short: true }, { corrupt: true }]) {
    const { exporter } = service(t, { execute: fakeMedia(variant) });
    const job = await finish(exporter);
    assert.equal(job.state, 'failed'); assert.equal(job.result.outcome, 'partial', JSON.stringify(job.error));
    assert.equal(job.result.coverageVerified, false);
    if (variant.short) {
      assert.equal(job.result.validation.passed, true);
      assert.ok(job.result.completeness.reasons.includes('decoded_coverage_short'));
      assert.equal(job.result.media.path, 'partial/capture/playback.mp4');
    } else {
      assert.equal(job.result.media, null);
      assert.ok(job.artifacts.find(file => file.path.endsWith('playback.mp4') && file.metadata.validated === false));
    }
  }
});

test('gap/end-marker and disconnect raw captures can be salvaged but never succeed', async t => {
  for (const disconnected of [false, true]) {
    const capture = captureFixture();
    capture.frames.splice(20, 2);
    if (disconnected) { capture.reachedEnd = false; capture.diagnostics.push({ stage: 'capture', message: 'HomeBase disconnected' }); }
    const { exporter } = service(t, { capture });
    const job = await finish(exporter);
    assert.equal(job.state, 'failed'); assert.equal(job.result.outcome, 'partial', JSON.stringify(job.error));
    assert.ok(job.result.completeness.reasons.includes('video_timestamp_gap'));
    if (disconnected) {
      assert.ok(job.result.completeness.reasons.includes('end_not_reached'));
      assert.ok(job.result.diagnostics.some(item => item.message === 'HomeBase disconnected'));
    }
    assert.equal(job.result.media.playable, true);
  }
});

test('a fully decoded video with a shortened audio stream cannot be complete', async t => {
  const capture = captureFixture();
  capture.frames.push(...capture.frames.map(frame => ({ ...frame, kind: 'audio' })));
  const execute = fakeMedia();
  const { exporter } = service(t, { capture, execute: async (executable, args, options) => {
    await execute(executable, args, options);
    if (options.stage === 'timeline') {
      const file = path.join(args[1], 'media-timeline.json');
      const media = JSON.parse(fs.readFileSync(file));
      media.streams.audio = { count: 1, firstTimestampMs: 0, lastTimestampMs: 0, lastDurationMs: 50 };
      fs.writeFileSync(file, JSON.stringify(media));
    }
  } });
  const job = await finish(exporter);
  assert.equal(job.state, 'failed');
  assert.equal(job.result.outcome, 'partial');
  assert.ok(job.result.completeness.reasons.includes('output_audio_coverage_short'));
});

test('each processing failure preserves stage logs and raw files without success registration', async t => {
  for (const fail of ['python-runtime', 'ffmpeg-runtime', 'mux', 'convert', 'timeline']) {
    const { exporter, calls } = service(t, { execute: fakeMedia({ fail }) });
    const job = await finish(exporter);
    assert.equal(job.state, 'failed'); assert.equal(job.result.media, null);
    assert.equal(job.result.diagnostics[0].stage, fail, JSON.stringify(job.error));
    assert.ok(job.artifacts.find(file => file.path.endsWith(`${fail}.stderr.log`)));
    if (fail.endsWith('runtime')) assert.equal(calls.length, 0);
    else assert.ok(job.artifacts.find(file => file.path.endsWith('frames.bin')));
  }
});

test('missing Python and missing FFmpeg are actionable runtime failures before capture', async t => {
  for (const missing of ['python', 'ffmpeg']) {
    const { exporter, calls } = service(t, { execute: missing === 'python' ? runProcess : async (exe, args, options) => {
      if (options.stage === 'python-runtime') return fakeMedia()(exe, args, options);
      return runProcess(exe, args, options);
    } });
    exporter[missing] = path.join(exporter.jobs.outputRoot, 'does-not-exist');
    const job = await finish(exporter);
    assert.equal(job.state, 'failed'); assert.equal(calls.length, 0);
    assert.match(job.error.message, /EUFY_PYTHON.*EUFY_FFMPEG/);
  }
});

test('service shutdown stops current capture, cancels queued work and preserves partial bytes', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const capture = captureFixture(); capture.reachedEnd = false;
  const { exporter, calls, closed } = service(t, { capture, captureRange: async ({ signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    capture.diagnostics.push({ stage: 'cancelled', message: 'Stopped' });
  } });
  const first = exporter.submit(request()); const queued = exporter.submit(request('two'));
  await ready;
  assert.equal(exporter.get(first.jobId).stage, 'capture');
  await exporter.shutdown();
  assert.equal(exporter.get(first.jobId).state, 'cancelled');
  assert.equal(exporter.get(queued.jobId).state, 'cancelled');
  assert.equal(calls.length, 1); assert.equal(closed(), 1);
  assert.ok(fs.existsSync(path.join(first.partialDir, 'capture/frames.bin')));
  assert.throws(() => exporter.submit(request('three')), /shutting down/);
});

test('media subprocess abort waits for process close and keeps its logs', async t => {
  const directory = output(t), controller = new AbortController();
  const execution = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { directory, stage: 'wait', signal: controller.signal });
  controller.abort(new Error('test stop'));
  await assert.rejects(execution, /test stop/);
  assert.ok(fs.existsSync(path.join(directory, 'wait.stderr.log')));
});

test('restart after a real resident process stops interrupts capture without replay and allows explicit retry', async t => {
  const directory = output(t);
  const child = fork(path.join(__dirname, 'fixtures/continuous-export-resident.cjs'), [directory], { silent: true });
  t.after(() => child.kill());
  const [accepted] = await once(child, 'message');
  const exited = once(child, 'exit'); child.kill(); await exited;
  const { exporter: restored, calls } = service(t, { outputRoot: directory });
  const job = restored.get(accepted.jobId);
  assert.equal(job.state, 'failed'); assert.equal(job.stage, 'capture');
  assert.equal(job.error.code, 'JOB_INTERRUPTED');
  assert.ok(fs.existsSync(path.join(job.partialDir, 'capture/frames.bin')));
  assert.equal(restored.submit(request()).jobId, job.jobId);
  await restored.whenIdle();
  assert.equal(calls.length, 0);
  const retry = restored.retry(job.jobId, { requestId: 'retry' });
  await restored.whenIdle();
  assert.equal(calls.length, 1); assert.equal(restored.get(retry.jobId).state, 'succeeded');
  assert.equal(restored.get(job.jobId).state, 'failed');
});

test('operator cancellation at every media stage stops later work, waits for cleanup and keeps last stage', async t => {
  for (const stoppedStage of ['python-runtime', 'ffmpeg-runtime', 'capture', 'mux', 'convert', 'decode', 'timeline']) {
    let started, cleanup; const ready = new Promise(resolve => { started = resolve; });
    const drained = new Promise(resolve => { cleanup = resolve; }); t.after(() => cleanup());
    const stages = [], execute = fakeMedia({ stages });
    const wait = async signal => {
      started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await drained;
    };
    const { exporter, calls } = service(t, {
      execute: async (exe, args, options) => {
        await execute(exe, args, options);
        if (options.stage === stoppedStage) await wait(options.signal);
      },
      captureRange: stoppedStage === 'capture' ? async ({ signal }) => wait(signal) : undefined,
    });
    const job = exporter.submit(request()), queued = exporter.submit(request('second'));
    await ready; const before = [...stages];
    const pending = exporter.cancel(job.jobId);
    assert.equal(pending.state, 'running'); assert.equal(exporter.get(queued.jobId).state, 'queued');
    assert.equal(exporter.get(job.jobId).stage, stoppedStage);
    // Cancel the follower so only the first job's later stages are measured.
    exporter.cancel(queued.jobId); cleanup(); await exporter.whenIdle();
    const done = exporter.get(job.jobId);
    assert.equal(done.state, 'cancelled'); assert.equal(done.stage, stoppedStage);
    assert.deepEqual(stages, before); assert.equal(done.result.media, null);
    assert.ok(done.artifacts.some(artifact => artifact.path === 'partial/result.json'));
    assert.ok(done.result.diagnostics.some(item => item.stage === stoppedStage));
    assert.equal(calls.length, stoppedStage.endsWith('runtime') ? 0 : 1);
  }
});

test('an already aborted subprocess never starts or allocates stage logs', async t => {
  const directory = output(t), controller = new AbortController(); controller.abort(new Error('Cancelled before stage'));
  const marker = path.join(directory, 'should-not-exist');
  await assert.rejects(async () => runProcess(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    { directory, stage: 'aborted', signal: controller.signal }), /Cancelled before stage/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('invalid timezone windows and output roots fail before allocating a job', t => {
  const { exporter } = service(t);
  assert.throws(() => exporter.submit({ ...request(), day: '2026-11-01', start: '01:10', end: '01:30' }));
  assert.throws(() => exporter.submit({ ...request(), start: '23:50', end: '00:10' }));
  assert.equal(exporter.jobs.list().length, 0);
  assert.throws(() => new ContinuousExportService({ outputRoot: path.resolve(OUTPUT, '..') }), /below this repository/);
});
