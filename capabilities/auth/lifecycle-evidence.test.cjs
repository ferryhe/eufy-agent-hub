const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLifecycleEvidence } = require('./lifecycle-evidence.cjs');
const { LocalEufySession } = require('./session.cjs');

test('acceptance runner uses normal HTTP login, fresh sessions, restoration, logout and sanitized evidence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-evidence-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let logins = 0, restored = 0, created = 0;
  const token = { cloud_token: 'PRIVATE_TOKEN', user_id: 'PRIVATE_USER', cloud_token_expiration: Date.now() / 1000 + 3600 };
  const runner = await startLifecycleEvidence({ directory, port: 0,
    createSession: sessionPath => new LocalEufySession(() => {
      created++; let valid = false;
      return { init: async () => {}, estimateDomain: async () => {},
        login: async () => { logins++; valid = true; return { code: 0 }; },
        exportSession: () => token, restoreSession: () => { restored++; valid = true; },
        hasValidSession: () => valid,
        getDevsListDecrypted: async () => ({ devices: [{ device_sn: 'PRIVATE_SERIAL' }] }) };
    }, { sessionPath }),
    onReady: origin => {
      fetch(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'private@example.invalid', password: 'PRIVATE_PASSWORD', country: 'CA' }) }).catch(() => {});
    },
  });
  const report = await runner.completion;
  assert.equal(report.complete, true); assert.equal(report.restart.result, 'restored');
  assert.equal(report.newDeviceRequest.status, 401);
  assert.equal(logins, 1); assert.equal(restored, 1); assert.equal(created, 2);
  const saved = fs.readFileSync(runner.reportPath, 'utf8');
  assert.ok(!saved.includes('PRIVATE')); assert.ok(!saved.includes('private@example'));
  assert.equal(fs.existsSync(path.join(directory, 'session.json')), false);
});

test('acceptance runner refuses old service port and in-worktree evidence before starting a service', async () => {
  await assert.rejects(startLifecycleEvidence({ directory: os.tmpdir(), port: 3187 }), /3187/);
  await assert.rejects(startLifecycleEvidence({ directory: path.resolve(__dirname, '../../output/evidence') }), /outside/);
});
