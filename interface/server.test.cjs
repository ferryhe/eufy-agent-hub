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
    fs.rmSync(outputRoot, { recursive: true, force: true });
    assert.equal(sessionClosed, true); assert.equal(recordingsClosed, true);
  });
  await new Promise(resolve => server.start(resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /eufy 录像提取/);
  const state = await fetch(origin + '/status'); assert.equal((await state.json()).phase, 'idle');
  const clips = await fetch(origin + '/recordings/status'); assert.deepEqual((await clips.json()).saved, []);
  const query = await fetch(origin + '/recordings/query', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(query.status, 401);
  const invalidLogin = await fetch(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(invalidLogin.status, 400);
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
