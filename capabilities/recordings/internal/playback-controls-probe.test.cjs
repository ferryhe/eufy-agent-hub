const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { P2PClientProtocol } = require('../../../adapters/eufy');
const { runPlaybackControlsProbe, ANDROID_SPEED_CANDIDATES } = require('./playback-controls-probe.cjs');

const input = { serial: 'fixture-camera-private', accountId: 'fixture-account-private', channel: 1, begin: 100, end: 160 };
const privatePath = 'fixture-record-path-private';
async function advance(t, milliseconds = 0) {
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(milliseconds);
  await new Promise(resolve => setImmediate(resolve));
}
async function finish(t, pending) {
  await advance(t, 1); await advance(t, 500); await advance(t, 1);
  return pending;
}
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const p2p = new EventEmitter(), sent = [];
  p2p.connected = options.connected !== false;
  p2p.isConnected = () => p2p.connected;
  p2p.currentMessageState = { 1: { p2pStreaming: false } };
  p2p.isCurrentlyStreaming = () => p2p.currentMessageState[1].p2pStreaming;
  p2p.sendQueue = []; p2p.messageStates = new Map();
  p2p.waitForStreamData = () => {};
  p2p.streamTimeouts = { streamDataWait: 5000 };
  p2p.setStreamTimeouts = P2PClientProtocol.prototype.setStreamTimeouts;
  p2p.endStream = () => {
    if (!p2p.currentMessageState[1].p2pStreaming) return;
    p2p.continuousPlayback = undefined; p2p.currentMessageState[1].p2pStreaming = false;
    p2p.emit('livestream stopped', 1);
  };
  if (options.realAdapterTimeout) {
    // Borrow the real adapter lifecycle without constructing a socket/Station.
    // Only unused stream-buffer initialization and energy-saving I/O are stubbed.
    Object.assign(p2p.currentMessageState[1], { p2pStreamNotStarted: true, invalidStream: false, queuedData: new Map() });
    p2p.deviceSNs = {};
    p2p.streamTimeouts = { streamDataWait: 5000 };
    for (const method of ['waitForStreamData', 'endStream', 'emitStreamStopEvent', 'setStreamTimeouts'])
      p2p[method] = P2PClientProtocol.prototype[method];
    p2p.initializeMessageBuilder = p2p.initializeMessageState = p2p.initializeStream = p2p.closeEnergySavingDevice = () => {};
  }
  const frame = timestamp => {
    if (options.realAdapterTimeout) {
      // The parser refreshes the data timer but only publishes continuous media
      // while the adapter's continuousPlayback context still exists.
      p2p.waitForStreamData(1, true);
      if (!p2p.continuousPlayback) return;
    }
    p2p.emit('continuous playback frame', {
      kind: 'video', channel: 1, timestamp, keyFrame: true, data: Buffer.from('fixture-media-private'),
      device_sn: input.serial, file_path: privatePath,
    });
    if (options.realAdapterTimeout) p2p.currentMessageState[1].p2pStreamNotStarted = false;
  };
  const reply = (customData, code = 0, channel = 1) => p2p.emit('command', {
    command_type: 6001, channel, return_code: code, customData, payload: 'fixture-payload-private',
  });
  p2p.queryContinuousRecordings = (_serial, channel, begin, end) => {
    if (options.oldFrame) frame(102000);
    p2p.emit('continuous recording ranges', channel + 1, { begin_time: begin, end_time: end, videos: [] });
    p2p.emit('continuous recording ranges', channel, {
      begin_time: begin, end_time: end,
      videos: [{ start_time: begin, stop_time: end,
        ...(Object.hasOwn(options, 'filePath') ? options.filePath === undefined ? {} : { file_path: options.filePath } : { file_path: privatePath }) }],
    });
  };
  p2p.sendCommandWithStringPayload = (command, customData) => {
    const payload = JSON.parse(command.value);
    sent.push({ command, payload, customData });
    if (payload.data.cmd === 0) assert.equal(p2p.currentMessageState[1].p2pStreaming, true, 'VIDEO is ready before the only start send');
    if (payload.data.cmd === 0 && options.startReply) return options.startReply({ customData, reply, p2p, frame });
    if (options.sendError && payload.data.cmd === 1) throw new Error('fixture-account-private fixture-payload-private');
    if (payload.data.cmd === 1 && options.pauseReply) return options.pauseReply({ customData, reply, p2p });
    queueMicrotask(() => reply(customData, payload.data.cmd === 1 ? options.pauseCode || 0 : 0));
    if (payload.data.cmd === 0 && !options.noFrame) {
      setTimeout(() => frame(103456), options.firstFrameDelay ?? 1);
      if (options.candidateSpeed) setTimeout(() => frame(160000), (options.firstFrameDelay ?? 1) + 1);
    }
    if (payload.data.cmd === 1 && options.pauseAdvance) setTimeout(() => frame(104456), 250);
    if (payload.data.cmd === 2 && !options.noResumeFrame) setTimeout(() => frame(160000), 1);
  };
  p2p.startContinuousPlayback = (...args) => P2PClientProtocol.prototype.startContinuousPlayback.apply(p2p, args);
  p2p.stopContinuousPlayback = () => {
    assert.ok(p2p.continuousPlayback, 'Stop must belong to an active probe session');
    sent.push({ payload: { data: { cmd: 3 } } });
    p2p.endStream(1);
    queueMicrotask(() => reply(undefined, options.stopCode || 0));
  };
  if (options.realAdapterTimeout) p2p.stopContinuousPlayback = P2PClientProtocol.prototype.stopContinuousPlayback;
  p2p.close = async () => {
    clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
    p2p.endStream(1);
    p2p.closed = true; p2p.connected = false; p2p.continuousPlayback = undefined;
    p2p.currentMessageState[1].p2pStreaming = false; p2p.emit('close');
  };
  t.after(() => {
    for (const name of ['command', 'continuous recording ranges', 'continuous playback frame', 'close', 'livestream stopped', 'livestream started'])
      assert.equal(p2p.listenerCount(name), 0, name);
  });
  return { p2p, sent, frame, reply, run: () => runPlaybackControlsProbe({ p2p, ...input, candidateSpeed: options.candidateSpeed }) };
}

