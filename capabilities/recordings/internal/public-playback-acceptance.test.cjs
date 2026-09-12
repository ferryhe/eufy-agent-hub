const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OUTPUT } = require('../continuous-export.cjs');
const { DeviceVerificationRepository } = require('../../devices/verification-store.cjs');
const { runPublicAcceptance, createDryRunRuntime, main } = require('./public-playback-acceptance.cjs');

function fixture(t, options = {}) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'issue9-public-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createDryRunRuntime(options), repository = new DeviceVerificationRepository(path.join(directory, 'verification.json'));
  const wire = [], evidence = [];
  const fetchImpl = async (url, init) => { wire.push({ path: new URL(url).pathname, body: init?.body && JSON.parse(init.body) }); return fetch(url, init); };
  return { runtime, repository, wire, evidence, run: () => runPublicAcceptance({ runtime, repository, fetchImpl,
    scratchDir: path.join(directory, 'scratch'), evidenceSource: 'fixture-public-evidence.json',
    saveEvidence: result => { if (options.evidenceError) throw new Error('private-write-error'); evidence.push(structuredClone(result)); } }) };
}

test('formal acceptance uses real HTTP endpoints on one resident owner and only persists after full speed1 close', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.recorded, true);
  assert.deepEqual(f.runtime.calls.commands, [0, 1, 2, 3]);
  assert.equal(f.runtime.calls.restore, 1); assert.equal(f.runtime.calls.maxOwners, 1);
  assert.equal(f.runtime.calls.connected, 0); assert.equal(f.runtime.calls.serviceClose, 2);
  assert.equal(f.runtime.calls.logout, 0); assert.equal(result.serverClosed, true);
  assert.equal(f.runtime.calls.queries.length, 3);
  assert.equal(f.runtime.calls.queries[0].end - f.runtime.calls.queries[0].begin, 43200);
  assert.equal(f.runtime.calls.queries[1].end - f.runtime.calls.queries[1].begin, 43200);
  assert.equal(f.runtime.calls.queries[1].begin, f.runtime.calls.queries[0].end);
  assert.equal(f.runtime.calls.queries[2].end - f.runtime.calls.queries[2].begin, 60);
  const actions = f.wire.filter(row => row.path.includes('playback-sessions'));
  assert.deepEqual(actions.map(row => row.path.split('/').at(-1)), ['playback-sessions', 'pause', actions[2].path.split('/').at(-1), 'resume', 'close']);
  assert.deepEqual(actions[0].body.speed, 1);
  for (const row of actions.filter(row => /\/(pause|resume|close)$/.test(row.path))) assert.deepEqual(row.body, {});
  const record = f.repository.read().records[0];
  assert.deepEqual(record.controls, { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1] });
  assert.equal(record.evidence.length, 1); assert.equal(f.evidence.length, 1);
  assert.equal(result.pauseWindow.elapsedMs, 6000);
  assert.equal(result.channelIsolation, 'unverified');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(f.evidence).includes('private-'), false);
});

for (const options of [{ reject: 1 }, { noReply: 1 }, { advancePause: true }, { closeError: true }, { evidenceError: true }])
  test(`formal acceptance failure ${JSON.stringify(options)} closes and leaves verification unchanged`, async t => {
    const f = fixture(t, options), result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.recorded, false);
    assert.deepEqual(f.repository.read().records, []);
    assert.equal(result.serverClosed, true); assert.equal(f.runtime.calls.connected, 0);
    assert.equal(f.runtime.calls.logout, 0); assert.equal(JSON.stringify(result).includes('private-'), false);
    if (options.reject || options.noReply || options.advancePause) assert.equal(f.runtime.calls.commands.includes(2), false);
  });

for (const [index, field] of [[0, 'main_sw_version'], [0, 'sec_sw_version'], [1, 'main_sw_version'], [1, 'sec_sw_version'], [1, 'device_channel']])
test(`current acceptance verifies only speed1 with changed ${index}/${field}`, async t => {
  const f = fixture(t); f.runtime.inventory.devices[index][field] = field === 'device_channel' ? 2 : 'new-firmware';
  const result = await f.run(); assert.equal(result.status, 'completed');
  assert.deepEqual(f.repository.read().records[0].controls.verifiedStartSpeeds, [1]);
  assert.equal(result.excludedSpeeds['2'], 'historical_complete_scope_missing');
  assert.equal(result.excludedSpeeds['4'], 'historical_serial_scope_missing');
  assert.equal(result.excludedSpeeds['16'], 'historical_serial_scope_missing');
  assert.equal(result.excludedSpeeds['8'], 'completion_unconfirmed');
});

