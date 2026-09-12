const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeviceVerificationRepository } = require('./verification-store.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-device-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'devices', 'verification.json');
  return { directory, file, repository: new DeviceVerificationRepository(file) };
}
function record(capability = 'continuousRecordingQuery', status = 'verified') {
  return { scope: { serial: 'test-camera', model: 'T8600', firmware: { main: '1', secondary: null },
    homeBase: { serial: 'test-base', model: 'T8030', firmware: { main: '2', secondary: null } }, channel: 0 },
  capability, status, reason: 'fixture-observation',
  evidence: [{ source: 'offline-fixture', observedAt: '2026-09-11', outcome: 'partial' }] };
}

test('missing store starts empty and incremental updates survive reopen without dropping other firmware or capabilities', t => {
  const f = fixture(t);
  assert.deepEqual(f.repository.read(), { version: 1, records: [], reachability: [] });
  f.repository.record(record());
  f.repository.record(record('liveVideo', 'unsupported'));
  const older = record(); older.scope.firmware.main = 'old-version';
  f.repository.record(older);
  const reopened = new DeviceVerificationRepository(f.file);
  reopened.record(record('continuousRecordingQuery', 'unknown'));
  const saved = f.repository.read();
  assert.equal(saved.records.length, 3);
  assert.equal(saved.records.find(item => item.capability === 'liveVideo').status, 'unsupported');
  assert.equal(saved.records.find(item => item.scope.firmware.main === 'old-version').status, 'verified');
  assert.equal(saved.records.find(item => item.scope.firmware.main === '1' && item.capability === 'continuousRecordingQuery').status, 'unknown');
  saved.records[0].evidence[0].source = 'changed';
  assert.equal(reopened.read().records[0].evidence[0].source, 'offline-fixture');
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['verification.json']);
});

test('dated reachability writes preserve capability records and replace only the observed device', t => {
  const f = fixture(t); f.repository.record(record());
  const observation = { serial: 'test-camera', status: 'offline', reason: 'observed_connection_failure', observedAt: '2026-09-11' };
  f.repository.observeReachability(observation);
  f.repository.observeReachability({ ...observation, serial: 'test-base' });
  f.repository.observeReachability({ ...observation, status: 'online' });
  const saved = new DeviceVerificationRepository(f.file).read();
  assert.equal(saved.records.length, 1);
  assert.equal(saved.reachability.length, 2);
  assert.equal(saved.reachability.find(item => item.serial === 'test-camera').status, 'online');
});

test('invalid writes fail explicitly and preserve the previous durable evidence', t => {
  const f = fixture(t); f.repository.record(record());
  const original = fs.readFileSync(f.file, 'utf8');
  for (const change of [
    { status: 'supported' }, { evidence: [] }, { scope: { serial: 'test-camera' } },
    { evidence: [{ source: 'fixture', observedAt: 'not-a-date', outcome: 'partial' }] },
    { extra: 'not-in-contract' },
  ]) {
    assert.throws(() => f.repository.record({ ...record(), ...change }));
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  }
  assert.throws(() => f.repository.observeReachability({ serial: 'test-camera', status: 'offline', reason: 'failure', observedAt: 'bad-date' }));
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('invalid JSON, schema, evidence and unusable paths never silently reset the store', t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.file));
  for (const content of ['not-json', JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [{ ...record(), status: 'supported' }] }),
    JSON.stringify({ version: 1, records: [{ ...record(), evidence: [] }] }),
    JSON.stringify({ version: 1, records: [], reachability: [{ serial: 'test-camera', status: 'offline', reason: 'failure', observedAt: 'bad-date' }] }),
  ]) {
    fs.writeFileSync(f.file, content);
    assert.throws(() => f.repository.read());
    assert.throws(() => f.repository.record(record()));
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
  }
  assert.throws(() => new DeviceVerificationRepository('').read(), /path/i);
  assert.throws(() => new DeviceVerificationRepository(f.directory).read());
});
