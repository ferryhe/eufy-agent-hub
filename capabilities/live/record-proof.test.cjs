const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifiedRecord, recordProof } = require('./record-proof.cjs');
const { DeviceVerificationRepository } = require('../devices/verification-store.cjs');
const { queryDevice } = require('../devices/capabilities.cjs');
const { DeviceType } = require('../../adapters/eufy');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0,16);
function proofFixture() {
  return { version: 1, status: 'completed', mode: 'run', mediaSource: 'current_bound_device', observedAt: '2026-09-12T00:00:00Z',
    cleanupComplete: true, stopConfirmed: true, stopIdempotent: true, requestIdempotent: true,
    resources: { protocolClosed: true, connectionClosed: true, decoderClosed: true, streamsClosed: true },
    sharedHomeBaseConflict: { code: 'SERVICE_BUSY', preempted: false, operation: 'continuous_export' },
    media: { decodedFrames: 3, receivedBytes: 500 }, sample: { frames: 3, bytes: 300,
      fullDecode: { passed: true, decodedFrames: 3, childClosed: true, exitCode: 0 } },
    privateBinding: { serial: 'synthetic-camera', homeBaseId: 'synthetic-base', channel: 1 },
    binding: { channel: 1, deviceIdHash: digest('synthetic-camera'), homeBaseIdHash: digest('synthetic-base'), inventoryMatched: true,
      cameraModel: 'T8600', homeBaseModel: 'T8030', cameraFirmware: { main: 'c1', secondary: 'c2' }, homeBaseFirmware: { main: 'b1', secondary: 'b2' } },
    operations: [{ operation: 'start', returnCode: 0 }, { operation: 'stop', returnCode: 0 }] };
}

test('recording an explicitly accepted complete proof persists only the exact live scope', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-live-record-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, 'synthetic-proof.json'), recordsPath = path.join(directory, 'synthetic-records.json');
  fs.writeFileSync(evidence, JSON.stringify(proofFixture()));
  const env = { EUFY_LIVE_EVIDENCE_PATH: evidence, EUFY_CAPABILITY_RECORDS_PATH: recordsPath };
  assert.throws(() => recordProof(env), { code: 'HOST_PROOF_NOT_ACCEPTED' }); assert.equal(fs.existsSync(recordsPath), false);
  env.EUFY_LIVE_PROOF_ACCEPTED = '1';
  const result = recordProof(env); assert.equal(result.hardwareVerified, true); assert.equal(result.capabilityUpdated, true);
  assert.equal(JSON.stringify(result).includes('synthetic-camera'), false);
  recordProof(env); const snapshot = new DeviceVerificationRepository(recordsPath).read(); assert.equal(snapshot.records.length, 1);
  const raw = [{ device_sn: 'synthetic-base', device_model: 'T8030', device_type: DeviceType.HB3, main_sw_version: 'b1', sec_sw_version: 'b2' },
    { device_sn: 'synthetic-camera', parent_sn: 'synthetic-base', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247,
      device_channel: 1, main_sw_version: 'c1', sec_sw_version: 'c2' }];
  const verified = queryDevice(raw, 'synthetic-camera', snapshot);
  assert.equal(verified.capabilities.liveVideo.status, 'verified');
  assert.equal(verified.capabilities.talkback.status, 'unknown'); assert.equal(verified.capabilities.rtsp.status, 'unknown');
  raw[1].main_sw_version = 'next-firmware';
  assert.equal(queryDevice(raw, 'synthetic-camera', snapshot).capabilities.liveVideo.status, 'protocol_hint');
});

test('dry-run, fixture, partial and unconfirmed proofs cannot become verified records', () => {
  const variants = [proof => { proof.mode = 'dry-run'; }, proof => { proof.mediaSource = 'protocol_and_decoder_fixture'; },
    proof => { proof.sample.fullDecode.fixture = true; }, proof => { proof.status = 'failed'; },
    proof => { proof.sample.fullDecode.passed = false; }, proof => { proof.sample.fullDecode.decodedFrames = 2; },
    proof => { proof.stopConfirmed = false; }, proof => { proof.resources.decoderClosed = false; },
    proof => { proof.resources.protocolClosed = false; }, proof => { proof.cleanupComplete = false; },
    proof => { proof.sharedHomeBaseConflict.code = 'OTHER'; }, proof => { proof.binding.cameraFirmware.main = null; },
    proof => { proof.privateBinding.channel = 2; }, proof => { proof.privateBinding.serial = 'different'; }];
  for (const change of variants) {
    const proof = proofFixture(); change(proof); assert.throws(() => verifiedRecord(proof), { code: 'HOST_PROOF_INVALID' });
  }
});
