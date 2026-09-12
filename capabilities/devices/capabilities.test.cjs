const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceType } = require('../../adapters/eufy');
const { describeDevices, queryDevice, queryCapability, recordCapability } = require('./capabilities.cjs');

const base = { device_sn: 'test-base', device_model: 'T8030', device_type: DeviceType.HB3,
  main_sw_version: 'base-1', sec_sw_version: 'base-radio-1', local_ip: '192.0.2.1' };
const camera = { device_sn: 'test-camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247,
  parent_sn: base.device_sn, device_channel: 1, main_sw_version: 'camera-1', sec_sw_version: 'camera-radio-1', status: 0 };
const inventory = [base, camera];
const evidence = { source: 'test-fixture', observedAt: '2026-09-11T00:00:00Z', outcome: 'partial' };
const observation = (capability, status = 'verified') => ({
  scope: queryDevice(inventory, camera.device_sn).verificationScope,
  capability, status, reason: 'tested_partial_capture', evidence: [{ ...evidence }],
});

test('projection retains associations, firmware and uninterpreted inventory state', () => {
  const device = queryDevice(inventory, camera.device_sn);
  assert.equal(device.homeBaseId, base.device_sn);
  assert.equal(device.channel, 1);
  assert.deepEqual(device.firmware, { main: 'camera-1', secondary: 'camera-radio-1' });
  assert.deepEqual(device.verificationScope.homeBase.firmware, { main: 'base-1', secondary: 'base-radio-1' });
  assert.equal(device.state.inventoryStatus, 0);
  assert.equal(device.availability, 'unknown');
  assert.equal(device.state.reason, 'inventory_does_not_prove_reachability');
  assert.equal(device.recordingExport.supported, true);
  assert.equal(device.recordingExport.status, 'protocol_hint');
  assert.equal(device.capabilities.continuousRecordingQuery.status, 'protocol_hint');
  assert.equal(device.capabilities.rtsp.status, 'unknown');
  assert.equal(queryDevice(inventory, 'missing'), null);
});

test('playback execution requires typed controls in an exact fully known verified scope', () => {
  const { playbackControls } = require('./capabilities.cjs');
  const record = { ...observation('continuousPlaybackControls'),
    controls: { pauseResumeAtSpeed1: true, verifiedStartSpeeds: [1, 2, 4, 16] } };
  assert.deepEqual(playbackControls(queryDevice(inventory, camera.device_sn)), { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] });
  assert.deepEqual(playbackControls(queryDevice(inventory, camera.device_sn, { records: [observation('continuousPlaybackControls')] })),
    { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] });
  assert.deepEqual(playbackControls(queryDevice(inventory, camera.device_sn, { records: [record] })), record.controls);
  for (const changed of [[base, { ...camera, device_channel: 2 }], [base, { ...camera, sec_sw_version: null }],
    [{ ...base, main_sw_version: 'changed' }, camera], [base, { ...camera, device_sn: 'other' }]]) {
    assert.deepEqual(playbackControls(describeDevices(changed, { records: [record] })[1]), { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] });
  }
  for (const invalid of [{ ...record, controls: { ...record.controls, verifiedStartSpeeds: [8] } },
    { ...record, status: 'protocol_hint' }, { ...record, capability: 'liveVideo' }]) assert.throws(() => recordCapability([], invalid));
});

test('continuous playback controls remain an unverified hint even with scoped partial-export evidence', () => {
  const records = ['continuousRecordingQuery', 'continuousRecordingExport'].map(capability => observation(capability));
  const device = queryDevice(inventory, camera.device_sn, { records });
  assert.equal(device.recordingExport.status, 'verified');
  assert.deepEqual(queryCapability(device, 'continuousPlaybackControls'), {
    status: 'protocol_hint', reason: 'android_6001_controls_require_device_firmware_verification', evidence: [],
    controls: { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] },
  });
  assert.deepEqual(device.capabilities.continuousPlaybackControls, queryCapability(device, 'continuousPlaybackControls'));
  assert.equal(device.verificationHistory.some(record => record.capability === 'continuousPlaybackControls'), false);
});

test('continuous playback controls have no hint outside the constrained camera, HomeBase and channel mapping', () => {
  const variants = [
    [base],
    [base, { ...camera, device_model: 'OTHER' }],
    [base, { ...camera, device_type: undefined }],
    [{ ...base, device_model: 'OTHER' }, camera],
    [{ ...camera, parent_sn: 'absent' }],
    [base, { ...camera, parent_sn: undefined }],
    ...[undefined, null, -1, 0.5, '1'].map(device_channel => [base, { ...camera, device_channel }]),
  ];
  for (const changed of variants) {
    const device = describeDevices(changed).at(-1);
    assert.deepEqual(queryCapability(device, 'continuousPlaybackControls'), {
      status: 'unknown', reason: 'no_verified_continuous_playback_controls_path', evidence: [],
      controls: { pauseResumeAtSpeed1: false, verifiedStartSpeeds: [] },
    });
  }
});