test('internal controls probe uses fresh query context and actual media position, correlates results and emits only sanitized observations', async t => {
  const f = fixture(t);
  const result = await finish(t, f.run());
  assert.equal(result.status, 'completed');
  assert.equal(result.verificationStatus, 'unverified');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1, 2, 3]);
  assert.deepEqual(f.sent[1].payload, { commandType: 6001, data: {
    session_id: 125, cmd: 1, play_type: 0, play_speed: 1, begin_time: 0,
    file_path: '', device_sn: input.serial, index: 0,
  } });
  assert.deepEqual(f.sent[2].payload, { commandType: 6001, data: {
    session_id: 125, cmd: 2, play_type: 0, play_speed: 1, begin_time: 103,
    file_path: privatePath, device_sn: input.serial, index: 0,
  } });
  assert.notEqual(f.sent[1].customData, f.sent[2].customData);
  assert.deepEqual(result.operations.map(item => [item.operation, item.returnCode]), [['start', 0], ['pause', 0], ['resume', 0], ['stop', 0]]);
  const pause = result.operations[1], resume = result.operations[2];
  assert.equal(pause.mediaTimeBeforeMs, 103456);
  assert.ok(resume.sentAtMs - pause.sentAtMs < 5000);
  assert.ok(result.frames.some(frame => frame.phase === 'before_pause' && frame.mediaTimeMs === 103456));
  assert.ok(result.frames.some(frame => frame.phase === 'after_resume' && frame.mediaTimeMs === 160000));
  assert.equal(result.frames.some(frame => frame.phase === 'paused'), false, 'This fixture has a quiet pause window');
  assert.equal(result.pauseWindow.startedAtMs, pause.receivedAtMs);
  assert.equal(result.pauseWindow.endedAtMs - result.pauseWindow.startedAtMs, 500);
  assert.equal(result.pauseWindow.mediaTimeBeforeMs, 103456);
  assert.equal(result.channelIsolation.status, 'unverified');
  assert.equal(result.allowedSpeeds, null);
  for (const secret of [input.serial, input.accountId, privatePath, 'fixture-media-private', 'fixture-payload-private'])
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test('real adapter startup timer permits a valid first video at six seconds within the probe budget', async t => {
  const f = fixture(t, { candidateSpeed: 2, realAdapterTimeout: true, firstFrameDelay: 6000 });
  let settled = false, stoppedEvents = 0;
  const stopped = () => { stoppedEvents++; };
  f.p2p.on('livestream stopped', stopped);
  const pending = f.run().then(result => { settled = true; return result; });
  await advance(t, 5000);
  t.diagnostic(JSON.stringify({ atMs: 5000, hasOwner: Boolean(f.p2p.continuousPlayback),
    streaming: f.p2p.currentMessageState[1].p2pStreaming, stoppedEvents, settled }));
  await advance(t, 1000); await advance(t, 1); await advance(t, 8999);
  const result = await pending;
  f.p2p.off('livestream stopped', stopped);
  t.diagnostic(JSON.stringify({ status: result.status, error: result.error, frames: result.frames.length,
    commands: f.sent.map(item => item.payload.data.cmd) }));
  assert.equal(result.status, 'completed');
  assert.ok(result.frames.some(frame => frame.mediaTimeMs === 103456));
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 3]);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
  assert.equal(result.startup.mediaBudgetMs, 15000);
  assert.equal(result.startup.firstVideoAtMs - result.startup.startedAtMs, 6000);
  assert.ok(result.startup.localStreamStoppedAtMs >= result.startup.firstVideoAtMs);
});

