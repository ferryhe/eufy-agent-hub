const test = require('node:test');
const assert = require('node:assert/strict');
const { Station, CommandName, CommandType } = require('../../adapters/eufy');

test('vendored T8600 live path constructs H264 start and channel-bound stop with command identity', () => {
  const calls = [];
  const camera = new Proxy({ getSerial: () => 'fixture-camera', getStationSerial: () => 'fixture-base',
    getChannel: () => 3, hasCommand: () => true, isCameraProfessional247: () => true },
  { get: (object, key) => object[key] || (() => false) });
  const station = { getSerial: () => 'fixture-base', getSoftwareVersion: () => 'b1', isLiveStreaming: () => false, rawStation: { member: { admin_user_id: 'fixture-account' } },
    p2pSession: { getRSAPrivateKey: () => ({ exportKey: () => ({ n: Buffer.from([0,1,2]) }) }),
      sendCommandWithStringPayload: (command, customData) => calls.push({ command, customData }),
      sendCommandWithInt: (command, customData) => calls.push({ command, customData }) } };
  Station.prototype.startLivestream.call(station, camera);
  const start = calls[0], payload = JSON.parse(start.command.value);
  assert.equal(start.command.commandType, CommandType.CMD_SET_PAYLOAD); assert.equal(start.command.channel, 3);
  assert.equal(payload.cmd, CommandType.CMD_START_REALTIME_MEDIA); assert.equal(payload.payload.streamtype, 1);
  assert.equal(start.customData.command.name, CommandName.DeviceStartLivestream);
  station.isLiveStreaming = () => true; Station.prototype.stopLivestream.call(station, camera);
  assert.equal(calls[1].command.commandType, CommandType.CMD_STOP_REALTIME_MEDIA); assert.equal(calls[1].command.channel, 3);
  assert.equal(calls[1].customData.command.name, CommandName.DeviceStopLivestream);
});

test('vendored default RSA decoder unwraps a synthetic live AES key on the current Node runtime', () => {
  const { getNewRSAPrivateKey } = require('../../vendor/eufy-security-client/build/p2p/utils');
  const key = getNewRSAPrivateKey(), aes = Buffer.alloc(16, 7);
  assert.deepEqual(key.decrypt(key.encrypt(aes)), aes);
});
