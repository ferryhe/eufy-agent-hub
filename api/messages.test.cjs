const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { messageI18n, serviceError, setMessage, errorBody } = require('./messages.cjs');
const { installRecordingRoutes } = require('./legacy-recording-routes.cjs');

test('known errors have additive metadata; unknown errors clear stale message metadata', () => {
  const known = serviceError('录像查询失败：7', 'service.recordings.queryFailed', { code: 7 });
  assert.deepEqual(errorBody(known), { error: '录像查询失败：7', errorI18n: { key: 'service.recordings.queryFailed', params: { code: 7 } } });
  const state = {};
  setMessage(state, known.message, known.i18n);
  setMessage(state, 'opaque upstream text');
  assert.deepEqual(state, { message: 'opaque upstream text' });
  assert.deepEqual(errorBody(new Error('opaque upstream text')), { error: 'opaque upstream text' });
});

test('service catalogs cover emitted keys with matching parameter placeholders', () => {
  const root = path.resolve(__dirname, '..');
  const en = require('../interface/i18n/service.en.json');
  const zh = require('../interface/i18n/service.zh-CN.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    const parameters = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(parameters(en[key]), parameters(zh[key]), key);
  }
  for (const filename of ['capabilities/auth/session.cjs', 'capabilities/recordings/events.cjs', 'capabilities/recordings/export.cjs', 'capabilities/recordings/time-window.cjs', 'api/legacy-recording-routes.cjs']) {
    const source = fs.readFileSync(path.join(root, filename), 'utf8');
    for (const match of source.matchAll(/['"](service\.[\w.]+)['"]/g)) assert.ok(en[match[1]], match[1]);
  }
});

test('recording HTTP errors and async statuses retain legacy fields and expose localization metadata', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-message-http-'));
  const session = { authenticated: false, state: { phase: 'idle' } };
  const recordings = { close() {}, async listWindow() { return []; } };
  const server = http.createServer((_req, res) => res.end('{}'));
  const installed = installRecordingRoutes(server, session, { recordings, outputRoot: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${origin}/recordings/query`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const unauthorized = await post({});
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: '请先登录。', errorI18n: messageI18n('service.auth.loginRequired') });
  session.authenticated = true;
  const invalid = await post({ serial: '' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: '请选择设备。', errorI18n: messageI18n('service.devices.select') });
  const query = { serial: 'TESTCAMERA', day: '2026-08-27', start: '16:30', end: '16:50' };
  assert.equal((await post(query)).status, 202);
  assert.equal(installed.state.message, '找到 0 段事件录像。此列表不代表完整连续录像。');
  assert.deepEqual(installed.state.messageI18n, messageI18n('service.recordings.found', { count: 0 }));
  recordings.listWindow = async () => { throw serviceError('录像查询失败：9', 'service.recordings.queryFailed', { code: 9 }); };
  assert.equal((await post(query)).status, 202);
  assert.deepEqual(installed.state.messageI18n, messageI18n('service.recordings.queryFailed', { code: 9 }));
  recordings.listWindow = async () => { throw new Error('unrecognized upstream failure'); };
  assert.equal((await post(query)).status, 202);
  assert.equal(installed.state.message, 'unrecognized upstream failure');
  assert.equal(Object.hasOwn(installed.state, 'messageI18n'), false);
});
