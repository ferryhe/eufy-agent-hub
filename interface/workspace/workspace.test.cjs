const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
async function setup(stored = new Map(), fetch = async () => Response.json({})) {
  const { createI18n } = await import('../i18n/i18n.mjs');
  const { mountWorkspace } = await import('./workspace.mjs');
  const { document } = parseHTML('<html><body><p id="workspace-status"></p><div id="workspace-views"></div></body></html>');
  const i18n = createI18n({ catalogs: Object.fromEntries(['en', 'zh-CN'].map(locale => [locale,
    JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/ui.${locale}.json`)))])) });
  const workspace = mountWorkspace({ document, i18n, fetch, storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, onChange: async () => {} });
  return { workspace, document, i18n, stored, cards: () => [...document.querySelector('#workspace-views').children] };
}
const window = { input: { day: '2026-08-27', start: '16:30', end: '16:31' }, normalized: { start: '2026-08-27T20:30:00Z', end: '2026-08-27T20:31:00Z', timezone: 'America/Toronto' } };
function data() {
  const job = { jobId: 'job-1', serial: 'CAMERA001', stage: 'capture', progress: .2, window };
  return {
    state: { presentation: { version: 1, views: [
      { type: 'device-list', deviceIds: ['CAMERA001'] }, { type: 'timeline', receiptId: 'receipt-1' },
      { type: 'player', jobId: 'job-1', artifactId: 'video-1' }, { type: 'job-card', jobId: 'job-1' },
    ] }, receipts: [{ id: 'receipt-1', serial: 'CAMERA001', device: { name: '原始 camera' }, window, ranges: [{ start: window.normalized.start, end: window.normalized.end }] }],
    jobs: [{ job, status: 'running', videos: [{ id: 'video-1', name: '原始.mp4', outcome: 'partial', url: '/api/v1/jobs/job-1/artifacts/video-1' }] }] },
    inventory: { devices: [{ serial: 'CAMERA001', name: '原始 camera', model: 'T8600' }] },
  };
}
test('contract admits four reference views, strips snapshots/code and isolates unusable siblings', async () => {
  const { descriptor, presentation } = await import('./contract.mjs');
  assert.deepEqual(descriptor({ type: 'player', jobId: 'a', artifactId: 'b', url: 'stale', status: 'succeeded', code: '<script>' }), { type: 'player', jobId: 'a', artifactId: 'b' });
  const h = await setup(), { state, inventory } = data();
  state.presentation.views.splice(1, 0, { type: 'unknown-future', code: '<script>' }, { type: 'timeline' }, null, { type: 'device-list', deviceIds: 'bad' });
  h.workspace.update(state, inventory);
  assert.equal(h.cards().length, 8); assert.equal(h.document.querySelectorAll('video').length, 2);
  assert.match(h.document.body.textContent, /cannot be displayed/);
  assert.equal(h.document.querySelector('script'), null);
  h.i18n.setPreference('zh-CN'); h.workspace.render();
  assert.match(h.document.body.textContent, /无法展示此结果/); assert.match(h.document.body.textContent, /原始 camera/);
  assert.deepEqual(presentation({ version: 2, views: [] }), [{ type: 'unknown' }]);
});
test('pin/unpin and order restore references, rehydrate current data and retain playing nodes through polls/reorder/locale', async () => {
  const h = await setup(), { state, inventory } = data(); h.workspace.update(state, inventory);
  for (const card of h.cards()) card.querySelector('button').click();
  const video = h.document.querySelector('[data-type="player"] video'); video.currentTime = 1.2;
  h.cards()[2].querySelectorAll('button')[1].click();
  const expectedOrder = h.cards().map(c => c.dataset.type);
  h.workspace.update(structuredClone(state), structuredClone(inventory));
  h.i18n.setPreference('zh-CN'); h.workspace.render();
  assert.equal(h.document.querySelector('[data-type="player"] video'), video); assert.equal(video.currentTime, 1.2);
  const saved = JSON.parse(h.stored.get('eufy-agent-hub.workspace'));
  assert.deepEqual(saved.views.map(v => v.type), expectedOrder);
  assert.doesNotMatch(JSON.stringify(saved), /原始|20:30|running|\.mp4|url/);
  const restored = await setup(h.stored); restored.workspace.update({}, undefined);
  assert.match(restored.document.body.textContent, /not available yet/);
  assert.deepEqual(restored.workspace.jobIds(), ['job-1']);
  inventory.devices[0].name = 'Current name'; state.jobs[0].status = 'partial'; state.jobs[0].job.progress = 1;
  restored.workspace.update(state, inventory);
  assert.deepEqual(restored.cards().map(c => c.dataset.type), expectedOrder);
  assert.match(restored.document.body.textContent, /Current name/); assert.match(restored.document.body.textContent, /Partial/);
  restored.cards()[0].querySelector('button').click();
  assert.equal(JSON.parse(h.stored.get('eufy-agent-hub.workspace')).views.length, 3);
});
test('missing devices, receipts, jobs and artifacts recover on later snapshots, with service failures visible', async () => {
  const h = await setup(), { state, inventory } = data(); h.workspace.update(state, inventory);
  const missing = { ...state, receipts: [], jobs: [{ jobId: 'job-1', error: { code: 'JOB_NOT_FOUND' } }] };
  h.workspace.update(missing, { devices: [] }, { code: 'SERVICE_UNAVAILABLE' });
  assert.match(h.document.getElementById('workspace-status').textContent, /unavailable/);
  assert.equal(h.document.querySelectorAll('video').length, 0);
  assert.match(h.document.body.textContent, /Task not found/);
  h.workspace.update(state, inventory);
  assert.equal(h.document.getElementById('workspace-status').textContent, ''); assert.equal(h.document.querySelectorAll('video').length, 2);
  assert.match(h.document.body.textContent, /20:30:00Z/); assert.match(h.document.body.textContent, /America\/Toronto/);
});
test('a new Agent composition orders unpinned references while retaining pins and video identity', async () => {
  const h = await setup(), { state, inventory } = data(); h.workspace.update(state, inventory);
  h.cards()[0].querySelector('button').click();
  const video = h.document.querySelector('[data-type="player"] video');
  state.presentation.views.reverse(); h.workspace.update(state, inventory);
  assert.deepEqual(h.cards().map(c => c.dataset.type), ['device-list', 'job-card', 'player', 'timeline']);
  assert.equal(h.document.querySelector('[data-type="player"] video'), video);
});
test('timeline action sends its stable receipt and player downloads use the registered artifact', async () => {
  let sent; const h = await setup(new Map(), async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return Response.json({}); });
  const { state, inventory } = data(); h.workspace.update(state, inventory);
  h.document.querySelector('.timeline-card button').click(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, { url: '/interface/agent/export', body: { receiptId: 'receipt-1' } });
  assert.equal(h.document.querySelector('[data-type="player"] a').href, state.jobs[0].videos[0].url + '?download');
});

test('installed SDK composes all four views through resident HTTP; pinned references restore after restart and history loss', async t => {
  const { ScriptedModel, functionCall, assistantMessage, modelResponder } = require('@openai/agents/testing');
  const { fixture, window: input } = require('../agent/fixture.cjs');
  const fetch = (url, options) => globalThis.fetch(url, { ...options, headers: { ...options?.headers, Connection: 'close' } });
  const directory = fs.mkdtempSync(path.join(__dirname, '../../output/eufy-workspace-'));
  let f, receiptId, jobId;
  t.after(async () => { if (f) await f.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (name, args) => [functionCall(name, args, { callId: `${name}-${Math.random()}` })];
  const output = request => { const item = request.input.filter(i => i.type === 'function_call_result').at(-1); return JSON.parse(typeof item.output === 'string' ? item.output : item.output.text); };
  const model = new ScriptedModel([
    call('devices_list', {}), call('recording_ranges', input),
    modelResponder(({ request }) => { receiptId = output(request).id; return call('recording_export', { receiptId }); }),
    modelResponder(async ({ request }) => {
      jobId = output(request).job.jobId;
      // The test waits using HTTP, never asking the model to poll repeatedly.
      for (let i = 0; i < 300; i++) {
        const state = await (await fetch(f.url + '/interface/agent/state')).json();
        if (state.jobs[0]?.videos.length) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return call('job_artifacts', { jobId });
    }),
    modelResponder(({ request }) => {
      const artifactId = output(request).videos[0].id;
      const view = value => ({ type: '', deviceIds: null, receiptId: null, jobId: null, artifactId: null, ...value });
      return call('workspace_present', { version: 1, views: [view({ type: 'player', jobId, artifactId }),
        view({ type: 'device-list', deviceIds: ['CAMERA001'] }), view({ type: 'timeline', receiptId }),
        view({ type: 'job-card', jobId }), view({ type: 'future-card' })] });
    }), [assistantMessage('已组合原始结果。')],
  ]);
  f = await fixture({ directory, model, partial: true });
  const post = (route, body) => fetch(f.url + route, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/interface/agent/turn', { id: 'composed', text: 'Export Synthetic camera 2026-08-27 16:30–16:31 America/Toronto', locale: 'zh-CN' });
  let state;
  for (let i = 0; i < 300; i++) {
    state = await (await fetch(f.url + '/interface/agent/state')).json();
    if (!state.busy) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.turns[0].state, 'completed', JSON.stringify(state.turns[0])); model.assertComplete();
  assert.deepEqual(state.presentation.views.map(v => v.type), ['player', 'device-list', 'timeline', 'job-card', 'future-card']);
  const h = await setup(); h.workspace.update(state, await (await fetch(f.url + '/api/v1/devices')).json());
  for (const card of h.cards()) card.querySelector('button').click();
  h.cards()[3].querySelectorAll('button')[1].click();
  assert.match(h.document.body.textContent, /cannot be displayed/); assert.equal(h.document.querySelectorAll('video').length, 2);
  const originalVideo = h.document.querySelector('video').src;
  const beforeCalls = model.calls.length;
  const repeated = await Promise.all([post('/interface/agent/export', { receiptId }), post('/interface/agent/export', { receiptId })]);
  for (const response of repeated) assert.equal((await response.json()).job.jobId, jobId);
  assert.equal(f.calls.capture, 1); assert.equal(model.calls.length, beforeCalls);
  const missing = await post('/interface/agent/export', { receiptId: 'missing' }); assert.equal((await missing.json()).error.code, 'NORMALIZATION_REQUIRED');
  const invalid = await post('/interface/agent/export', { receiptId, serial: 'other' }); assert.equal(invalid.status, 400);
  const port = new URL(f.url).port;
  await f.close(); f = undefined;
  // Durable jobs survive separately from conversation history and login.
  fs.rmSync(path.join(directory, 'interface.json'));
  f = await fixture({ directory, port: Number(port), loggedOut: true });
  const restored = await setup(h.stored);
  const query = new URLSearchParams(restored.workspace.jobIds().map(id => ['jobId', id]));
  const fresh = await (await fetch(f.url + '/interface/agent/state?' + query)).json();
  assert.equal(fresh.turns.length, 0); assert.equal(fresh.receipts.length, 0); assert.equal(fresh.jobs[0].job.jobId, jobId);
  assert.equal(fresh.jobs[0].status, 'partial');
  restored.workspace.update(fresh, await (await fetch(f.url + '/api/v1/devices')).json());
  assert.equal(restored.document.querySelector('video').src, originalVideo);
  assert.match(restored.document.body.textContent, /not available yet/);
  assert.equal(restored.cards().filter(c => c.querySelector('button').getAttribute('aria-pressed') === 'true').length, 5);
  const unavailable = await (await fetch(f.url + '/interface/agent/state?jobId=gone')).json();
  assert.equal(unavailable.jobs[0].jobId, 'gone'); assert.equal(unavailable.jobs[0].error.code, 'JOB_NOT_FOUND');
});

for (const failure of ['provider failure', 'run timeout']) test(`accepted SDK export stays visible after ${failure}, polling and page refresh`, async t => {
  const { ScriptedModel, functionCall, assistantMessage, modelResponder } = require('@openai/agents/testing');
  const { fixture, window: input } = require('../agent/fixture.cjs');
  let release, receiptId;
  const gate = new Promise(resolve => { release = resolve; });
  const call = (name, args) => [functionCall(name, args, { callId: name })];
  const view = value => ({ type: '', deviceIds: null, receiptId: null, jobId: null, artifactId: null, ...value });
  const model = new ScriptedModel([
    call('workspace_present', { version: 1, views: [view({ type: 'device-list' }), view({ type: 'future-card' })] }),
    [assistantMessage('Devices shown.')], call('recording_ranges', input),
    modelResponder(({ request }) => {
      const result = request.input.filter(i => i.type === 'function_call_result').at(-1);
      receiptId = JSON.parse(typeof result.output === 'string' ? result.output : result.output.text).id;
      return call('recording_export', { receiptId });
    }),
    modelResponder(async ({ request }) => {
      if (failure === 'provider failure') throw new Error('Synthetic model failure after export acceptance');
      request.signal.throwIfAborted();
      await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      return [assistantMessage('Unreachable after timeout')];
    }),
  ]);
  const f = await fixture({ model, gate, partial: true, runTimeoutMs: 1000 });
  t.after(async () => { release(); await f.close(); });
  const post = (route, body) => fetch(f.url + route, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const state = async () => (await fetch(f.url + '/interface/agent/state')).json();
  const settled = async () => {
    for (let i = 0; i < 300; i++) { const value = await state(); if (!value.busy) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Resident turn did not settle');
  };
  await post('/interface/agent/turn', { id: 'prior', text: 'Show devices.', locale: 'en' });
  const prior = await settled(), inventory = await (await fetch(f.url + '/api/v1/devices')).json();
  const h = await setup(); h.workspace.update(prior, inventory);
  for (const card of h.cards()) card.querySelector('button').click();
  h.cards()[1].querySelectorAll('button')[1].click();
  const pins = h.stored.get('eufy-agent-hub.workspace');
  await post('/interface/agent/turn', { id: 'export', text: 'Export Synthetic camera 2026-08-27 16:30–16:31 America/Toronto', locale: 'en' });
  const failed = await settled();
  assert.equal(failed.turns[1].state, 'failed'); assert.equal(failed.turns[1].error.code, 'AGENT_FAILED');
  assert.equal(failed.jobs.length, 1); assert.equal(failed.jobs[0].status, 'running');
  const jobId = failed.jobs[0].job.jobId;
  for (let i = 0; i < 3; i++) {
    h.workspace.update(await state(), inventory);
    assert.equal(h.document.querySelector(`[data-job="${jobId}"]`)?.dataset.job, jobId, 'accepted export must have a visible job card without another model call');
  }
  assert.deepEqual(failed.presentation.views.slice(0, 2), prior.presentation.views);
  assert.equal(h.stored.get('eufy-agent-hub.workspace'), pins);
  const reloaded = await setup(h.stored); reloaded.workspace.update(await state(), inventory);
  assert.deepEqual(reloaded.cards().map(c => c.dataset.type), ['future-card', 'device-list', 'job-card']);
  assert.equal(reloaded.document.querySelector('[data-job]').dataset.job, jobId);
  const repeated = await (await post('/interface/agent/export', { receiptId })).json();
  assert.equal(repeated.job.jobId, jobId);
  assert.equal((await state()).presentation.views.filter(v => v.type === 'job-card').length, 1);
  assert.equal(f.calls.capture, 1); assert.equal(model.calls.length, 5);
  model.assertComplete();
});
