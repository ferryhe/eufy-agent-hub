const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DeviceVerificationRepository } = require('../devices/verification-store.cjs');
const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

function verifiedRecord(proof) {
  const binding = proof?.privateBinding, publicBinding = proof?.binding, decode = proof?.sample?.fullDecode;
  const text = value => typeof value === 'string' && Boolean(value.trim());
  const firmware = value => value && text(value.main) && text(value.secondary);
  if (proof?.version !== 1 || proof.status !== 'completed' || proof.mode !== 'run' || proof.mediaSource !== 'current_bound_device'
    || !proof.cleanupComplete || !proof.stopConfirmed || !proof.stopIdempotent || !proof.requestIdempotent
    || !['protocolClosed','connectionClosed','decoderClosed','streamsClosed'].every(key => proof.resources?.[key] === true)
    || proof.sharedHomeBaseConflict?.code !== 'SERVICE_BUSY' || proof.sharedHomeBaseConflict?.preempted !== false
    || proof.sharedHomeBaseConflict?.operation !== 'continuous_export'
    || !decode?.passed || decode.fixture || !decode.childClosed || decode.exitCode !== 0
    || !Number.isInteger(proof.sample.frames) || proof.sample.frames < 2 || decode.decodedFrames !== proof.sample.frames
    || proof.media?.decodedFrames !== proof.sample.frames || !(proof.media.receivedBytes > 0) || !(proof.sample.bytes > 0)
    || !Number.isFinite(Date.parse(proof.observedAt)) || !text(binding?.serial) || !text(binding.homeBaseId)
    || !Number.isInteger(binding.channel) || binding.channel < 0 || binding.channel !== publicBinding?.channel
    || publicBinding.cameraModel !== 'T8600' || publicBinding.homeBaseModel !== 'T8030' || !publicBinding.inventoryMatched
    || publicBinding.deviceIdHash !== digest(binding.serial) || publicBinding.homeBaseIdHash !== digest(binding.homeBaseId)
    || !firmware(publicBinding.cameraFirmware) || !firmware(publicBinding.homeBaseFirmware)
    || !['start','stop'].every(operation => proof.operations?.some(row => row.operation === operation && row.returnCode === 0))) throw fail('HOST_PROOF_INVALID');
  return { capability: 'liveVideo', status: 'verified', reason: 'current_device_live_start_decoded_media_stop_cleanup_verified',
    scope: { serial: binding.serial, model: publicBinding.cameraModel, firmware: publicBinding.cameraFirmware,
      homeBase: { serial: binding.homeBaseId, model: publicBinding.homeBaseModel, firmware: publicBinding.homeBaseFirmware }, channel: binding.channel },
    evidence: [{ source: `issue10-bounded-live-host:${digest(JSON.stringify(proof))}`, observedAt: proof.observedAt,
      outcome: 'complete_start_media_full_decode_stop_cleanup_and_shared_homebase_conflict' }] };
}

function recordProof(env) {
  if (env.EUFY_LIVE_PROOF_ACCEPTED !== '1') throw fail('HOST_PROOF_NOT_ACCEPTED');
  const evidencePath = env.EUFY_LIVE_EVIDENCE_PATH, recordsPath = env.EUFY_CAPABILITY_RECORDS_PATH;
  const root = path.resolve(__dirname, '../..');
  for (const file of [evidencePath, recordsPath]) {
    if (!file || !path.isAbsolute(file)) throw fail('HOST_RECORD_FAILED');
    const relative = path.relative(root, file);
    if (!(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw fail('HOST_RECORD_FAILED');
  }
  if (path.resolve(evidencePath).toLowerCase() === path.resolve(recordsPath).toLowerCase()) throw fail('HOST_RECORD_FAILED');
  let proof;
  try { proof = JSON.parse(fs.readFileSync(evidencePath, 'utf8')); } catch { throw fail('HOST_PROOF_INVALID'); }
  const record = verifiedRecord(proof);
  new DeviceVerificationRepository(recordsPath).record(record);
  return { version: 1, status: 'completed', mode: 'record-proof', hardwareVerified: true, capabilityUpdated: true,
    capability: 'liveVideo', scopeHash: digest(JSON.stringify(record.scope)), observedAt: proof.observedAt };
}

module.exports = { verifiedRecord, recordProof };