test('unknown model and missing association/channel remain explicit and unverified', () => {
  const device = queryDevice([{ device_sn: 'unknown', device_type: 99999 }], 'unknown');
  assert.equal(device.model, null);
  assert.equal(device.homeBaseId, null);
  assert.equal(device.channel, null);
  assert.deepEqual(device.firmware, { main: null, secondary: null });
  assert.equal(device.recordingExport.supported, false);
  assert.equal(device.recordingExport.status, 'unknown');
  for (const entry of Object.values(device.capabilities)) assert.equal(entry.status, 'unknown');
  assert.equal(queryCapability(device, 'futureControl').reason, 'capability_not_catalogued');
  assert.equal(queryCapability(device, 'toString').reason, 'capability_not_catalogued');
  const detached = queryDevice([{ ...camera, parent_sn: 'absent', device_channel: -1 }], camera.device_sn);
  assert.equal(detached.homeBaseId, null);
  assert.equal(detached.channel, null);
  assert.equal(detached.capabilities.continuousRecordingQuery.reason, 'association_missing');
  assert.throws(() => describeDevices([{}]), /serial/);
});

test('incremental records independently represent all four states without changing execution eligibility', () => {
  let records = recordCapability([], observation('continuousRecordingQuery'));
  records = recordCapability(records, observation('continuousRecordingExport'));
  records = recordCapability(records, { ...observation('rtsp', 'unsupported'), reason: 'observed_rejection' });
  const device = queryDevice(inventory, camera.device_sn, { records });
  assert.equal(device.capabilities.continuousRecordingQuery.status, 'verified');
  assert.equal(device.recordingExport.status, 'verified');
  assert.equal(device.recordingExport.supported, true);
  assert.equal(device.capabilities.rtsp.status, 'unsupported');
  assert.equal(device.capabilities.eventRecordings.status, 'protocol_hint');
  assert.equal(device.capabilities.continuousRecordingExport.evidence[0].outcome, 'partial');
  const revised = recordCapability(records, { ...observation('continuousRecordingExport', 'unknown'), reason: 'needs_retest' });
  assert.equal(revised.length, 3);
  assert.equal(queryDevice(inventory, camera.device_sn, { records: revised }).recordingExport.status, 'unknown');
  assert.equal(queryDevice(inventory, camera.device_sn, { records: revised }).capabilities.continuousRecordingQuery.status, 'verified');
  assert.equal(records[1].status, 'verified');
});

test('verification cannot migrate to another device, model, camera/base firmware or channel', () => {
  const records = recordCapability([], observation('continuousRecordingQuery'));
  const variants = [
    [base, { ...camera, device_sn: 'another-camera' }],
    [base, { ...camera, device_model: 'new-model' }],
    [base, { ...camera, main_sw_version: 'camera-2' }],
    [base, { ...camera, sec_sw_version: 'radio-2' }],
    [base, { ...camera, main_sw_version: undefined }],
    [base, { ...camera, device_channel: 2 }],
    [{ ...base, main_sw_version: 'base-2' }, camera],
    [{ ...base, sec_sw_version: 'base-radio-2' }, camera],
    [{ ...base, main_sw_version: undefined }, camera],
    [{ ...base, device_sn: 'another-base' }, { ...camera, parent_sn: 'another-base' }],
  ];
  for (const changed of variants) {
    const device = describeDevices(changed, { records })[1];
    assert.notEqual(device.capabilities.continuousRecordingQuery.status, 'verified');
  }
});

test('missing historical firmware is retained as evidence but never matches an unknown current firmware', () => {
  const unknownFirmware = [base, { ...camera, main_sw_version: undefined }];
  const scope = queryDevice(unknownFirmware, camera.device_sn).verificationScope;
  const records = recordCapability([], { ...observation('continuousRecordingExport'), scope });
  const device = queryDevice(unknownFirmware, camera.device_sn, { records });
  assert.equal(device.recordingExport.status, 'protocol_hint');
  assert.equal(records[0].scope.firmware.main, null);
  assert.equal(device.verificationHistory[0].scope.firmware.main, null);
});

