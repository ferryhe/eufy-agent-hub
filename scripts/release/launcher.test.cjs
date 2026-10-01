const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { controlName, listenControl, requestControl, residentLogPath, spawnResident } = require('./launcher.cjs');

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

test('resident startup captures output and reports spawn failures through a real data-root log', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-resident-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = await spawnResident(root, {
    args: ['-e', `setTimeout(() => { console.log('fixture stdout'); console.error('fixture stderr'); }, 20)`],
    detached: false,
  });
  await once(started.child, 'close');
  const logFile = residentLogPath(root);
  assert.equal(started.logFile, logFile);
  assert.match(fs.readFileSync(logFile, 'utf8'), /fixture stdout[\s\S]*fixture stderr/);

  const missing = path.join(root, 'missing-node.exe');
  await assert.rejects(spawnResident(root, { executable: missing, args: [], detached: false }), error => {
    assert.match(error.message, /Resident spawn failed/);
    assert.match(error.message, new RegExp(logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  assert.match(fs.readFileSync(logFile, 'utf8'), /Resident spawn failed/);
});
