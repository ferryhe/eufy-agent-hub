const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');
async function setup(options = {}) {
  const { createI18n } = await import('../i18n/i18n.mjs');
  const { createResults } = await import('../components/results.mjs');
  const { mountWorkspace } = await import('../workspace/workspace.mjs');
  const { document, window } = parseHTML(fs.readFileSync(path.join(__dirname, '../pages/local-login.html'), 'utf8'));
  // linkedom exposes a read-only select.value; supply the browser's writable boundary.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { writable: true, value: 'auto' });
  const i18n = createI18n({ catalogs: Object.fromEntries(['en', 'zh-CN'].map(locale => [locale,
    JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/ui.${locale}.json`)))])) });
  const source = fs.readFileSync(path.join(__dirname, 'sidebar.mjs'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
  const mountSidebar = new Function('createResults', 'mountWorkspace', source + '; return mountSidebar;')(createResults, mountWorkspace);
  const stored = options.stored || new Map();
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const state = { turns: [], receipts: [], jobs: [], notices: [], busy: false };
  const sent = []; let lost = false;
  const fakeFetch = async (url, options) => {
    if (options?.method === 'POST') {
      sent.push(JSON.parse(options.body)); if (lost) throw new Error('Response lost');
      const body = sent.at(-1); state.turns.push({ ...body, state: 'running', notices: [] }); state.busy = true;
      return Response.json({ id: body.id });
    }
    return Response.json(url.includes('/state') ? state : { devices: [] });
  };
  let initialized;
  const ready = new Promise(resolve => { initialized = resolve; });
  const fetch = async (url, request) => {
    const response = await (options.fetch || fakeFetch)(url, request);
    if (url === '/api/v1/devices') initialized();
    return response;
  };
  const sidebar = mountSidebar({ document, window: { crypto: { randomUUID: () => `id-${sent.length}` }, setInterval: () => 1, clearInterval() {} }, i18n, fetch, storage });
  await ready;
  await new Promise(resolve => setImmediate(resolve));
  return { sidebar, state, sent, document, window, stored, i18n, lose(value) { lost = value; } };
}
test('sidebar sends original text with an independent locale, keeps mode switching reversible and recovers a lost POST identity', async () => {
  const h = await setup(), el = id => h.document.getElementById(id);
  el('response-language').value = 'zh-CN'; el('response-language').dispatchEvent(new h.window.Event('change'));
  const text = 'Export Front Door 2026-08-27 16:30–16:31'; el('agent-message').value = text;
  h.lose(true); await h.sidebar.send(); assert.match(el('agent-status').textContent, /Local service unavailable/);
  h.lose(false); await h.sidebar.send();
  assert.equal(h.sent.length, 2); assert.deepEqual(h.sent[1], h.sent[0]);
  assert.equal(h.sent[0].locale, 'zh-CN'); assert.equal(h.sent[0].text, text);
  assert.equal(h.i18n.locale, 'en'); assert.equal(el('agent-send').disabled, true);
  el('mode-agent').click(); assert.equal(el('agent-sidebar').hidden, false); assert.equal(el('recordings').hidden, true);
  el('mode-fixed').click(); assert.equal(el('agent-sidebar').hidden, true); assert.equal(el('recordings').hidden, false);
  assert.equal(h.state.turns.length, 1);
  h.state.busy = false; h.state.turns[0].state = 'completed'; h.state.turns[0].response = '已提交'; await h.sidebar.poll();
  assert.match(el('agent-history').textContent, /已提交/); assert.equal(el('agent-send').disabled, false);
});

for (const recovery of ['poll', 'refresh', 'success', 'poll-before-loss']) for (const edited of [false, true]) {
  test(`accepted turn ${recovery} clears only its matching draft (edited=${edited}) through resident SDK`, async t => {
    const { ScriptedModel, assistantMessage } = require('@openai/agents/testing');
    const { fixture } = require('./fixture.cjs');
    const model = new ScriptedModel([[assistantMessage('Which date?')]]);
    const f = await fixture({ model }); t.after(() => f.close());
    let release, accepted;
    const gate = new Promise(resolve => { release = resolve; });
    const confirmed = new Promise(resolve => { accepted = resolve; });
    t.after(() => release());
    const posted = [];
    const api = async (url, options) => {
      if (options?.method !== 'POST') return fetch(f.url + url, options);
      posted.push(JSON.parse(options.body));
      const response = await fetch(f.url + url, { ...options, headers: { ...options.headers, Origin: f.url } });
      await response.clone().text(); accepted(); await gate;
      if (recovery !== 'success') throw new Error('Accepted response lost');
      return response;
    };
    let h = await setup({ fetch: api });
    const write = text => { const input = h.document.getElementById('agent-message'); input.value = text; input.dispatchEvent(new h.window.Event('input')); };
    write('Export Synthetic camera');
    const sending = h.sidebar.send(); await confirmed;
    if (edited) write('New unsent request 原文');
    if (recovery === 'poll-before-loss') await h.sidebar.poll();
    release(); await sending;
    // Wait for the real root SDK turn, without sending another model request.
    for (let i = 0; i < 300; i++) {
      const state = await (await fetch(f.url + '/interface/agent/state')).json();
      if (!state.busy) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (recovery === 'refresh') { h.sidebar.stop(); h = await setup({ fetch: api, stored: h.stored }); }
    else await h.sidebar.poll();
    const expected = edited ? 'New unsent request 原文' : '';
    assert.equal(h.document.getElementById('agent-message').value, expected);
    assert.equal(h.stored.get('eufy-agent-hub.draft'), expected);
    assert.equal(h.stored.get('eufy-agent-hub.pendingTurn'), 'null');
    assert.doesNotMatch(h.document.getElementById('agent-status').textContent, /unavailable/);
    if (!edited) await h.sidebar.send();
    assert.equal(posted.length, 1); assert.equal(model.calls.length, 1);
    assert.equal((await (await fetch(f.url + '/interface/agent/state')).json()).turns.length, 1);
  });
}

test('real job lookup notice uses the selected interface language', async t => {
  const { ScriptedModel, functionCall, assistantMessage } = require('@openai/agents/testing');
  const { fixture } = require('./fixture.cjs');
  const model = new ScriptedModel([[functionCall('job_get', { jobId: 'mistyped-job-id' }, { callId: 'lookup' })], [assistantMessage('请核对任务编号。')]]);
  const f = await fixture({ model }); t.after(() => f.close());
  await fetch(f.url + '/interface/agent/turn', { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'lookup', text: '请查找录像任务 mistyped-job-id', locale: 'zh-CN' }) });
  for (let i = 0; i < 300; i++) {
    const state = await (await fetch(f.url + '/interface/agent/state')).json();
    if (!state.busy) { assert.equal(state.turns[0].notices[0].error.code, 'JOB_NOT_FOUND'); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const h = await setup({ fetch: (url, options) => fetch(f.url + url, options) });
  h.i18n.setPreference('zh-CN'); h.sidebar.render();
  assert.equal(h.document.getElementById('agent-notices').textContent, '未找到任务，请核对任务编号。');
  h.i18n.setPreference('en'); h.sidebar.render();
  assert.equal(h.document.getElementById('agent-notices').textContent, 'Task not found. Check the task ID.');
});

test('unchanged polling preserves conversation nodes', async () => {
  const h = await setup(), el = id => h.document.getElementById(id);
  h.state.turns.push({ id: 'one', text: 'hello', response: 'Which camera?', state: 'completed' });
  await h.sidebar.poll(); const message = el('agent-history').firstElementChild;
  await h.sidebar.poll(); assert.ok(el('agent-history').firstElementChild === message, 'unchanged messages must keep their DOM identity');
});
test('normal-login navigation targets the visible challenge', async () => {
  const h = await setup(), el = id => h.document.getElementById(id);
  let focused, scrolled;
  for (const id of ['login', 'email', 'code', 'status']) {
    el(id).focus = () => { focused = id; }; el(id).scrollIntoView = () => { scrolled = id; };
  }
  el('login').hidden = true; el('verify').hidden = false;
  el('agent-login').click(); assert.equal(focused, 'code'); assert.equal(scrolled, 'code');
});