for (const changed of ['camera', 'homebase', 'both']) test(`same firmware and channel cannot promote old speeds for a different ${changed} serial`, async t => {
  const f = fixture(t), [base, camera] = f.runtime.inventory.devices;
  if (changed !== 'camera') { base.device_sn = 'different-private-base'; camera.parent_sn = base.device_sn; }
  if (changed !== 'homebase') camera.device_sn = 'different-private-camera';
  const create = f.runtime.createService;
  f.runtime.createService = () => {
    const service = create();
    service.station.getSerial = () => base.device_sn;
    service.camera.getSerial = () => camera.device_sn;
    service.camera.getStationSerial = () => base.device_sn;
    return service;
  };
  const result = await f.run(); assert.equal(result.status, 'completed');
  const record = f.repository.read().records[0];
  assert.equal(record.scope.serial, camera.device_sn); assert.equal(record.scope.homeBase.serial, base.device_sn);
  assert.deepEqual(record.controls.verifiedStartSpeeds, [1]);
  assert.deepEqual(result.verifiedStartSpeeds, [1]);
  assert.equal(record.evidence.length, 1); assert.equal(Object.hasOwn(result, 'historicalEvidence'), false);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('ambiguous target fails before any playback or verification', async t => {
  const f = fixture(t); f.runtime.inventory.devices.push({ ...f.runtime.inventory.devices[1] });
  const result = await f.run(); assert.equal(result.error.code, 'HOST_TARGET_AMBIGUOUS');
  assert.deepEqual(f.runtime.calls.commands, []); assert.deepEqual(f.repository.read().records, []);
});
test('missing retained minute closes the selection owner without starting HTTP playback', async t => {
  const f = fixture(t, { noRanges: true }), result = await f.run();
  assert.equal(result.error.code, 'HOST_RECORDING_UNAVAILABLE');
  assert.equal(f.runtime.calls.connected, 0); assert.equal(f.runtime.calls.serviceClose, 1);
  assert.deepEqual(f.runtime.calls.commands, []); assert.deepEqual(f.repository.read().records, []);
});
test('failed acceptance preserves existing verification bytes without a temporary verified record', async t => {
  const f = fixture(t, { reject: 1 });
  const scope = require('../../devices/capabilities.cjs').queryDevice(f.runtime.inventory.devices, 'private-camera').verificationScope;
  f.repository.record({ scope, capability: 'continuousPlaybackControls', status: 'protocol_hint', reason: 'existing_fixture', evidence: [] });
  const before = fs.readFileSync(f.repository.path, 'utf8');
  await f.run(); assert.equal(fs.readFileSync(f.repository.path, 'utf8'), before);
});
test('a final record-write failure retains completed HTTP evidence but never claims verification was written', async t => {
  const f = fixture(t); f.repository.record = () => { throw new Error('private-record-error'); };
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(result.error.stage, 'record');
  assert.equal(result.recorded, false); assert.deepEqual(f.repository.read().records, []);
  assert.equal(f.evidence[0].status, 'completed');
  assert.equal(f.evidence[0].verificationWrite, 'separate_following_atomic_step');
});

test('CLI is fixed and missing paths never construct a runtime or read a session', async () => {
  let created = 0;
  for (const argv of [[], ['--run'], ['--run-public-speed1', '--speed', '2'], ['--run-public-speed1']]) {
    const result = await main({ argv, env: {}, createRuntime: () => { created++; throw new Error('unreachable'); } });
    assert.equal(result.status, 'failed');
  }
  assert.equal(created, 0);
});

test('fixed run CLI validates fresh distinct paths before runtime and persists only after its fake HTTP acceptance', async t => {
  const f = fixture(t), directory = path.dirname(f.repository.path);
  const sessionPath = path.join(directory, 'fixture-session.private.json'), evidencePath = path.join(directory, 'fixture-evidence.json');
  fs.writeFileSync(sessionPath, 'offline fixture, never parsed');
  const env = { EUFY_SESSION_PATH: sessionPath, ISSUE9_PROBE_EVIDENCE_PATH: evidencePath, EUFY_CAPABILITY_RECORDS_PATH: f.repository.path };
  let created = 0; const createRuntime = value => { assert.equal(value, sessionPath); created++; return f.runtime; };
  assert.equal((await main({ argv: ['--run-public-speed1'], env: { ...env, ISSUE9_PROBE_EVIDENCE_PATH: sessionPath }, createRuntime })).status, 'failed');
  assert.equal(created, 0);
  const result = await main({ argv: ['--run-public-speed1'], env, createRuntime });
  assert.equal(result.status, 'completed'); assert.equal(result.recorded, true); assert.equal(created, 1);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), 'offline fixture, never parsed');
  assert.equal(JSON.parse(fs.readFileSync(evidencePath, 'utf8')).verificationWrite, 'separate_following_atomic_step');
  assert.deepEqual(f.repository.read().records[0].controls.verifiedStartSpeeds, [1]);
  assert.equal((await main({ argv: ['--run-public-speed1'], env, createRuntime })).status, 'failed');
  assert.equal(created, 1, 'Existing evidence stops the second invocation before restore');
});

