const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { REQUEST, startEvidenceCapture, verifyEvidence } = require('./continuous-evidence.cjs');
const { LocalContinuousRecordings } = require('./continuous.cjs');

test('separate validation page waits for authentication and captures only the authorized window', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'continuous-evidence-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const session = {authenticated:false,state:{phase:'idle',devices:[]}};
  let calls = 0, closes = 0;
  const service = {close:()=>closes++,captureRange:async (serial,begin,end,output)=>{
    calls++;
    assert.equal(serial,'PRIVATE_SERIAL');
    assert.equal(begin,1787862600); assert.equal(end,1787863800); assert.equal(output,directory);
    return {serial,begin,end,frames:[],ranges:[],segments:[],diagnostics:[],reachedEnd:false};
  }};
  let ready;
  const url = new Promise(resolve=>ready=resolve);
  const runner = startEvidenceCapture(directory,{port:0,session,service,onReady:ready});
  t.after(runner.stop);
  const address = await url;
  const response = await fetch(address);
  assert.equal(response.status,200);
  assert.match(await response.text(),/html/i);
  assert.equal(calls,0);
  session.state = {phase:'connected',devices:[{name:'Drive Way',model:'T8600',serial:'PRIVATE_SERIAL'}]};
  session.authenticated = true;
  const evidence = await runner.completion;
  assert.equal(calls,1); assert.ok(closes > 0);
  assert.equal(evidence.hardwareAccepted,false);
  assert.equal(evidence.completeness.status,'failed');
  assert.equal(JSON.stringify(evidence).includes('PRIVATE_SERIAL'),false);
  assert.equal(runner.server.listening,false);
});

test('validation cannot use the existing service port', () => {
  assert.throws(()=>startEvidenceCapture('unused',{port:3187}),/reserved/);
});

test('stopping before login closes the separate page without capturing', async () => {
  const session = {authenticated:false,state:{phase:'idle',devices:[]}};
  let ready;
  const url = new Promise(resolve=>ready=resolve);
  const runner = startEvidenceCapture('unused',{port:0,session,
    service:{close:()=>{},captureRange:()=>assert.fail('unexpected capture')},onReady:ready});
  await url;
  runner.stop();
  await assert.rejects(runner.completion,/cancelled/);
  assert.equal(runner.server.listening,false);
});

test('missing decoder cannot report a complete result or hardware acceptance', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'continuous-decode-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.writeFileSync(path.join(directory,'frames.json'),JSON.stringify({begin:REQUEST.begin,end:REQUEST.end,
    frames:[],ranges:[],segments:[],diagnostics:[],reachedEnd:false}));
  const evidence = verifyEvidence(directory,path.join(directory,'missing-ffmpeg'));
  assert.equal(evidence.completeness.decode.status,'failed');
  assert.equal(evidence.hardwareAccepted,false);
  assert.notEqual(evidence.completeness.status,'complete');
});

test('stopping during capture readiness never starts playback after readiness resolves', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'continuous-cancel-readiness-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const session = {authenticated:true,api:{userId:'ACCOUNT'},state:{phase:'connected',
    devices:[{name:'Drive Way',model:'T8600',serial:'PRIVATE_SERIAL'}]}};
  const service = new LocalContinuousRecordings(session);
  const p = new EventEmitter();
  let reachedReadiness, finishReadiness, starts = 0, closes = 0, destroys = 0;
  const pending = new Promise(resolve=>reachedReadiness=resolve);
  const readiness = new Promise(resolve=>finishReadiness=resolve);
  service.connect = async () => {
    reachedReadiness();
    await readiness;
    service.camera = {getChannel:()=>1,destroy:()=>destroys++};
    service.station = {p2pSession:p,close:()=>{ closes++; p.emit('close'); }};
  };
  p.queryContinuousRecordings = (_s,_c,begin,end)=>
    p.emit('continuous recording ranges',1,{begin_time:begin,end_time:end,videos:[{start_time:begin,stop_time:end}]});
  p.startContinuousPlayback = () => { starts++; p.emit('close'); };
  p.stopContinuousPlayback = () => {};
  const runner = startEvidenceCapture(directory,{port:0,session,service});
  t.after(runner.stop);
  await pending;
  runner.stop();
  finishReadiness();
  const evidence = await runner.completion;
  assert.equal(starts,0,'must not start playback after stop');
  assert.equal(evidence.completeness.status,'failed');
  const capture = JSON.parse(fs.readFileSync(path.join(directory,'frames.json'),'utf8'));
  assert.ok(capture.diagnostics.some(d=>d.stage === 'cancelled'));
  assert.ok(closes > 0); assert.ok(destroys > 0);
  assert.equal(service.station,undefined);
  assert.equal(service.capturing,false);
});
