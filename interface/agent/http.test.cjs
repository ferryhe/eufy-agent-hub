const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ScriptedModel, functionCall, assistantMessage, modelResponder } = require('@openai/agents/testing');
const { fixture, window } = require('./fixture.cjs');
const call = (name, args, id = name) => [functionCall(name, args, { callId: id })];
const lastOutput = request => {
  const item = request.input.filter(i => i.type === 'function_call_result').at(-1);
  return JSON.parse(typeof item.output === 'string' ? item.output : item.output.text);
};
async function setup(t, options) {
  const f = await fixture(options); t.after(() => f.close());
  const post = data => fetch(f.url + '/interface/agent/turn', { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const state = async () => (await fetch(f.url + '/interface/agent/state')).json();
  const until = async predicate => {
    for (let i = 0; i < 300; i++) { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Fixture state timed out');
  };
  return { f, post, state, until };
}
test('resident HTTP runs installed SDK at actual port, preserves text/locale and resumes one job across refresh/later turns', async t => {
  let receiptId, release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const model = new ScriptedModel([
    call('recording_ranges', window), modelResponder(({ request }) => { receiptId = lastOutput(request).id; return call('recording_export', { receiptId }); }),
    [assistantMessage('任务已提交。')], modelResponder(() => call('recording_export', { receiptId }, 'again')),
    [assistantMessage('继续查看同一任务。')],
  ]);
  const { f, post, state, until } = await setup(t, { model, gate, partial: true });
  try {
    const text = 'Export Synthetic camera 2026-08-27 16:30–16:31 America/Toronto';
    assert.equal((await post({ id: 'first', text, locale: 'zh-CN' })).status, 202);
    const submitted = await until(s => !s.busy && s.jobs.length === 1);
    assert.equal(submitted.turns[0].text, text); assert.equal(submitted.turns[0].response, '任务已提交。');
    assert.equal(submitted.jobs[0].status, 'running'); assert.equal(submitted.receipts[0].window.normalized.timezone, 'America/Toronto');
    const calls = model.calls.length;
    for (let i = 0; i < 4; i++) await state();
    assert.equal(model.calls.length, calls, 'snapshots never poll the model');
    const retry = await post({ id: 'first', text, locale: 'zh-CN' }); assert.equal((await retry.json()).reused, true);
    assert.equal(model.calls.length, calls);
    release(); const partial = await until(s => s.jobs[0]?.status === 'partial');
    assert.equal(partial.jobs[0].complete, false); assert.ok(partial.jobs[0].videos.length);
    assert.ok(partial.jobs[0].videos[0].url.startsWith(f.url));
    const media = await fetch(partial.jobs[0].videos[0].url, { headers: { Range: 'bytes=0-4' } }); assert.equal(media.status, 206);
    assert.equal((await post({ id: 'second', text: 'Please show that recording again', locale: 'en' })).status, 202);
    const continued = await until(s => s.turns.length === 2 && !s.busy);
    assert.equal(continued.jobs[0].job.jobId, submitted.jobs[0].job.jobId); assert.equal(f.calls.capture, 1);
    assert.match(model.firstCall.request.systemInstructions, /zh-CN/);
    assert.equal(model.firstCall.request.input.at(-1).content[0].text, text);
    model.assertComplete();
    const persisted = JSON.parse(fs.readFileSync(path.join(f.directory, 'interface.json')));
    assert.equal(persisted.origin, f.url); assert.equal(persisted.interface.turns.length, 2);
    assert.equal(JSON.stringify(persisted).includes('offline-only'), false);
  } finally { release(); }
});
test('disconnecting the observer leaves the resident turn running; another turn gets a visible conflict', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const model = new ScriptedModel([modelResponder(async () => { await gate; return [assistantMessage('Done')]; })]);
  const { post, state, until } = await setup(t, { model });
  try {
    const response = await post({ id: 'owned', text: 'Hello', locale: 'en' });
    await response.body.cancel();
    assert.equal((await state()).busy, true);
    const conflict = await post({ id: 'other', text: 'Hello again', locale: 'en' });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'TURN_BUSY');
    release(); assert.equal((await until(s => !s.busy)).turns[0].response, 'Done');
  } finally { release(); }
});
for (const [options, args, code] of [
  [{ loggedOut: true }, window, 'UNAUTHENTICATED'], [{ offline: true }, window, 'DEVICE_UNAVAILABLE'],
  [{ empty: true }, window, 'NO_RECORDING'], [{}, { ...window, start: '' }, 'CLARIFICATION_REQUIRED'],
  [{ devices: [{ device_sn: 'CAMERA001', device_name: 'Repeated' }, { device_sn: 'CAMERA002', device_name: 'Repeated' }] }, { ...window, device: 'Repeated' }, 'AMBIGUOUS_DEVICE'],
]) test(`HTTP structured ${code} survives refresh and cannot submit a job`, async t => {
  const model = new ScriptedModel([call('recording_ranges', args), [assistantMessage('Please check the recording details.')]]);
  const { post, until, state, f } = await setup(t, { ...options, model });
  await post({ id: 'clarify', text: `Export ${args.device}`, locale: 'en' });
  const done = await until(s => s.turns.length && !s.busy);
  assert.equal(done.turns[0].notices[0].error.code, code); assert.equal(done.jobs.length, 0); assert.equal(f.calls.capture, 0);
  assert.equal((await state()).turns[0].notices[0].error.code, code);
});
test('normal browsing and snapshots work without model configuration; credentials are not accepted by the chat adapter', async t => {
  const { post, state } = await setup(t, {});
  assert.equal((await state()).busy, false);
  const response = await post({ id: 'login', text: 'hello', locale: 'en', password: 'not-chat' });
  assert.equal(response.status, 400); assert.equal((await state()).turns.length, 0);
});
