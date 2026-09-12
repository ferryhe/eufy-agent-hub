const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { main, runLiveHost, createDryRunRuntime, preflight } = require('./host.cjs');
const binding = { serial: 'fixture-camera', homeBaseId: 'fixture-base', channel: 1 };

test('dry-run uses only fixtures and proves v1 media, full sample decode, conflicts and resource closure', async () => {
  const proof = await main({ argv: ['--dry-run'], env: new Proxy({}, { get() { assert.fail('dry-run must not read private environment'); } }),
    checkPaths: () => assert.fail('dry-run must not inspect private files'), writeEvidence: () => assert.fail('dry-run must not write evidence') });
  assert.equal(proof.status, 'completed'); assert.equal(proof.mode, 'dry-run'); assert.equal(proof.hardwareVerified, false);
  assert.equal(proof.sample.fullDecode.passed, true); assert.equal(proof.sample.fullDecode.fixture, true);
  assert.equal(proof.stopConfirmed, true); assert.equal(proof.cleanupComplete, true);
  assert.ok(Object.values(proof.resources).every(Boolean)); assert.equal(proof.sharedHomeBaseConflict.code, 'SERVICE_BUSY');
  assert.equal(proof.mediaSource, 'protocol_and_decoder_fixture');
  assert.equal(JSON.stringify(proof).includes('fixture-camera'), false); assert.equal(JSON.stringify(proof).includes('fixture-base'), false);
});

test('host refuses invalid arguments and missing explicit stopped-owner declaration before runtime', async t => {
  let created = 0;
  for (const argv of [[], ['--run','extra'], ['--retry'], ['--login']]) {
    assert.equal((await main({ argv, createRuntime: () => { created++; } })).error.code, 'HOST_ARGUMENTS_INVALID');
  }
  assert.equal((await main({ argv: ['--run'], env: {}, createRuntime: () => { created++; } })).error.code, 'HOST_PREFLIGHT_FAILED');
  assert.equal(created, 0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-live-preflight-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic-session.json'); fs.writeFileSync(file, '{}');
  const env = { EUFY_SESSION_PATH: file, EUFY_LIVE_EVIDENCE_PATH: path.join(directory, 'proof.json'),
    EUFY_LIVE_DEVICE_SERIAL: binding.serial, EUFY_LIVE_HOMEBASE_SERIAL: binding.homeBaseId, EUFY_LIVE_CHANNEL: '1' };
  assert.throws(() => preflight(env), { code: 'HOST_PREFLIGHT_FAILED' });
  env.EUFY_LIVE_RESIDENT_STOPPED = '1'; preflight(env);
  assert.throws(() => preflight({ ...env, EUFY_LIVE_EVIDENCE_PATH: file }), { code: 'HOST_PREFLIGHT_FAILED' });
  assert.throws(() => preflight({ ...env, EUFY_LIVE_EVIDENCE_PATH: path.resolve(__dirname, 'private.json') }), { code: 'HOST_PREFLIGHT_FAILED' });
});

test('missing or ambiguous inventory targets and changed owner/channel never create live media', async () => {
  for (const mode of ['missing', 'ambiguous', 'channel', 'owner']) {
    const runtime = createDryRunRuntime(); let created = false;
    runtime.liveOptions.createConnection = () => { created = true; assert.fail('must refuse before connection'); };
    if (mode === 'missing') runtime.raw.pop();
    if (mode === 'ambiguous') runtime.raw.push({ ...runtime.raw[1] });
    const requested = { ...binding, ...(mode === 'channel' ? { channel: 2 } : mode === 'owner' ? { homeBaseId: 'other' } : {}) };
    const proof = await runLiveHost({ runtime, binding: requested, durationMs: 1000 });
    assert.equal(proof.status, 'failed'); assert.equal(proof.error.code, 'HOST_BINDING_MISMATCH'); assert.equal(created, false);
  }
});

test('real-mode entry writes exact association only to the private evidence sink', async () => {
  let saved;
  const proof = await main({ argv: ['--run'], env: { EUFY_LIVE_DEVICE_SERIAL: binding.serial,
    EUFY_LIVE_HOMEBASE_SERIAL: binding.homeBaseId, EUFY_LIVE_CHANNEL: '1', EUFY_LIVE_EVIDENCE_PATH: 'private-evidence' },
    createRuntime: dryRun => { assert.equal(dryRun, false); return createDryRunRuntime(); }, checkPaths: () => {},
    writeEvidence: (_file, evidence) => { saved = evidence; } });
  assert.equal(proof.status, 'completed'); assert.deepEqual(saved.privateBinding, binding);
  assert.equal(proof.privateBinding, undefined); assert.equal(proof.hardwareVerified, false);
});

test('a failed complete-sample decode remains a failed result after successful resource cleanup', async () => {
  const runtime = createDryRunRuntime(); runtime.decodeSample = async () => ({ passed: false, childClosed: true });
  const proof = await runLiveHost({ runtime, binding, durationMs: 1000 });
  assert.equal(proof.status, 'failed'); assert.equal(proof.error.code, 'HOST_PROOF_INCOMPLETE'); assert.equal(proof.cleanupComplete, true);
});

test('help and record-proof preflight never construct a session or contact hardware', async () => {
  const help = await main({ argv: ['--help'], env: {}, createRuntime: () => assert.fail() });
  assert.equal(help.mode, 'help'); assert.ok(help.commands.includes('--record-proof'));
  const result = await main({ argv: ['--record-proof'], env: {}, createRuntime: () => assert.fail() });
  assert.equal(result.error.code, 'HOST_PROOF_NOT_ACCEPTED');
});

test('real runtime restores the supplied existing session once without login or deleting a failed session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-live-restore-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, 'synthetic-session.json');
  const saved = JSON.stringify({ version: 1, country: 'CA', session: { cloud_token: 'synthetic-token', user_id: 'synthetic-user', cloud_token_expiration: 9999999999 } });
  fs.writeFileSync(sessionPath, saved);
  const { createRealRuntime } = require('./host.cjs');
  for (const valid of [true, false]) {
    const runtime = createRealRuntime(sessionPath); let restored = 0;
    runtime.session.createApi = () => ({ init: async () => {}, restoreSession: () => { restored++; }, hasValidSession: () => valid,
      login: () => assert.fail('no login'), getDevsListDecrypted: async () => ({ devices: [] }) });
    await runtime.session.restore();
    assert.equal(restored, 1); assert.equal(runtime.session.isAuthenticated(), valid); assert.equal(fs.readFileSync(sessionPath, 'utf8'), saved);
  }
});

