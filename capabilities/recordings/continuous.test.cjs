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

test('interrupted stream saves a failed manifest and always sends stop', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => p.emit('close');
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.status, 'failed');
  assert.match(result.diagnostics[0].message, /中断/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'frames.json'))).status, 'failed');
  assert.equal(p.stopped,true);
  assert.equal(service.capturing,false);
});

function video(p, timestamp, keyFrame = true) {
  p.emit('continuous playback frame', {kind:'video', channel:1, timestamp, keyFrame, data:Buffer.from('frame'), streamType:2});
}

function rangeResponse(p, videos) {
  p.queryContinuousRecordings = (_sn, _channel, begin, end) =>
    p.emit('continuous recording ranges', 1, {begin_time:begin,end_time:end,videos});
}

test('adjacent ranges are captured separately and their shared boundary is not duplicated', async t => {
  const {p,service,directory} = setup(t);
  rangeResponse(p, [{start_time:100,stop_time:101}, {start_time:101,stop_time:102}]);
  const starts = [];
  p.startContinuousPlayback = (_serial,_channel,_account,begin) => {
    starts.push(begin);
    for (let timestamp = begin * 1000; timestamp <= (begin + 1) * 1000; timestamp += 50) video(p,timestamp);
  };
  const result = await service.captureRange('CAMERA',100,102,directory);
  assert.deepEqual(starts,[100,101]);
  assert.equal(result.frames.length,40);
  assert.equal(result.reachedEnd,true);
  assert.equal(result.status,'partial');
  assert.deepEqual(result.completeness.reasons,['decode_not_verified']);
});

test('gapped ranges preserve available frames and report the unavailable interval', async t => {
  const {p,service,directory} = setup(t);
  rangeResponse(p,[{start_time:100,stop_time:101},{start_time:102,stop_time:103}]);
  p.startContinuousPlayback = (_s,_c,_a,begin) => { video(p,begin*1000); video(p,(begin+1)*1000); };
  const result = await service.captureRange('CAMERA',100,103,directory);
  assert.equal(result.status,'partial');
  assert.deepEqual(result.completeness.rangeGaps,[{beginMs:101000,endMs:102000}]);
  assert.equal(result.segments.length,2);
});

test('no retained recordings returns failed without sending playback', async t => {
  const {p,service,directory} = setup(t);
  rangeResponse(p,[]);
  p.startContinuousPlayback = () => assert.fail('unexpected playback');
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.status,'failed');
  assert.ok(result.completeness.reasons.includes('no_video'));
});

test('disconnect after a keyframe preserves raw frames and a partial manifest', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => { video(p,100000); p.emit('close'); };
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.status,'partial');
  assert.equal(result.reachedEnd,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'frames.json'))).frames.length,1);
  assert.equal(fs.readFileSync(path.join(directory,'frames.bin'),'utf8'),'frame');
});

test('command rejection returns failed and does not capture later segments', async t => {
  const {p,service,directory} = setup(t);
  rangeResponse(p,[{start_time:100,stop_time:101},{start_time:101,stop_time:102}]);
  let starts = 0;
  p.startContinuousPlayback = () => { starts++; p.emit('command',{command_type:6001,channel:1,return_code:-5}); };
  const result = await service.captureRange('CAMERA',100,102,directory);
  assert.equal(result.status,'failed');
  assert.match(result.diagnostics[0].message, /-5/);
  assert.equal(starts,1);
});

test('other channels cannot interrupt playback and stop errors preserve diagnostics and cleanup', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => {
    p.emit('livestream error',2,new Error('other camera'));
    p.emit('livestream stopped',2);
    video(p,100000); video(p,101000);
  };
  p.stopContinuousPlayback = () => { throw new Error('stop rejected'); };
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.reachedEnd,true);
  assert.ok(result.diagnostics.some(d=>d.message === 'stop rejected'));
  assert.equal(service.capturing,false);
  assert.equal(p.listenerCount('continuous playback frame'),0);
});

test('capture timeout preserves partial frames', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => { video(p,100000); t.mock.timers.tick(62000); };
  const result = await service.captureRange('CAMERA',100,101,directory);
  assert.equal(result.status,'partial');
  assert.match(result.diagnostics[0].message,/超时/);
});

test('natural stop without boundary records uncertainty but still captures the next range', async t => {
  const {p,service,directory} = setup(t);
  rangeResponse(p,[{start_time:100,stop_time:101},{start_time:101,stop_time:102}]);
  const starts = [];
  p.startContinuousPlayback = (_s,_c,_a,begin) => {
    starts.push(begin); video(p,begin*1000); p.emit('livestream stopped',1);
  };
  const result = await service.captureRange('CAMERA',100,102,directory);
  assert.deepEqual(starts,[100,101]);
  assert.equal(result.frames.length,2);
  assert.equal(result.status,'partial');
  assert.equal(result.reachedEnd,false);
});

test('exclusive artifacts reject reuse and release the capture lock', async t => {
  const {p,service,directory} = setup(t);
  p.startContinuousPlayback = () => { video(p,100000); video(p,101000); };
  await service.captureRange('CAMERA',100,101,directory);
  await assert.rejects(service.captureRange('CAMERA',100,101,directory),/already exists/);
  assert.equal(service.capturing,false);
});

test('cancellation during the range response wait prevents playback and closes own resources', async t => {
  const {p,service,directory} = setup(t);
  const cancellation = new AbortController();
  let queryStarted, returnRanges, starts = 0, closes = 0;
  const pending = new Promise(resolve=>queryStarted=resolve);
  service.station.close = () => closes++;
  service.camera.destroy = () => {};
  p.queryContinuousRecordings = (_s,_c,begin,end) => {
    returnRanges = () => p.emit('continuous recording ranges',1,{begin_time:begin,end_time:end,videos:[{start_time:begin,stop_time:end}]});
    queryStarted();
  };
  p.startContinuousPlayback = () => { starts++; p.emit('close'); };
  const capture = service.captureRange('CAMERA',100,101,directory,{signal:cancellation.signal});
  await pending;
  cancellation.abort();
  returnRanges();
  const result = await capture;
  assert.equal(starts,0);
  assert.equal(result.status,'failed');
  assert.equal(result.diagnostics[0].stage,'cancelled');
  assert.equal(closes,1);
  assert.equal(p.listenerCount('continuous recording ranges'),0);
});

test('cancellation during media preserves partial frames and cannot start the next range', async t => {
  const {p,service,directory} = setup(t);
  const cancellation = new AbortController();
  let starts = 0, closes = 0;
  service.station.close = () => closes++;
  service.camera.destroy = () => {};
  rangeResponse(p,[{start_time:100,stop_time:101},{start_time:101,stop_time:102}]);
  p.startContinuousPlayback = () => {
    starts++; video(p,100000); cancellation.abort();
  };
  const result = await service.captureRange('CAMERA',100,102,directory,{signal:cancellation.signal});
  assert.equal(starts,1);
  assert.equal(result.status,'partial');
  assert.equal(result.diagnostics[0].stage,'cancelled');
  assert.equal(result.frames.length,1);
  assert.equal(closes,1);
  assert.equal(p.listenerCount('continuous playback frame'),0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'frames.json'))).status,'partial');
});
