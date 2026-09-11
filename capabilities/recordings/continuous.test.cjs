const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalContinuousRecordings } = require('./continuous.cjs');
const { P2PClientProtocol } = require('../../adapters/eufy');

test('continuous playback enables VIDEO reception before sending and omits event file_path', () => {
  const sent = [];
  const p = { connected: true, currentMessageState: {1:{}}, isCurrentlyStreaming: () => false,
    waitForStreamData: type => assert.equal(type, 1),
    sendCommandWithStringPayload: command => {
      assert.equal(p.currentMessageState[1].p2pStreaming, true);
      sent.push(JSON.parse(command.value));
    } };
  P2PClientProtocol.prototype.startContinuousPlayback.call(p, 'CAMERA', 1, 'ACCOUNT', 1787862600);
  assert.equal(sent[0].commandType, 6001);
  assert.equal(sent[0].data.session_id, 125);
  assert.equal(sent[0].data.play_type, 0);
  assert.equal(Object.hasOwn(sent[0].data, 'file_path'), false);
  p.isCurrentlyStreaming = () => true;
  assert.throws(() => P2PClientProtocol.prototype.startContinuousPlayback.call(p, 'CAMERA', 1, 'ACCOUNT', 1787862600), /already active/);
});

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-continuous-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  const p = new EventEmitter();
  const service = new LocalContinuousRecordings({ api: {userId:'ACCOUNT'} });
  service.connect = async () => {};
  service.camera = {getChannel: () => 1};
  service.station = {p2pSession:p};
  p.queryContinuousRecordings = (_sn,_channel,begin,end) => {
    p.emit('continuous recording ranges', 2, {begin_time:begin,end_time:end,videos:[]});
    p.emit('continuous recording ranges', 1, {begin_time:begin-1,end_time:end,videos:[]});
    p.emit('continuous recording ranges', 1, {begin_time:begin,end_time:end,videos:[{start_time:begin,stop_time:end}]});
  };
  p.stopContinuousPlayback = () => { p.stopped = true; };
  return {p,service,directory};
}

test('capture correlates range response and stops on device timestamps, preserving individual frames', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => {
    const frame = (timestamp,keyFrame,data) => p.emit('continuous playback frame', {kind:'video',channel:1,timestamp,keyFrame,data:Buffer.from(data),streamType:2});
    frame(100010,false,'skip');
    frame(100100,true,'first');
    frame(100900,false,'last');
    frame(101000,false,'outside');
  };
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.reachedEnd,true);
  assert.deepEqual(result.frames.map(f=>f.timestamp),[100100,100900]);
  assert.equal(fs.readFileSync(path.join(directory,'frames.bin'),'utf8'),'firstlast');
  assert.equal(p.stopped,true);
  assert.equal(p.listenerCount('continuous playback frame'),0);
});

test('interrupted stream leaves no successful manifest and always sends stop', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => p.emit('close');
  await assert.rejects(service.captureRange('CAMERA',100,101,directory), /中断/);
  assert.equal(fs.existsSync(path.join(directory,'frames.json')),false);
  assert.equal(p.stopped,true);
  assert.equal(service.capturing,false);
});
