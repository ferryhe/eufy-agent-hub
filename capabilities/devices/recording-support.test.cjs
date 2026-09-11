const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceType } = require('../../adapters/eufy');
const { supportsEventRecordings } = require('./recording-support.cjs');
const { LocalEufySession } = require('../auth/session.cjs');
const { LocalRecordings } = require('../recordings/events.cjs');

const base = { device_sn: 'BASE1234', device_model: 'T8030', device_type: DeviceType.HB3 };
const camera = { device_sn: 'CAMERA123', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247, parent_sn: base.device_sn };

test('recording support requires camera type, download command and an HB3 parent', () => {
  assert.equal(supportsEventRecordings(camera, [base, camera]), true);
  for (const device of [base,
    { ...camera, device_type: DeviceType.SENSOR },
    { ...camera, device_type: DeviceType.LOCK_BLE },
    { ...camera, device_type: 99999 },
    { ...camera, device_type: undefined },
    { ...camera, parent_sn: 'MISSING' },
  ]) assert.equal(supportsEventRecordings(device, [base, device]), false);
  assert.equal(supportsEventRecordings(camera, [{ ...base, device_model: 'T8010' }, camera]), false);
});

test('inventory keeps non-cameras visible but only offers supported recording targets', async () => {
  const session = new LocalEufySession();
  session.authenticated = true; session.state.country = 'CA';
  session.api = { hasValidSession: () => true, getDevsListDecrypted: async () => ({ devices: [
    base, camera, { ...camera, device_sn: 'SENSOR123', device_type: DeviceType.SENSOR },
    { ...camera, device_sn: 'UNKNOWN123', device_type: 99999 },
  ] }) };
  await session.refresh();
  assert.equal(session.state.devices.length, 4);
  assert.deepEqual(session.state.devices.filter(d => d.capabilities.eventRecordings).map(d => d.serial), ['CAMERA123']);
});

test('direct recording callers cannot bypass filtering with a sensor or unsupported camera', async () => {
  for (const type of [DeviceType.SENSOR, DeviceType.LOCK_BLE, 99999, undefined]) {
    const service = new LocalRecordings({ authenticated: true, api: {
      getDevsListDecrypted: async () => ({ devices: [base, { ...camera, device_type: type }] }),
    } });
    // No LAN address is present: rejection must precede station setup.
    await assert.rejects(service.connect(camera.device_sn), /不支持当前事件录像/);
    assert.equal(service.camera, undefined); assert.equal(service.station, undefined);
  }
});