test('unmodified adapter five-second pre-media timer silently clears continuous state', async t => {
  const f = fixture(t, { realAdapterTimeout: true, noFrame: true });
  let stoppedEvents = 0;
  const stopped = () => { stoppedEvents++; };
  f.p2p.on('livestream stopped', stopped);
  f.p2p.startContinuousPlayback(input.serial, input.channel, input.accountId, input.begin);
  await advance(t, 4999);
  assert.ok(f.p2p.continuousPlayback);
  await advance(t, 1);
  assert.equal(f.p2p.continuousPlayback, undefined);
  assert.equal(f.p2p.currentMessageState[1].p2pStreaming, false);
  assert.equal(stoppedEvents, 0);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0]);
  f.p2p.off('livestream stopped', stopped);
});

test('resident adapter start and stop preserve unique markers and q0 speed/path options', async t => {
  const f = fixture(t, { realAdapterTimeout: true, noFrame: true });
  const start = {}, stop = {};
  f.p2p.startContinuousPlayback(input.serial, input.channel, input.accountId, input.begin,
    { speed: 16, filePath: '', customData: start });
  assert.equal(f.sent[0].customData, start);
  assert.equal(f.sent[0].payload.data.play_speed, 16);
  assert.equal(f.sent[0].payload.data.file_path, '');
  f.p2p.stopContinuousPlayback(stop);
  assert.equal(f.sent[1].customData, stop);
});

test('startup budget starts at command send and restores the original idle timeout on the first valid video', async t => {
  const f = fixture(t, { realAdapterTimeout: true, firstFrameDelay: 6000 });
  f.p2p.streamTimeouts.streamDataWait = 7000;
  const pending = f.run(); await advance(t, 5000);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 15000);
  await advance(t, 1000);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 7000, 'Restore before pause');
  await advance(t, 500); await advance(t, 1);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.startup.startedAtMs, result.operations[0].sentAtMs);
  assert.equal(result.startup.firstVideoAtMs - result.startup.startedAtMs, 6000);
  assert.equal(f.p2p.endStream, P2PClientProtocol.prototype.endStream);
});

