const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCompleteness } = require('./continuous-completeness.cjs');

function capture() {
  return {begin:100,end:101,reachedEnd:true,diagnostics:[],ranges:[{start_time:100,stop_time:101}],
    segments:[{begin:100,end:101,reachedEnd:true,boundaryTimestampMs:101000}],
    frames:Array.from({length:20},(_,i)=>({kind:'video',timestamp:100000+i*50,keyFrame:i===0,length:5}))};
}
const decoded = {status:'passed',full:true,videoFrames:20,durationMs:1000};

test('complete requires full decode, range coverage, boundary evidence and uninterrupted frame timestamps', () => {
  const info = capture();
  assert.equal(assessCompleteness(info).status,'partial');
  assert.equal(assessCompleteness(info,{decode:decoded}).status,'complete');
  assert.equal(assessCompleteness(info,{decode:{status:'passed'}}).status,'partial');
  assert.equal(assessCompleteness(info,{decode:{status:'failed',full:true}}).status,'partial');
  assert.equal(assessCompleteness(info,{decode:{...decoded,videoFrames:1,durationMs:50}}).status,'partial');
});

test('end marker and full decode cannot hide an internal timestamp jump or keyframe trimming', () => {
  const info = capture();
  info.frames = info.frames.filter(f=>f.timestamp >= 100100 && (f.timestamp < 100300 || f.timestamp >= 100600));
  info.frames[0].keyFrame = true;
  const result = assessCompleteness(info,{decode:decoded});
  assert.equal(result.status,'partial');
  assert.ok(result.reasons.includes('leading_gap'));
  assert.deepEqual(result.streams.video.gaps,[{beginMs:100250,endMs:100600,deltaMs:350}]);
});

test('out of order, repeated or invalid timestamps cannot be sorted into a complete result', () => {
  for (const timestamp of [100000,99999,NaN]) {
    const info = capture(); info.frames[3].timestamp = timestamp;
    assert.equal(assessCompleteness(info,{decode:decoded}).status,'partial');
  }
});

test('end-boundary jump and truncated tail remain partial', () => {
  const info = capture(); info.frames = info.frames.slice(0,2);
  assert.ok(assessCompleteness(info,{decode:decoded}).reasons.includes('trailing_gap'));
  info.reachedEnd = false;
  assert.ok(assessCompleteness(info,{decode:decoded}).reasons.includes('end_not_reached'));
});

test('empty/no-keyframe captures fail even with a reported decode pass', () => {
  const info = capture(); info.frames = [];
  assert.equal(assessCompleteness(info,{decode:decoded}).status,'failed');
  info.frames = [{kind:'video',timestamp:100000,keyFrame:false,length:5}];
  assert.equal(assessCompleteness(info,{decode:decoded}).status,'failed');
});

test('audio timestamp gaps are also reported when audio is present', () => {
  const info = capture();
  info.frames.push({kind:'audio',timestamp:100000,length:5},{kind:'audio',timestamp:100400,length:5});
  const result = assessCompleteness(info,{decode:decoded});
  assert.equal(result.status,'partial');
  assert.equal(result.streams.audio.gaps[0].deltaMs,400);
});

test('one missing packet in a stable 20fps stream is not hidden by the absolute gap ceiling', () => {
  const info = capture(); info.frames.splice(5,1);
  const result = assessCompleteness(info,{decode:decoded});
  assert.equal(result.status,'partial');
  assert.equal(result.streams.video.gapLimitMs,75);
  assert.equal(result.streams.video.gaps[0].deltaMs,100);
});