test('dry-run ignores real path variables and crosses the actual HTTP wire using only fake devices', async () => {
  const result = await main({ argv: ['--dry-run'], env: { EUFY_SESSION_PATH: 'must-not-read', ISSUE9_PROBE_EVIDENCE_PATH: 'must-not-write' } });
  assert.equal(result.status, 'completed'); assert.equal(result.mode, 'dry_run'); assert.equal(result.recorded, false);
  assert.deepEqual(result.operations.map(row => row.operation), ['start', 'pause', 'resume', 'stop']);
  assert.deepEqual(result.verifiedStartSpeeds, [1]);
});
test('standalone dry-run exits cleanly after its HTTP handles close', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'public-playback-acceptance.cjs'), '--dry-run'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'completed');
});

for (const rejected of [false, true]) test(`standalone acceptance exits with two retained UDP handles after durable ${rejected ? 'failure' : 'success'} output`, t => {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(OUTPUT, 'issue9-public-exit-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = path.join(__dirname, 'public-playback-acceptance.cjs');
  const sessionPath = path.join(directory, 'fixture-session.private.json');
  const evidencePath = path.join(directory, 'evidence.json'), recordsPath = path.join(directory, 'records.json');
  const preload = path.join(directory, 'retained-udp.cjs');
  fs.writeFileSync(sessionPath, 'offline fixture, never parsed');
  fs.writeFileSync(preload, `
    const Module = require('node:module');
    const { createDryRunRuntime } = require(${JSON.stringify(entry)});
    delete require.cache[require.resolve(${JSON.stringify(entry)})];
    const runtime = createDryRunRuntime(${JSON.stringify(rejected ? { reject: 1 } : {})});
    const auth = ${JSON.stringify(require.resolve('../../auth/session.cjs'))};
    const continuous = ${JSON.stringify(require.resolve('../continuous.cjs'))};
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent);
      if (resolved === auth) return { LocalEufySession: function () { return runtime.session; } };
      if (resolved === continuous) return { LocalContinuousRecordings: function () { return runtime.createService(); } };
      return load.call(this, request, parent, isMain);
    };
    // Protocol close can leave both dedicated owners' UDP handles alive.
    // They never send data and deliberately remain referenced after HTTP close.
    for (let i = 0; i < 2; i++) require('node:dgram').createSocket('udp4').bind(0, '127.0.0.1');
  `);
  const child = spawnSync(process.execPath, ['--require', preload, entry, '--run-public-speed1'], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, EUFY_SESSION_PATH: sessionPath,
      ISSUE9_PROBE_EVIDENCE_PATH: evidencePath, EUFY_CAPABILITY_RECORDS_PATH: recordsPath },
  });
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, rejected ? 'failed' : 'completed');
  assert.equal(result.recorded, !rejected);
  assert.equal(result.ownerClosed, true); assert.equal(result.serverClosed, true);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(evidence.status, result.status);
  assert.equal(evidence.verificationWrite, rejected ? 'not_attempted' : 'separate_following_atomic_step');
  if (rejected) assert.equal(fs.existsSync(recordsPath), false);
  else {
    const records = new DeviceVerificationRepository(recordsPath).read().records;
    assert.deepEqual(records[0].controls.verifiedStartSpeeds, [1]);
    assert.equal(records[0].evidence[0].source, 'evidence.json');
    assert.deepEqual(result.operations.map(row => [row.operation, row.returnCode]),
      [['start', 0], ['pause', 0], ['resume', 0], ['stop', 0]]);
  }
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), 'offline fixture, never parsed');
  assert.equal(child.stdout.includes('private-'), false);
  assert.equal(child.error, undefined, 'Completed output must not leave the CLI hanging until killed');
  assert.equal(child.status, rejected ? 1 : 0, child.stderr);
});