test('configured synthetic video exercises the entire host and full-decode evidence with actual FFmpeg',
  { skip: !process.env.EUFY_FFMPEG }, async () => {
    const { spawn } = require('node:child_process'), { createDecoder } = require('./decoder.cjs');
    const runtime = createDryRunRuntime(); delete runtime.decodeSample;
    runtime.liveOptions.createDecoder = options => {
      const decoder = createDecoder(options);
      const producer = spawn(process.env.EUFY_FFMPEG, ['-hide_banner','-nostdin','-loglevel','error','-re',
        '-f','lavfi','-i','testsrc2=size=320x240:rate=15','-t','8','-c:v','libx264','-preset','ultrafast',
        '-tune','zerolatency','-g','15','-f','h264','pipe:1'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      producer.stderr.resume(); producer.stdout.pipe(options.video); producer.on('error', options.onError);
      const closed = new Promise(resolve => producer.once('close', resolve));
      return { async close() { producer.stdout.unpipe(options.video); producer.kill(); await closed; await decoder.close(); } };
    };
    const proof = await runLiveHost({ runtime, binding, durationMs: 1000 });
    assert.equal(proof.status, 'completed', JSON.stringify(proof.error)); assert.equal(proof.cleanupComplete, true);
    assert.ok(proof.sample.frames >= 2); assert.equal(proof.sample.fullDecode.decodedFrames, proof.sample.frames);
    assert.equal(proof.sample.fullDecode.passed, true); assert.equal(proof.sample.fullDecode.childClosed, true);
    assert.equal(proof.hardwareVerified, false);
  });
