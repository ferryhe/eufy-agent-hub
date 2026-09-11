const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceType } = require('../../adapters/eufy');
const { continuousDevices } = require('./continuous-mapping.cjs');

test('continuous mapping requires the tested model, supported transport type, parent and channel', () => {
  const base = { device_sn: 'base', device_model: 'T8030', local_ip: '192.0.2.1' };
  const camera = { device_sn: 'camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247,
    parent_sn: 'base', device_channel: 0 };
  const mapped = raw => continuousDevices([base, raw])[1];
  assert.equal(mapped(camera).recordingExport.supported, true);
  assert.equal(mapped(camera).homeBaseId, 'base'); assert.equal(mapped(camera).channel, 0);
  for (const change of [{ device_model: 'other' }, { device_type: DeviceType.SENSOR }, { parent_sn: 'missing' },
    { device_channel: undefined }, { device_channel: -1 }])
    assert.equal(mapped({ ...camera, ...change }).recordingExport.supported, false);
  assert.equal(continuousDevices([{ ...base, local_ip: undefined }, camera])[1].availability, 'unavailable');
  assert.equal(continuousDevices([{ ...base, device_model: 'T8010' }, camera])[1].recordingExport.supported, false);
  assert.throws(() => continuousDevices([{ device_model: 'T8600' }]), /serial/);
});