test('startup without media fails at the send-based budget, closes and restores settings', async t => {
  const f = fixture(t, { candidateSpeed: 2, realAdapterTimeout: true, noFrame: true });
  const pending = f.run(); await advance(t, 14999);
  assert.equal(f.p2p.isConnected(), true);
  assert.ok(f.p2p.continuousPlayback);
  await advance(t, 1);
  const result = await pending;
  assert.deepEqual(result.error, { code: 'CONTROL_STARTUP_TIMEOUT', stage: 'media_context' });
  assert.equal(f.p2p.closed, true);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
  assert.equal(f.p2p.endStream, P2PClientProtocol.prototype.endStream);
  assert.equal(result.startup.localStreamStoppedAtMs - result.startup.startedAtMs, 15000);
  assert.equal(result.startup.firstVideoAtMs, null);
  assert.equal(result.startup.frameEvents, 0);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0]);
});

test('the first valid video rearms the real adapter idle timer for its original five seconds', async t => {
  const f = fixture(t, { candidateSpeed: 2, realAdapterTimeout: true, noFrame: true });
  const pending = f.run(); await advance(t, 6000);
  f.frame(103456); await advance(t);
  assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000);
  await advance(t, 4999);
  assert.ok(f.p2p.continuousPlayback);
  await advance(t, 1);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_INACTIVE');
  assert.equal(result.startup.localStreamStoppedAtMs - result.startup.firstVideoAtMs, 5000);
});

test('delayed start reply consumes the same first-media budget instead of granting another fifteen seconds', async t => {
  const f = fixture(t, { candidateSpeed: 2, realAdapterTimeout: true,
    startReply: ({ customData, reply }) => setTimeout(() => reply(customData), 3000) });
  const pending = f.run(); await advance(t, 3000); await advance(t, 12000);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_STARTUP_TIMEOUT');
  assert.equal(result.startup.localStreamStoppedAtMs - result.startup.startedAtMs, 15000);
  assert.equal(f.p2p.closed, true);
});

test('startup exceptions restore the prior timeout before dedicated connection cleanup', async t => {
  const f = fixture(t, { candidateSpeed: 2, realAdapterTimeout: true, startReply: () => { throw new Error('fixture-private'); } });
  const close = f.p2p.close;
  f.p2p.close = async () => { assert.equal(f.p2p.streamTimeouts.streamDataWait, 5000); await close(); };
  const result = await f.run();
  assert.equal(result.error.code, 'CONTROL_SEND_FAILED');
  assert.equal(f.p2p.closed, true);
  assert.equal(f.p2p.endStream, P2PClientProtocol.prototype.endStream);
});

test('startup diagnostics count filtered events without accepting them as video context or exposing their fields', async t => {
  const f = fixture(t, { oldFrame: true });
  const pending = f.run(); await advance(t);
  for (const frame of [{ channel: 2, timestamp: 102000 }, { channel: 1, timestamp: NaN }, { channel: 1, timestamp: 99000 }])
    f.p2p.emit('continuous playback frame', { kind: 'video', ...frame, data: 'fixture-private-payload', file_path: 'fixture-private-path' });
  const result = await finish(t, pending);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.startup.filteredFrames, { notOwned: 1, wrongChannel: 1, invalidTime: 1, beforeWindow: 1 });
  assert.equal(result.startup.frameEvents, result.frames.length + 4);
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
});

test('pause success followed by advancing video fails the observation and closes without resume or stop', async t => {
  const f = fixture(t, { pauseAdvance: true });
  const result = await finish(t, f.run());
  assert.equal(result.status, 'failed', 'An acknowledged pause with advancing media cannot complete');
  assert.deepEqual(result.error, { code: 'PAUSE_MEDIA_ADVANCED', stage: 'pause_observation' });
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
  assert.equal(f.p2p.closed, true);
  assert.equal(result.connectionTerminated, true);
  assert.ok(result.frames.some(frame => frame.phase === 'paused' && frame.mediaTimeMs === 104456));
  assert.equal(result.pauseWindow.mediaTimeBeforeMs, 103456);
  assert.ok(result.pauseWindow.endedAtMs - result.pauseWindow.startedAtMs <= 500);
});

