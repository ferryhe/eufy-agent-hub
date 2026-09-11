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

test('reopening unfinished jobs does not replay side effects or silently release their HomeBase', async t => {
  const gate = deferred();
  const outputRoot = root(t);
  const jobs = new JobService({ outputRoot, worker: async () => { await gate.promise; return complete(); } });
  const first = jobs.submit(request('first'));
  const second = jobs.submit(request('second'));
  await new Promise(resolve => setImmediate(resolve));
  let calls = 0;
  const reopened = new JobService({ outputRoot, worker: async () => { calls++; return complete(); } });
  assert.equal(reopened.get(first.jobId).state, 'running');
  assert.equal(reopened.get(second.jobId).state, 'queued');
  assert.equal(reopened.submit(request('first')).jobId, first.jobId);
  assert.throws(() => reopened.submit(request('third')), /unfinished/);
  await reopened.whenIdle();
  assert.equal(calls, 0);
  gate.resolve();
  await jobs.whenIdle();
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
