const test = require('node:test');
const assert = require('node:assert/strict');
const { startExportEvidence } = require('./continuous-export-evidence.cjs');

test('hardware runner waits for login then submits exactly the fixed camera/window and resolved HomeBase', async t => {
  const session = { authenticated: false, state: { phase: 'idle', devices: [] }, api: { getDevsListDecrypted: async () => ({ devices: [
    { device_name: 'Drive Way', device_model: 'T8600', device_sn: 'CAMERA', parent_sn: 'BASE' },
    { device_model: 'T8030', device_sn: 'BASE' },
  ] }) } };
  let submitted, calls = 0, ready;
  const url = new Promise(resolve => { ready = resolve; });
  const runner = startExportEvidence('fresh-fixed-window', { port: 0, session, onReady: ready, service: {
    submit(input) { calls++; submitted = input; return { jobId: 'job' }; },
    whenIdle: async () => {}, get: () => ({ state: 'failed', result: { outcome: 'partial' } }), shutdown: async () => {},
  } });
  t.after(runner.stop);
  const address = await url;
  assert.equal((await fetch(address)).status, 200); assert.equal(calls, 0);
  session.authenticated = true; session.state.phase = 'connected';
  const job = await runner.completion;
  assert.deepEqual(submitted, { requestId: 'fresh-fixed-window', serial: 'CAMERA', homeBaseId: 'BASE',
    day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'America/Toronto' });
  assert.equal(calls, 1); assert.equal(job.result.outcome, 'partial'); assert.equal(runner.server.listening, false);
});

test('hardware runner cancellation during inventory lookup cannot later submit', async () => {
  let waiting, release;
  const ready = new Promise(resolve => { waiting = resolve; });
  const session = { authenticated: true, state: { phase: 'connected', devices: [] }, api: { getDevsListDecrypted: async () => {
    waiting(); return new Promise(resolve => { release = resolve; });
  } } };
  const runner = startExportEvidence('cancelled-window', { port: 0, session, service: {
    submit: () => assert.fail('unexpected submission'), shutdown: async () => {},
  } });
  await ready; await runner.stop(); release({ devices: [] });
  await assert.rejects(runner.completion, /cancelled/);
});

test('hardware runner rejects reserved existing service port', () => {
  assert.throws(() => startExportEvidence('one', { port: 3187, service: {} }), /reserved/);
});
