const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { JobService, DEFAULT_OUTPUT_ROOT } = require('./service.cjs');

const complete = () => ({ outcome: 'complete', coverageVerified: true, validation: { passed: true } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function root(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-jobs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function service(t, worker) {
  return new JobService({ outputRoot: root(t), worker });
}
const request = (requestId, homeBaseId = 'home-a') => ({ requestId, homeBaseId, input: { range: [1, 2] } });

test('Windows transient metadata replacement denial retries without losing the old durable snapshot', { skip: process.platform !== 'win32' }, async t => {
  const jobs = service(t, complete);
  const queued = jobs.submit(request('replace'));
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, destination) => {
    if (destination === queued.metadataPath && attempts++ < 2) {
      assert.equal(JSON.parse(fs.readFileSync(destination)).state, 'queued');
      throw Object.assign(new Error('temporary Windows sharing denial'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    }
    return rename(source, destination);
  };
  try { assert.equal(jobs.cancelQueued(queued.jobId).state, 'cancelled'); }
  finally { fs.renameSync = rename; }
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(queued.metadataPath)).state, 'cancelled');
  await jobs.whenIdle();
});

test('metadata replacement retry is bounded and other errors fail immediately while preserving the snapshot', async t => {
  for (const code of ['EPERM', 'EIO']) {
    const jobs = service(t, complete);
    const queued = jobs.submit(request('replace'));
    const rename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (_source, destination) => {
      if (destination === queued.metadataPath) { attempts++; throw Object.assign(new Error('persistent failure'), { code }); }
      return rename(_source, destination);
    };
    try { assert.throws(() => jobs.cancelQueued(queued.jobId), /persistent failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(attempts, code === 'EPERM' && process.platform === 'win32' ? 6 : 1);
    assert.equal(JSON.parse(fs.readFileSync(queued.metadataPath)).state, 'queued');
    assert.equal(jobs.get(queued.jobId).state, 'queued');
    await jobs.whenIdle();
  }
});

test('stable identity, independent snapshots, persistent reopen, and no duplicate execution', async t => {
  let calls = 0;
  const outputRoot = root(t);
  const jobs = new JobService({ outputRoot, worker: async () => { calls++; return complete(); } });
  const first = jobs.submit(request('one'));
  assert.equal(first.state, 'queued');
  assert.equal(first.stage, 'queued');
  assert.equal(first.progress, 0);
  first.input.range[0] = 9;
  const duplicate = jobs.submit({ requestId: 'one', homeBaseId: 'different', input: { changed: true } });
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.homeBaseId, 'home-a');
  assert.deepEqual(duplicate.input, { range: [1, 2] });
  await jobs.whenIdle();
  const done = jobs.get(first.jobId);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.progress, 1);
  const reopened = new JobService({ outputRoot, worker: async () => { calls++; return complete(); } });
  assert.deepEqual(reopened.get(first.jobId), done);
  assert.deepEqual(reopened.submit(request('one')), done);
  await reopened.whenIdle();
  assert.equal(calls, 1);
  assert.equal(reopened.get('unknown'), null);
  assert.ok(DEFAULT_OUTPUT_ROOT.endsWith(path.join('output', 'jobs')));
});

test('durable pages are deterministic, bounded, filtered and survive reopen', async t => {
  const gate = deferred();
  const outputRoot = root(t);
  const jobs = new JobService({ outputRoot, worker: async () => { await gate.promise; return complete(); } });
  t.after(() => gate.resolve());
  const submitted = [
    jobs.submit(request('one', 'home-a')),
    jobs.submit({ ...request('two', 'home-b'), input: { serial: 'camera-b' } }),
    jobs.submit({ ...request('three', 'home-c'), input: { serial: 'camera-a' } }),
  ];
  const first = jobs.listPage({ pageSize: 2 });
  assert.deepEqual(first.jobs.map(job => job.jobId), [submitted[2].jobId, submitted[1].jobId]);
  assert.equal(typeof first.nextCursor, 'string');
  const second = jobs.listPage({ pageSize: 2, cursor: first.nextCursor });
  assert.deepEqual(second.jobs.map(job => job.jobId), [submitted[0].jobId]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(jobs.listPage({ serial: 'camera-a' }).jobs.map(job => job.jobId), [submitted[2].jobId]);
  await new Promise(resolve => setImmediate(resolve));
  const running = jobs.listPage({ state: 'running' });
  assert.deepEqual(running.jobs.map(job => job.jobId).sort(), submitted.map(job => job.jobId).sort());
  assert.throws(() => jobs.listPage({ pageSize: 0 }), /pageSize/);
  assert.throws(() => jobs.listPage({ pageSize: 101 }), /pageSize/);
  assert.throws(() => jobs.listPage({ cursor: 'not-a-cursor' }), /cursor/);
  assert.throws(() => jobs.listPage({ cursor: first.nextCursor, state: 'failed' }), /cursor/);

  gate.resolve(); await jobs.whenIdle();
  const reopened = new JobService({ outputRoot, worker: async () => assert.fail('terminal jobs must not replay') });
  assert.deepEqual(reopened.listPage({ pageSize: 2 }), jobs.listPage({ pageSize: 2 }));
  await reopened.whenIdle();
});

test('page cursor freezes the upper sequence while later submissions cannot duplicate or skip the traversal', async t => {
  const jobs = service(t, complete);
  const retained = Array.from({ length: 26 }, (_, index) => jobs.submit(request(`retained-${index}`, `home-${index}`)));
  const first = jobs.listPage();
  assert.equal(first.jobs.length, 25, 'default page size is 25');
  const later = jobs.submit(request('later', 'home-later'));
  const seen = [...first.jobs];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = jobs.listPage({ cursor });
    seen.push(...page.jobs); cursor = page.nextCursor;
  }
  assert.deepEqual(seen.map(job => job.jobId), [...retained].reverse().map(job => job.jobId));
  assert.equal(new Set(seen.map(job => job.jobId)).size, retained.length);
  assert.equal(seen.some(job => job.jobId === later.jobId), false);
  await jobs.whenIdle();
});

test('state filters use current state when every page is read', async t => {
  const gate = deferred();
  const jobs = service(t, async () => { await gate.promise; return complete(); });
  t.after(() => gate.resolve());
  jobs.submit(request('running'));
  const older = jobs.submit(request('older-queued'));
  const newer = jobs.submit(request('newer-queued'));
  await new Promise(resolve => setImmediate(resolve));
  const first = jobs.listPage({ pageSize: 1, state: 'queued' });
  assert.deepEqual(first.jobs.map(job => job.jobId), [newer.jobId]);
  jobs.cancelQueued(older.jobId);
  const second = jobs.listPage({ pageSize: 1, state: 'queued', cursor: first.nextCursor });
  assert.deepEqual(second, { jobs: [], nextCursor: null });
  gate.resolve(); await jobs.whenIdle();
});

test('same HomeBase is FIFO through failure; another HomeBase can progress independently', async t => {
  const gate = deferred();
  const started = [];
  const jobs = service(t, async ({ job, updateProgress }) => {
    started.push(job.requestId);
    updateProgress('receiving', 0.25);
    if (job.requestId === 'first') { await gate.promise; throw new Error('capture failed'); }
    return complete();
  });
  const first = jobs.submit(request('first'));
  const second = jobs.submit(request('second'));
  const other = jobs.submit(request('other', 'home-b'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'other']);
  assert.equal(jobs.get(first.jobId).state, 'running');
  assert.equal(jobs.get(first.jobId).stage, 'receiving');
  assert.equal(jobs.get(first.jobId).progress, 0.25);
  const disk = JSON.parse(fs.readFileSync(jobs.get(first.jobId).metadataPath, 'utf8'));
  assert.equal(disk.stage, 'receiving');
  assert.equal(jobs.get(second.jobId).state, 'queued');
  assert.equal(jobs.get(other.jobId).state, 'succeeded');
  gate.resolve();
  await jobs.whenIdle();
  assert.deepEqual(started, ['first', 'other', 'second']);
  assert.equal(jobs.get(first.jobId).state, 'failed');
  assert.equal(jobs.get(first.jobId).stage, 'receiving');
  assert.match(jobs.get(first.jobId).error.message, /capture failed/);
  assert.equal(jobs.get(second.jobId).state, 'succeeded');
});

test('only affirmative coverage and validation may succeed; partial, failed and cancelled are distinct', async t => {
  const cases = [
    [undefined, 'failed', 'failed'],
    [{ outcome: 'complete' }, 'failed', 'failed'],
    [{ outcome: 'complete', coverageVerified: true }, 'failed', 'failed'],
    [{ outcome: 'complete', validation: { passed: true } }, 'failed', 'failed'],
    [{ outcome: 'complete', coverageVerified: true, validation: { passed: false } }, 'failed', 'failed'],
    [{ outcome: 'complete', coverageVerified: 'yes', validation: { passed: true } }, 'failed', 'failed'],
    [{ outcome: 'partial', coverageVerified: false, validation: { passed: true }, details: { lastFrame: 12 } }, 'failed', 'partial'],
    [{ outcome: 'failed', error: { code: 'DECODE_FAILED', message: 'Invalid video' } }, 'failed', 'failed'],
    [{ outcome: 'cancelled', error: { code: 'STOPPED', message: 'Worker stopped' } }, 'cancelled', 'cancelled'],
    [complete(), 'succeeded', 'complete'],
  ];
  for (const [result, state, outcome] of cases) {
    const jobs = service(t, async ({ artifactsDir }) => {
      fs.writeFileSync(path.join(artifactsDir, 'video.mp4'), 'file existence is not validation');
      return result;
    });
    const { jobId } = jobs.submit(request('one'));
    await jobs.whenIdle();
    const final = jobs.get(jobId);
    assert.equal(final.state, state);
    assert.equal(final.result.outcome, outcome);
    if (outcome === 'partial') assert.deepEqual(final.result.details, { lastFrame: 12 });
    if (state === 'failed') assert.ok(final.error.message);
  }
});

test('queued cancellation never executes; terminal jobs reject progress and cannot transition again', async t => {
  const gate = deferred();
  let context;
  const calls = [];
  const jobs = service(t, async ctx => {
    context = ctx;
    calls.push(ctx.job.requestId);
    await gate.promise;
    return complete();
  });
  const first = jobs.submit(request('first'));
  const second = jobs.submit(request('second'));
  assert.equal(jobs.cancelQueued(second.jobId).state, 'cancelled');
  assert.equal(jobs.cancelQueued(second.jobId).state, 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => jobs.cancelQueued(first.jobId), /queued/);
  assert.throws(() => context.updateProgress('receiving', 1.1), /progress/);
  gate.resolve();
  await jobs.whenIdle();
  assert.deepEqual(calls, ['first']);
  assert.throws(() => context.updateProgress('late', 0.5), /running/);
  assert.throws(() => context.registerArtifact('partial/late.log'), /running/);
  assert.throws(() => jobs.cancelQueued(first.jobId), /queued/);
  assert.equal(jobs.get(first.jobId).state, 'succeeded');
});

test('each job owns artifacts and partial diagnostics; duplicate submissions preserve capture and metadata', async t => {
  const jobs = service(t, async ({ job, artifactsDir, partialDir, registerArtifact }) => {
    fs.writeFileSync(path.join(artifactsDir, 'video.mp4'), job.requestId);
    fs.writeFileSync(path.join(partialDir, 'capture.log'), 'diagnostic');
    registerArtifact('artifacts/video.mp4', { kind: 'video' });
    registerArtifact('partial/capture.log', { kind: 'diagnostic' });
    assert.throws(() => registerArtifact('../another/video.mp4'), /job directories/);
    assert.throws(() => registerArtifact('metadata.json'), /job directories/);
    return { outcome: 'partial', details: { requestedRange: [1, 2], actualRange: [1, 1.5] } };
  });
  const a = jobs.submit(request('a'));
  const b = jobs.submit(request('b'));
  await jobs.whenIdle();
  assert.notEqual(a.artifactsDir, b.artifactsDir);
  assert.notEqual(a.partialDir, b.partialDir);
  assert.notEqual(a.metadataPath, b.metadataPath);
  const before = fs.readFileSync(a.metadataPath, 'utf8');
  jobs.submit(request('a'));
  await jobs.whenIdle();
  assert.equal(fs.readFileSync(a.metadataPath, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(a.artifactsDir, 'video.mp4'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(b.artifactsDir, 'video.mp4'), 'utf8'), 'b');
  assert.deepEqual(jobs.get(a.jobId).artifacts.map(item => item.path), ['artifacts/video.mp4', 'partial/capture.log']);
});

test('restart interrupts running work, recovers queued FIFO and never replays failed work', async t => {
  const outputRoot = root(t);
  const jobs = new JobService({ outputRoot, worker: complete });
  const first = jobs.submit(request('first'));
  const second = jobs.submit(request('second'));
  const third = jobs.submit(request('third'));
  await jobs.whenIdle(); // Stop the previous owner before constructing restart snapshots.
  fs.writeFileSync(path.join(first.partialDir, 'capture.log'), 'interrupted evidence');
  fs.writeFileSync(first.metadataPath, JSON.stringify({ ...first, state: 'running', stage: 'receiving', progress: 0.25,
    result: { outcome: 'partial', diagnostics: [{ stage: 'receiving', message: 'last packet' }] },
    artifacts: [{ path: 'partial/capture.log', metadata: { role: 'diagnostic' } }] }));
  fs.writeFileSync(second.metadataPath, JSON.stringify(second));
  fs.writeFileSync(third.metadataPath, JSON.stringify(third));
  const calls = [];
  const reopened = new JobService({ outputRoot, worker: async ({ job }) => { calls.push(job.requestId); return complete(); } });
  const interrupted = reopened.get(first.jobId);
  assert.equal(interrupted.state, 'failed');
  assert.equal(interrupted.stage, 'receiving');
  assert.equal(interrupted.progress, 0.25);
  assert.equal(interrupted.error.code, 'JOB_INTERRUPTED');
  assert.match(interrupted.error.message, /retry/i);
  assert.equal(interrupted.artifacts[0].path, 'partial/capture.log');
  assert.deepEqual(interrupted.result.diagnostics, [{ stage: 'receiving', message: 'last packet' }]);
  assert.equal(fs.readFileSync(path.join(first.partialDir, 'capture.log'), 'utf8'), 'interrupted evidence');
  assert.equal(reopened.get(second.jobId).state, 'queued');
  assert.equal(reopened.submit(request('first')).jobId, first.jobId);
  const fourth = reopened.submit(request('fourth'));
  await reopened.whenIdle();
  assert.deepEqual(calls, ['second', 'third', 'fourth']);
  assert.equal(reopened.get(fourth.jobId).state, 'succeeded');
  assert.equal(JSON.parse(fs.readFileSync(first.metadataPath)).state, 'failed');
  const retry = reopened.retry(first.jobId, { requestId: 'retry-interrupted' });
  await reopened.whenIdle(); assert.equal(reopened.get(retry.jobId).state, 'succeeded');
  assert.deepEqual(reopened.get(first.jobId), interrupted);
});

test('running cancellation persists intent, waits for owned cleanup and retains evidence before FIFO release', async t => {
  const cleanup = deferred(), entered = deferred(); const calls = [];
  let context;
  const jobs = service(t, async ctx => {
    calls.push(ctx.job.requestId);
    if (ctx.job.requestId !== 'first') return complete();
    context = ctx; ctx.updateProgress('receiving', 0.3); entered.resolve();
    await cleanup.promise;
    fs.writeFileSync(path.join(ctx.partialDir, 'stop.log'), 'cleanup complete');
    ctx.registerArtifact('partial/stop.log');
    return complete(); // A late successful worker return must not defeat cancellation.
  });
  t.after(() => cleanup.resolve());
  const first = jobs.submit(request('first')), second = jobs.submit(request('second'));
  await entered.promise;
  const cancelling = jobs.cancel(first.jobId);
  assert.equal(cancelling.state, 'running');
  assert.ok(cancelling.cancellationRequestedAt);
  assert.equal(context.signal.aborted, true);
  assert.throws(() => context.updateProgress('mux', 0.5), /cancel/i);
  assert.equal(jobs.cancel(first.jobId).cancellationRequestedAt, cancelling.cancellationRequestedAt);
  assert.equal(JSON.parse(fs.readFileSync(first.metadataPath)).cancellationRequestedAt, cancelling.cancellationRequestedAt);
  assert.equal(jobs.get(second.jobId).state, 'queued');
  cleanup.resolve(); await jobs.whenIdle();
  const done = jobs.get(first.jobId);
  assert.equal(done.state, 'cancelled'); assert.equal(done.stage, 'receiving');
  assert.equal(done.error.code, 'CANCELLED'); assert.equal(done.artifacts[0].path, 'partial/stop.log');
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(jobs.cancel(first.jobId).state, 'cancelled');
  assert.throws(() => jobs.cancel(second.jobId), /queued|running/);
});

test('explicit retry uses new identity and directories; duplicates and reopen never retry failures', async t => {
  const outputRoot = root(t); const calls = [];
  const worker = async ({ job, partialDir, registerArtifact, updateProgress }) => {
    calls.push(job.requestId); updateProgress('decode', 0.8);
    fs.writeFileSync(path.join(partialDir, 'decode.log'), 'decode error'); registerArtifact('partial/decode.log');
    throw new Error('decode failed: inspect decode.log');
  };
  const jobs = new JobService({ outputRoot, worker });
  const original = jobs.submit(request('original')); await jobs.whenIdle();
  const before = fs.readFileSync(original.metadataPath, 'utf8');
  const reopened = new JobService({ outputRoot, worker }); await reopened.whenIdle();
  assert.equal(reopened.submit(request('original')).jobId, original.jobId);
  assert.deepEqual(calls, ['original']);
  const retry = reopened.retry(original.jobId, { requestId: 'retry-one' });
  assert.equal(retry.retryOfJobId, original.jobId); assert.equal(retry.attempt, 2);
  assert.deepEqual(retry.input, original.input); assert.equal(retry.homeBaseId, original.homeBaseId);
  assert.notEqual(retry.partialDir, original.partialDir);
  assert.equal(reopened.retry(original.jobId, { requestId: 'retry-one' }).jobId, retry.jobId);
  assert.equal(reopened.submit(request('retry-one', 'changed')).jobId, retry.jobId);
  await reopened.whenIdle(); assert.deepEqual(calls, ['original', 'retry-one']);
  assert.equal(fs.readFileSync(original.metadataPath, 'utf8'), before);
  const last = new JobService({ outputRoot, worker }); await last.whenIdle();
  assert.equal(last.retry(original.jobId, { requestId: 'retry-one' }).jobId, retry.jobId);
  assert.deepEqual(calls, ['original', 'retry-one']);
});

test('restart finishes persisted cancellation without replay, and retry rejects unfinished or successful work', async t => {
  const outputRoot = root(t), jobs = new JobService({ outputRoot, worker: complete });
  const original = jobs.submit(request('one')); await jobs.whenIdle();
  assert.throws(() => jobs.retry(original.jobId, { requestId: 'bad' }), /failed|interrupted|cancelled/);
  fs.writeFileSync(original.metadataPath, JSON.stringify({ ...original, state: 'running', stage: 'mux',
    cancellationRequestedAt: new Date().toISOString(), error: { code: 'CANCELLED', message: 'Cancelled by operator' } }));
  const reopened = new JobService({ outputRoot, worker: complete });
  assert.equal(reopened.get(original.jobId).state, 'cancelled');
  assert.equal(reopened.get(original.jobId).stage, 'mux');
  const retry = reopened.retry(original.jobId, { requestId: 'again' });
  assert.throws(() => reopened.retry(retry.jobId, { requestId: 'bad' }), /failed|interrupted|cancelled/);
  await reopened.whenIdle(); assert.equal(reopened.get(retry.jobId).state, 'succeeded');
});

test('explicit retry joins the HomeBase FIFO without cancelling independent work', async t => {
  const entered = deferred(), release = deferred(), calls = [];
  const jobs = service(t, async ({ job, signal }) => {
    calls.push(job.requestId);
    if (job.requestId === 'failed') throw new Error('capture failed');
    if (job.requestId === 'active') { entered.resolve(); await release.promise; signal.throwIfAborted(); }
    return complete();
  }); t.after(() => release.resolve());
  const failed = jobs.submit(request('failed')); await jobs.whenIdle();
  const active = jobs.submit(request('active')); await entered.promise;
  jobs.submit(request('waiting'));
  const retry = jobs.retry(failed.jobId, { requestId: 'retry' });
  const other = jobs.submit(request('other', 'home-b'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(other.jobId).state, 'succeeded');
  assert.equal(jobs.get(retry.jobId).state, 'queued');
  jobs.cancel(active.jobId);
  assert.equal(jobs.get(retry.jobId).state, 'queued');
  release.resolve(); await jobs.whenIdle();
  assert.deepEqual(calls, ['failed', 'active', 'other', 'waiting', 'retry']);
  assert.equal(jobs.get(active.jobId).state, 'cancelled');
  assert.equal(jobs.get(retry.jobId).state, 'succeeded');
});

test('a real submitting client exits before the resident process completes and persists the job', { timeout: 15000 }, async t => {
  const outputRoot = root(t);
  const resident = fork(path.join(__dirname, 'fixtures/resident.cjs'), [outputRoot], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => resident.kill());
  let stderr = '';
  resident.stderr.on('data', data => { stderr += data; });
  const [ready] = await once(resident, 'message');
  assert.equal(ready.type, 'ready', stderr);
  const client = spawn(process.execPath, [path.join(__dirname, 'fixtures/client.cjs'), String(ready.port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  client.stdout.on('data', data => { output += data; });
  const [exitCode] = await once(client, 'exit');
  assert.equal(exitCode, 0);
  const accepted = JSON.parse(output);
  const before = await fetch(`http://127.0.0.1:${ready.port}/jobs/${accepted.jobId}`).then(r => r.json());
  assert.equal(before.state, 'running');
  const completed = once(resident, 'message');
  resident.send({ type: 'client-exited' });
  const [message] = await completed;
  assert.equal(message.type, 'completed', stderr);
  assert.equal(message.job.state, 'succeeded');
  assert.equal(message.job.jobId, accepted.jobId);
  const exited = once(resident, 'exit');
  resident.send({ type: 'shutdown' });
  const [residentExitCode] = await exited;
  assert.equal(residentExitCode, 0, stderr);
  const reopened = new JobService({ outputRoot, worker: async () => { throw new Error('must not replay'); } });
  assert.equal(reopened.get(accepted.jobId).state, 'succeeded');
  assert.equal(fs.readFileSync(path.join(reopened.get(accepted.jobId).artifactsDir, 'finished.txt'), 'utf8'), 'finished after client exit');
});
