const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const moduleRoot = process.env.EUFY_PACKAGE_ROOT || path.resolve(__dirname, '../..');
const { importVerification } = require(path.join(moduleRoot, 'scripts/release/import-verification.cjs'));
const { DeviceVerificationRepository } = require(path.join(moduleRoot, 'capabilities/devices/verification-store.cjs'));

const record = (serial = 'camera', firmware = 'camera-fw') => ({
  scope: { serial, model: 'T8600', firmware: { main: firmware, secondary: null },
    homeBase: { serial: 'base', model: 'T8030', firmware: { main: 'base-fw', secondary: null } }, channel: 1 },
  capability: 'continuousPlaybackControls', status: 'verified', reason: 'fixture',
  evidence: [{ source: 'offline fixture', observedAt: '2026-09-30', outcome: 'passed' }],
  controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1] },
});
const reordered = value => ({
  controls: { verifiedStartSpeeds: [...value.controls.verifiedStartSpeeds], pauseResumeAtSpeed1: value.controls.pauseResumeAtSpeed1 },
  evidence: value.evidence.map(item => ({ outcome: item.outcome, observedAt: item.observedAt, source: item.source })),
  reason: value.reason, status: value.status, capability: value.capability,
  scope: { channel: value.scope.channel,
    homeBase: { firmware: { secondary: value.scope.homeBase.firmware.secondary, main: value.scope.homeBase.firmware.main },
      model: value.scope.homeBase.model, serial: value.scope.homeBase.serial },
    firmware: { secondary: value.scope.firmware.secondary, main: value.scope.firmware.main },
    model: value.scope.model, serial: value.scope.serial },
});

test('explicit legacy import validates exact records and never overwrites silently', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.json'), destination = path.join(root, 'data', 'verification.json');
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [record()], reachability: [] }));
  assert.deepEqual(importVerification(source, destination), { imported: 1, skipped: 0 });
  assert.deepEqual(importVerification(source, destination), { imported: 0, skipped: 1 });
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [{ ...record(), reason: 'conflict' }], reachability: [] }));
  assert.throws(() => importVerification(source, destination), /nothing was imported/);
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [record('camera', 'changed')], reachability: [] }));
  assert.deepEqual(importVerification(source, destination), { imported: 1, skipped: 0 });
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [{ ...record(), status: 'made-up' }] }));
  assert.throws(() => importVerification(source, destination), /Invalid device verification store/);
  assert.equal(new DeviceVerificationRepository(destination).read().records.length, 2);
});

test('reordered JSON keys preserve semantic identity and cannot bypass conflict detection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-import-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy.json'), destination = path.join(root, 'data', 'verification.json');
  const original = record();
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [original], reachability: [] }));
  assert.deepEqual(importVerification(source, destination), { imported: 1, skipped: 0 });
  const before = fs.readFileSync(destination, 'utf8');
  fs.writeFileSync(source, JSON.stringify({ reachability: [], records: [reordered(original)], version: 1 }));
  assert.deepEqual(importVerification(source, destination), { imported: 0, skipped: 1 });
  assert.equal(fs.readFileSync(destination, 'utf8'), before);
  fs.writeFileSync(source, JSON.stringify({ version: 1, records: [reordered({ ...original, reason: 'incoming-different' })], reachability: [] }));
  assert.throws(() => importVerification(source, destination), /nothing was imported/);
  assert.equal(fs.readFileSync(destination, 'utf8'), before);
  assert.equal(JSON.parse(before).records[0].reason, 'fixture');
});
