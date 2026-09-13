const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./server.cjs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('local HTTP server serves the migrated page on its configured port without a cloud login', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-server-test-'));
  let sessionClosed = false, recordingsClosed = false;
  const session = {
    authenticated: false, state: { phase: 'idle', devices: [] },
    login: () => assert.fail('smoke test must not log in'), close: () => { sessionClosed = true; },
  };
  const recordings = { close: () => { recordingsClosed = true; } };
  const server = createServer({ port: 0, session, recordings, outputRoot });
  assert.equal(server.listening, false);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await server.shutdown();
    fs.rmSync(outputRoot, { recursive: true, force: true });
    assert.equal(sessionClosed, true); assert.equal(recordingsClosed, true);
  });
  await new Promise(resolve => server.start(resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /data-i18n="ui.title"/);
  for (const script of ['i18n.mjs', 'local-login.mjs', 'results.mjs', 'sidebar.mjs', 'workspace.mjs', 'contract.mjs']) {
    const response = await fetch(origin + '/assets/' + script);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(origin + '/components/results.mjs')).status, 200);
  const english = await (await fetch(origin + '/locales/en.json')).json();
  const chinese = await (await fetch(origin + '/locales/zh-CN.json')).json();
  assert.equal(english['ui.login'], 'Sign in'); assert.equal(chinese['ui.login'], '登录');
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  assert.equal((await fetch(origin + '/locales/fr.json')).status, 404);
  const state = await fetch(origin + '/status'); assert.equal((await state.json()).phase, 'idle');
  const clips = await fetch(origin + '/recordings/status'); assert.deepEqual((await clips.json()).saved, []);
  const query = await fetch(origin + '/recordings/query', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(query.status, 401);
  const invalidLogin = await fetch(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalidLogin.status, 400);
  assert.deepEqual(await invalidLogin.json(), {
    error: '请填写邮箱、密码和两位国家代码。', errorI18n: { key: 'ui.error.credentials', params: {} },
  });
  const foreignOrigin = await fetch(origin + '/refresh', { method: 'POST', headers: { Origin: 'http://127.0.0.1:1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreignOrigin.status, 403);
});

test('standalone signal shutdown exits despite a retained protocol UDP handle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-shutdown-test-'));
  const preload = path.join(directory, 'retained-udp.cjs');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Emit the signal event inside the child so the same handlers are exercised
  // on Windows, where child.kill() otherwise forcibly terminates the process.
  fs.writeFileSync(preload, `
    const http = require('node:http');
    const socket = require('node:dgram').createSocket('udp4');
    const ready = new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once('listening', async () => {
        await ready;
        console.log('retained UDP handle ready');
        process.emit(process.env.EUFY_TEST_SIGNAL);
      });
      return listen.apply(this, args);
    };
  `);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--require', preload, path.join(__dirname, 'server.cjs')], {
      env: { ...process.env, EUFY_PORT: '0', EUFY_TEST_SIGNAL: signal }, timeout: 5000,
    });
    assert.match(stdout, /retained UDP handle ready/);
  }
});

test('built React app supports deep links without intercepting resident API, legacy, or media routes', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-react-route-test-'));
  const session = { authenticated: false, state: { phase: 'idle', devices: [], diagnostics: [] }, login() {}, close() {} };
  const recordings = { close() {} };
  const server = createServer({ port: 0, session, recordings, outputRoot });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.shutdown(); fs.rmSync(outputRoot, { recursive: true, force: true }); });
  await new Promise(resolve => server.start(resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/app/', '/app/recordings/retained-item', '/app/settings']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /id="root"/);
  }
  const app = await (await fetch(origin + '/app/')).text();
  const asset = /src="(\/app\/assets\/[^\"]+\.js)"/.exec(app)?.[1];
  assert.ok(asset, 'Vite entry asset is present');
  assert.match((await fetch(origin + asset)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(origin + '/')).status, 200, 'legacy root still works');
  assert.equal((await fetch(origin + '/status')).status, 200, 'legacy status remains reachable');
  assert.equal((await fetch(origin + '/api/v1/contract')).status, 200, 'v1 contract is not intercepted');
  assert.equal((await fetch(origin + '/api/v1/jobs/no-such-job/artifacts/no-such-artifact')).status, 404, 'v1 media/artifact routing is not intercepted');
});

test('React auth client contract has resident HTTP transitions and keeps rejected verification visible in tfa', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-react-auth-test-'));
  const calls = [];
  const session = {
    authenticated: false,
    state: { phase: 'login_required', devices: [], diagnostics: [], message: 'Please sign in.' },
    isAuthenticated() { return this.authenticated; },
    async login(data) { calls.push(data); this.state = { phase: 'tfa', devices: [], diagnostics: [], message: 'Email code sent.' }; },
    async verify(code) { if (code === 'wrong') { this.state = { phase: 'tfa', devices: [], diagnostics: ['The code was rejected.'], message: 'Verification code is incorrect.' }; return; } this.authenticated = true; this.state = { phase: 'connected', devices: [{ serial: 'fixture-camera' }], diagnostics: [], message: 'Connected.' }; },
    async refresh() { this.state = { ...this.state, diagnostics: ['Inventory temporarily unavailable.'], message: 'Inventory refresh failed.' }; },
    logout() { this.authenticated = false; this.state = { phase: 'login_required', devices: [], diagnostics: [], message: 'Signed out.' }; }, close() {},
  };
  const server = createServer({ port: 0, session, recordings: { close() {} }, outputRoot: root });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  await new Promise(resolve => server.start(resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(origin + '/api/v1/contract')).status, 200);
  assert.equal((await post('/api/v1/session/login', { email: 'fixture@example.test', password: 'secret-not-persisted', country: 'CA' })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await fetch(origin + '/api/v1/session')).json()).phase, 'tfa');
  assert.equal((await post('/api/v1/session/verify', { code: 'wrong' })).status, 202); await new Promise(resolve => setImmediate(resolve));
  const rejected = await (await fetch(origin + '/status')).json(); assert.equal(rejected.phase, 'tfa'); assert.match(rejected.message, /incorrect/i); assert.match(rejected.diagnostics[0], /rejected/i);
  await post('/api/v1/session/verify', { code: '123456' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await fetch(origin + '/api/v1/session')).json()).authenticated, true);
  await post('/api/v1/session/refresh', {}); await new Promise(resolve => setImmediate(resolve));
  assert.match((await (await fetch(origin + '/status')).json()).diagnostics[0], /Inventory/);
  await post('/api/v1/session/logout', {}); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await (await fetch(origin + '/api/v1/session')).json()).authenticated, false);
  assert.equal(calls[0].password, 'secret-not-persisted');
  assert.equal(fs.existsSync(path.join(root, 'session.json')), false, 'fixture credentials were never persisted');
});