for (const parent of ['missing-base-A', 'missing-base-B']) {
  test(`an unresolved parent cannot apply historical verification when the current parent is ${parent}`, () => {
    const original = { ...camera, parent_sn: 'missing-base-A' };
    const scope = queryDevice([original], camera.device_sn).verificationScope;
    const records = recordCapability([], { ...observation('continuousRecordingQuery'), scope });
    const device = queryDevice([{ ...camera, parent_sn: parent }], camera.device_sn, { records });
    assert.equal(device.capabilities.continuousRecordingQuery.status, 'unknown');
    assert.equal(device.capabilities.continuousRecordingQuery.reason, 'association_missing');
    assert.equal(device.homeBaseId, null);
    assert.deepEqual(device.verificationScope.homeBase, {
      serial: parent, model: null, firmware: { main: null, secondary: null },
    });
    assert.equal(device.verificationHistory.length, 1);
    assert.equal(device.verificationHistory[0].scope.homeBase.serial, 'missing-base-A');
  });
}

test('incremental updates keep two unresolved parent scopes separate', () => {
  let records = [];
  for (const parent of ['missing-base-A', 'missing-base-B']) {
    const scope = queryDevice([{ ...camera, parent_sn: parent }], camera.device_sn).verificationScope;
    records = recordCapability(records, { ...observation('continuousRecordingQuery'), scope });
  }
  assert.equal(records.length, 2);
  assert.notDeepEqual(records[0].scope, records[1].scope);
});

test('a HomeBase without an external parent keeps its own firmware scope for absent and self parent values', () => {
  const scope = queryDevice([base], base.device_sn).verificationScope;
  const records = recordCapability([], { ...observation('continuousRecordingQuery'), scope });
  for (const parent of [undefined, '', base.device_sn]) {
    const device = queryDevice([{ ...base, parent_sn: parent }], base.device_sn, { records });
    assert.equal(device.verificationScope.homeBase, null);
    assert.equal(device.homeBaseId, null);
    assert.equal(device.capabilities.continuousRecordingQuery.status, 'verified');
  }
});

test('HomeBase observations have their own device and firmware scope', () => {
  const scope = queryDevice(inventory, base.device_sn).verificationScope;
  const records = recordCapability([], { ...observation('continuousRecordingQuery'), scope });
  assert.equal(queryDevice(inventory, base.device_sn, { records }).capabilities.continuousRecordingQuery.status, 'verified');
  assert.notEqual(queryDevice(inventory, camera.device_sn, { records }).capabilities.continuousRecordingQuery.status, 'verified');
});

test('offline observation explains current availability while preserving historical verification', () => {
  const records = recordCapability([], observation('continuousRecordingQuery'));
  const reachability = [{ serial: camera.device_sn, status: 'offline',
    observedAt: '2026-09-11T01:00:00Z', reason: 'connection_failed' }];
  const device = queryDevice(inventory, camera.device_sn, { records, reachability });
  assert.equal(device.availability, 'offline');
  assert.equal(device.state.reason, 'connection_failed');
  assert.equal(device.state.observedAt, '2026-09-11T01:00:00Z');
  assert.equal(device.capabilities.continuousRecordingQuery.status, 'verified');
});

test('record inputs and returned evidence are independent copies and invalid updates fail explicitly', () => {
  const input = observation('continuousRecordingQuery');
  const records = recordCapability([], input);
  input.scope.firmware.main = 'changed'; input.evidence[0].source = 'changed';
  const device = queryDevice(inventory, camera.device_sn, { records });
  device.capabilities.continuousRecordingQuery.evidence[0].source = 'changed-again';
  assert.equal(records[0].scope.firmware.main, 'camera-1');
  assert.equal(records[0].evidence[0].source, 'test-fixture');
  assert.throws(() => recordCapability([], { ...observation('rtsp'), status: 'supported' }), /status/);
  assert.throws(() => recordCapability([], { ...observation('rtsp'), evidence: [] }), /evidence/);
  assert.throws(() => recordCapability([], observation('madeUpCapability')), /capability/);
});

test('sanitized historical camera and HomeBase records remain explicit non-default evidence', () => {
  const historical = require('./historical-verification.json');
  const records = historical.records.reduce((saved, record) => recordCapability(saved, record), []);
  assert.equal(records.length, 4);
  assert.equal(new Set(records.map(record => record.scope.serial)).size, 2);
  assert.equal(records.filter(record => record.capability === 'continuousRecordingExport')
    .every(record => record.evidence[0].outcome === 'partial'), true);
  assert.equal(records.every(record => record.scope.firmware.main === null), true);
  assert.equal(queryDevice(inventory, camera.device_sn, { records }).recordingExport.status, 'protocol_hint');
  assert.equal(queryDevice(inventory, base.device_sn, { records }).capabilities.continuousRecordingQuery.status, 'protocol_hint');
});