test('pause observation includes media emitted immediately after the successful acknowledgement', async t => {
  const f = fixture(t, { pauseReply: ({ customData, reply, p2p }) => {
    reply(customData);
    p2p.emit('continuous playback frame', { channel: 1, kind: 'video', timestamp: 104456 });
  } });
  const result = await finish(t, f.run());
  assert.deepEqual(result.error, { code: 'PAUSE_MEDIA_ADVANCED', stage: 'pause_observation' });
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
  assert.equal(f.p2p.closed, true);
});

test('pause media advance awaits dedicated close before returning and never sends another control', async t => {
  const f = fixture(t, { pauseAdvance: true });
  let release, settled = false;
  const close = f.p2p.close;
  f.p2p.close = async () => { await new Promise(resolve => { release = resolve; }); await close(); };
  const pending = f.run().then(result => { settled = true; return result; });
  await advance(t, 1); await advance(t, 500); await advance(t, 1);
  assert.equal(typeof release, 'function');
  assert.equal(settled, false);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
  release();
  assert.equal((await pending).error.code, 'PAUSE_MEDIA_ADVANCED');
});

test('pause observation permits an unchanged target timestamp and ignores another channel before fresh resume progress', async t => {
  const f = fixture(t);
  const pending = f.run(); await advance(t, 1);
  f.frame(103456);
  f.p2p.emit('continuous playback frame', { channel: 2, kind: 'video', timestamp: 104456 });
  await advance(t, 500); await advance(t, 1);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.verificationStatus, 'unverified');
  assert.ok(result.frames.some(frame => frame.phase === 'after_resume' && frame.mediaTimeMs > 103456));
});

test('a quiet pause window without fresh video after resume cannot complete', async t => {
  const f = fixture(t, { noResumeFrame: true });
  const pending = f.run(); await advance(t, 1); await advance(t, 500); await advance(t, 65000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, { code: 'CONTROL_MEDIA_TIMEOUT', stage: 'media_after_resume' });
  assert.equal(result.frames.some(frame => frame.phase === 'after_resume'), false);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1, 2, 3]);
});

for (const filePath of [undefined, null, '', '   ', privatePath]) {
  test(`resume serializes this exact query path using Android Gson rules (${String(filePath)})`, async t => {
    const f = fixture(t, { filePath });
    f.p2p.records = [{ file_path: 'stale-private-path' }];
    const result = await finish(t, f.run());
    assert.equal(result.status, 'completed');
    const data = f.sent.find(item => item.payload.data.cmd === 2).payload.data;
    assert.equal(Object.hasOwn(data, 'file_path'), typeof filePath === 'string');
    if (typeof filePath === 'string') assert.equal(data.file_path, filePath);
    assert.equal(JSON.stringify(f.sent).includes('stale-private-path'), false);
    assert.deepEqual(result.context, {
      filePathMode: filePath === undefined ? 'omitted' : filePath === null ? 'null' : 'string',
      positionSource: 'this_run_video_timestamp', positionOffsetMs: 3456,
    });
  });
}

for (const filePath of [42, {}, []]) {
  test(`probe rejects invalid query path type (${JSON.stringify(filePath)})`, async t => {
    const f = fixture(t, { filePath });
    const result = await f.run();
    assert.equal(result.error.code, 'CONTROL_CONTEXT_UNAVAILABLE');
    assert.equal(f.sent.some(item => [1, 2].includes(item.payload.data.cmd)), false);
  });
}

test('internal controls probe never substitutes request begin or an earlier stream frame for this start position', async t => {
  const f = fixture(t, { noFrame: true, oldFrame: true });
  const pending = f.run(); await advance(t, 15000);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_STARTUP_TIMEOUT');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0]);
  assert.equal(f.p2p.closed, true);
  assert.deepEqual(result.frames, []);
});

test('internal controls probe rejects an invalid connection before querying or sending', async t => {
  const f = fixture(t, { connected: false });
  f.p2p.queryContinuousRecordings = () => assert.fail('Must not query a disconnected session');
  assert.equal((await f.run()).error.code, 'CONTROL_CONNECTION_LOST');
  assert.equal(f.sent.length, 0);
});

