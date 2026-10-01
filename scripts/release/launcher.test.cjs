const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { controlName, listenControl, requestControl } = require('./launcher.cjs');

test('control owner is exclusive and validates the per-instance token', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = controlName(root), token = 'fixture-token';
  const owner = await listenControl(name, token, async command => ({ state: command === 'status' ? 'ready' : 'stopped' }));
  t.after(() => new Promise(resolve => owner.close(resolve)));
  await assert.rejects(listenControl(name, 'second', async () => ({})), error => error.code === 'EADDRINUSE');
  assert.deepEqual(await requestControl(name, token, 'status'), { state: 'ready' });
  await assert.rejects(requestControl(name, 'wrong-token', 'status'), /CONTROL_UNAUTHORIZED/);
});
