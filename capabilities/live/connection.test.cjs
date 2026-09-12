const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { LiveConnection } = require('./connection.cjs');
const { LocalRecordings } = require('../recordings/events.cjs');

test('live connection joins upstream async close, destroys the camera and retires the UDP socket', async () => {
  const socket = dgram.createSocket('udp4'); await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  let release, connected = true, closes = 0, destroyed = false, recreated = false;
  const gate = new Promise(resolve => { release = resolve; });
  socket.on('close', () => { recreated = true; });
  const p2p = { socket, isConnected: () => connected, async close() { closes++; await gate; connected = false; } };
  const connection = new LiveConnection({});
  connection.station = { p2pSession: p2p, close() { p2p.close(); } };
  connection.camera = { destroy() { destroyed = true; } };
  let finished = false; const cleanup = connection.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(destroyed, true);
  release(); await cleanup; await connection.close();
  assert.equal(closes, 1); assert.equal(recreated, false); assert.equal(finished, true);
  assert.throws(() => socket.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
});

test('camera-only setup failure is cleaned and missing Mega member metadata uses the restored account', async t => {
  const connection = new LiveConnection({}); let destroyed = 0;
  connection.camera = { destroy: () => destroyed++ }; await connection.close(); assert.equal(destroyed, 1);
  for (const existing of [undefined, { admin_user_id: 'existing-owner' }]) {
    const raw = { device_sn: 'base', device_model: 'T8030', member: existing };
    t.mock.method(LocalRecordings.prototype, 'connect', async function () {
      this.station = { getRawStation: () => raw };
      this.camera = { getRawDevice: () => ({ device_sn: 'camera', parent_sn: 'base', device_model: 'T8600', device_channel: 1 }) };
      this.userId = 'restored-account';
    });
    await connection.connect('camera'); assert.equal(raw.member.admin_user_id, existing?.admin_user_id || 'restored-account');
    t.mock.restoreAll();
  }
});