test('internal controls probe records rejection without issuing resume or leaking command details', async t => {
  const f = fixture(t, { pauseCode: -5 });
  const pending = f.run(); await advance(t, 1);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_REJECTED');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1, 3]);
  assert.equal(result.operations.find(item => item.operation === 'pause').returnCode, -5);
  assert.equal(JSON.stringify(result).includes('fixture-payload-private'), false);
});

test('internal controls probe ignores a copied marker and wrong channel until the exact customData object returns', async t => {
  let token;
  const f = fixture(t, { pauseReply: ({ customData, reply }) => {
    token = customData; reply({ ...customData }); reply(customData, 0, 2);
  } });
  const pending = f.run(); await advance(t, 1); await advance(t, 500);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
  assert.ok(token);
  f.reply(token); await advance(t, 500); await advance(t, 1);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.channelChecks.queryRejected, 1);
  assert.equal(result.channelChecks.commandRejected, 1);
  assert.equal(result.channelChecks.commandMatched, 4);
});

test('speed candidates come only from the Android continuous playback UI', () => {
  assert.deepEqual(ANDROID_SPEED_CANDIDATES, [1, 2, 4, 8, 16]);
  assert.equal(Object.isFrozen(ANDROID_SPEED_CANDIDATES), true);
});

for (const candidateSpeed of [1, 2, 4, 8, 16]) {
  for (const filePath of [undefined, null, '', privatePath]) {
    test(`candidate ${candidateSpeed} starts once with exact q0 fields and fresh media (${String(filePath)})`, async t => {
      const f = fixture(t, { candidateSpeed, filePath });
      const sender = f.p2p.sendCommandWithStringPayload;
      const result = await finish(t, f.run());
      assert.equal(result.status, 'completed');
      assert.equal(result.requestedSpeed, candidateSpeed);
      assert.equal(result.verificationStatus, 'unverified');
      assert.equal(result.allowedSpeeds, null);
      assert.equal(f.p2p.sendCommandWithStringPayload, sender);
      assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 3]);
      assert.deepEqual(f.sent[0].payload, { commandType: 6001, data: {
        session_id: 125, cmd: 0, begin_time: 100, play_speed: candidateSpeed, play_type: 0,
        device_sn: input.serial, account_id: input.accountId, index: 0,
        ...(typeof filePath === 'string' ? { file_path: filePath } : {}),
      } });
      assert.ok(f.sent[0].customData);
      assert.equal(result.operations[0].correlation, 'custom_data_identity');
      assert.ok(result.frames.some(frame => frame.mediaTimeMs === 103456));
      assert.equal(result.operations.at(-1).returnCode, 0);
    });
  }
}

test('candidate start restores its sender even when sending throws', async t => {
  const f = fixture(t, { candidateSpeed: 2 });
  const sender = () => { throw new Error('fixture-payload-private'); };
  f.p2p.sendCommandWithStringPayload = sender;
  const result = await f.run();
  assert.equal(result.error.code, 'CONTROL_SEND_FAILED');
  assert.equal(f.p2p.sendCommandWithStringPayload, sender);
  assert.equal(f.p2p.closed, true);
});

test('candidate start requires its unique marker and matching channel, then fresh video', async t => {
  let token;
  const f = fixture(t, { candidateSpeed: 2, startReply: ({ customData, reply }) => {
    token = customData; reply(undefined); reply({ ...customData }); reply(customData, 0, 2);
  } });
  const pending = f.run(); await advance(t, 1);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0]);
  f.reply(token); await advance(t, 1);
  f.frame(103456); await advance(t, 1); f.frame(160000);
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.channelChecks.commandRejected, 1);
  assert.equal(result.operations[0].correlation, 'custom_data_identity');
});

test('candidate start cannot replace a preexisting owner or accept an extra numeric speed', async t => {
  const f = fixture(t, { candidateSpeed: 2 });
  const sender = f.p2p.sendCommandWithStringPayload;
  f.p2p.continuousPlayback = { deviceSN: 'other-private', channel: 2 };
  assert.equal((await f.run()).error.code, 'CONTROL_SESSION_BUSY');
  assert.equal(f.p2p.sendCommandWithStringPayload, sender);
  assert.equal((await runPlaybackControlsProbe({ ...input, p2p: f.p2p, candidateSpeed: 3 })).error.code, 'CONTROL_INPUT_INVALID');
  assert.equal(f.sent.length, 0);
});

