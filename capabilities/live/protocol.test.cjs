const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { P2PClientProtocol, Station, CommandName, DeviceType } = require('../../adapters/eufy');

test('T8600 professional path starts 1350/1003 H264 and stops 1004 on the exact camera channel', () => {
  const sent = [];
  const camera = new Proxy({ getSerial: () => 'T8600-test', getStationSerial: () => 'T8030-test', getChannel: () => 7,
    hasCommand: () => true, isCameraProfessional247: () => true, getDeviceType: () => DeviceType.PROFESSIONAL_247 },
  { get(target, key) { return key in target ? target[key] : key.startsWith('is') ? () => false : undefined; } });
  const station = new Proxy({ getSerial: () => 'T8030-test', getSoftwareVersion: () => '3.7.1.8', isLiveStreaming: () => false,
    rawStation: { member: { admin_user_id: 'offline-test' } }, p2pSession: { getRSAPrivateKey: () => null,
      sendCommandWithStringPayload: (command, data) => sent.push({ command, data }), sendCommandWithInt: (command, data) => sent.push({ command, data }) } },
  { get(target, key) { return key in target ? target[key] : key.startsWith('is') ? () => false : undefined; } });
  Station.prototype.startLivestream.call(station, camera, 0);
  assert.equal(sent[0].command.commandType, 1350); assert.equal(sent[0].command.channel, 7);
  const payload = JSON.parse(sent[0].command.value); assert.equal(payload.cmd, 1003); assert.equal(payload.mValue3, 1003); assert.equal(payload.payload.streamtype, 1);
  assert.equal(sent[0].data.command.name, CommandName.DeviceStartLivestream);
  station.isLiveStreaming = () => true; Station.prototype.stopLivestream.call(station, camera);
  assert.deepEqual(sent[1].command, { commandType: 1004, value: 7, channel: 7 });
});

for (const mode of ['unconnected', 'connecting']) test(`permanent destruction closes real UDP without replacement and cancels old state timers (${mode})`, async () => {
  const p = new P2PClientProtocol({ station_sn: 'T8030-offline', station_type: DeviceType.HB3, station_model: 'T8030',
    app_conn: '', devices: [], member: { admin_user_id: 'offline' } }, { isConnected: () => true });
  const socket = p.socket; socket.bind(0, '127.0.0.1'); await once(socket, 'listening');
  p.binded = true; p.connecting = mode === 'connecting';
  let fired = 0; const timers = [];
  const timer = () => { const handle = setTimeout(() => fired++, 50); timers.push(handle); return handle; };
  const old = p.currentMessageState[1]; const video = old.videoStream, audio = old.audioStream;
  old.p2pStreamingTimeout = timer(); old.waitForSeqNoTimeout = timer(); old.waitForAudioData = timer();
  p.messageStates.set(10, { timeout: timer(), retryTimeout: timer() });
  p.messageVideoStates.set(20, { timeout: timer() });
  p.lookup2RetryTimeout = timer(); p.keepaliveTimeout = timer(); p.esdDisconnectTimeout = timer();
  try {
    await p.destroy(); await p.destroy();
    assert.equal(p.socket, socket); assert.equal(video.destroyed, true); assert.equal(audio.destroyed, true);
    assert.throws(() => socket.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
    await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(fired, 0);
    assert.equal(p.connected, false); assert.equal(p.connecting, false);
  } finally { for (const handle of timers) clearTimeout(handle); await p.destroy(); }
});