test('candidate zero return without fresh video is not a completed candidate observation', async t => {
  const f = fixture(t, { candidateSpeed: 2, noFrame: true, oldFrame: true });
  const pending = f.run(); await advance(t, 15000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTROL_STARTUP_TIMEOUT');
  assert.equal(f.p2p.closed, true);
  assert.deepEqual(result.frames, []);
});

test('internal controls probe times out an uncorrelated response, awaits dedicated connection close and sends no further 6001', async t => {
  const f = fixture(t, { pauseReply: ({ customData, reply }) => reply({ ...customData }) });
  let finishClose, settled = false;
  const close = f.p2p.close;
  f.p2p.close = async () => { await new Promise(resolve => { finishClose = resolve; }); await close(); };
  const pending = f.run().then(result => { settled = true; return result; });
  await advance(t, 1); await advance(t, 1500);
  assert.equal(settled, false);
  assert.equal(typeof finishClose, 'function');
  finishClose();
  assert.equal((await pending).error.code, 'CONTROL_TIMEOUT');
  assert.equal(f.p2p.closed, true);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
});

test('internal controls probe does not count an ineffective stop as a confirmed observation', async t => {
  const f = fixture(t);
  f.p2p.stopContinuousPlayback = () => {};
  const pending = f.run();
  await advance(t, 1); await advance(t, 500); await advance(t, 1); await advance(t, 1500);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTROL_TIMEOUT');
  assert.equal(result.operations.at(-1).returnCode, null);
  assert.equal(f.p2p.closed, true);
});

test('internal controls probe terminates its dedicated connection after a rejected stop', async t => {
  const f = fixture(t, { stopCode: -5 });
  const result = await finish(t, f.run());
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTROL_REJECTED');
  assert.equal(result.operations.at(-1).returnCode, -5);
  assert.equal(f.p2p.closed, true);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1, 2, 3]);
});

test('internal controls probe refuses to resume after its short pause budget has elapsed', async t => {
  const f = fixture(t);
  const pending = f.run(); await advance(t, 1); await advance(t, 4000);
  assert.equal((await pending).error.code, 'CONTROL_TIMEOUT');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1, 3]);
});

test('internal controls probe stops after connection loss during pause without treating inactive stop as evidence', async t => {
  const f = fixture(t);
  const pending = f.run(); await advance(t, 1);
  f.p2p.connected = false; f.p2p.continuousPlayback = undefined; f.p2p.currentMessageState[1].p2pStreaming = false;
  f.p2p.emit('close'); await advance(t, 500);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_CONNECTION_LOST');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
  assert.equal(result.operations.some(item => item.operation === 'stop'), false);
});

test('internal controls probe refuses a replaced session and never stops its new owner', async t => {
  const f = fixture(t);
  const pending = f.run(); await advance(t, 1);
  f.p2p.continuousPlayback = { deviceSN: 'other-camera', channel: 2 };
  await advance(t, 500);
  assert.equal((await pending).error.code, 'CONTROL_INACTIVE');
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
});

test('internal controls probe excludes a second runner sharing the same connection', async t => {
  const f = fixture(t);
  const first = f.run();
  assert.equal((await f.run()).error.code, 'CONTROL_SESSION_BUSY');
  assert.equal((await finish(t, first)).status, 'completed');
});

test('internal controls probe sanitizes local command exceptions', async t => {
  const f = fixture(t, { sendError: true });
  const pending = f.run(); await advance(t, 1);
  const result = await pending;
  assert.equal(result.error.code, 'CONTROL_SEND_FAILED');
  assert.equal(JSON.stringify(result).includes('fixture-account-private'), false);
  assert.equal(f.p2p.closed, true);
  assert.deepEqual(f.sent.map(item => item.payload.data.cmd), [0, 1]);
});
