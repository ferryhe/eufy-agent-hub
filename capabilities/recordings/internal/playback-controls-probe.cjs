// Internal, in-memory acceptance probe. The caller supplies an already connected,
// dedicated adapter; this module never logs in, opens files or publishes controls.
const owners = new WeakSet();
// BottomSpeedDialog click mapping; these are unverified test candidates only.
const ANDROID_SPEED_CANDIDATES = Object.freeze([1, 2, 4, 8, 16]);
const STARTUP_MEDIA_BUDGET_MS = 15000;
class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function runPlaybackControlsProbe({ p2p, serial, accountId, channel, begin, end, candidateSpeed }) {
  const result = { version: 1, status: 'failed', verificationStatus: 'unverified', error: null,
    operations: [], frames: [], allowedSpeeds: null,
    channelChecks: { queryMatched: 0, queryRejected: 0, commandMatched: 0, commandRejected: 0 },
    startup: { startedAtMs: null, firstVideoAtMs: null, localStreamStoppedAtMs: null, mediaBudgetMs: STARTUP_MEDIA_BUDGET_MS,
      frameEvents: 0, filteredFrames: { notOwned: 0, wrongChannel: 0, invalidTime: 0, beforeWindow: 0 } },
    channelIsolation: { status: 'unverified', reason: 'projected_channel_only_no_independent_observation' } };
  if (candidateSpeed !== undefined) result.requestedSpeed = candidateSpeed;
  let claimed = false, owner, unresolvedCommand = false, phase = 'before_pause', stage = 'admission', lastVideo;
  let pausePosition, pauseMediaAdvanced = false;
  let startupVideo, originalStreamWait, originalEndStream, startupTimeoutChanged = false;
  const connected = () => {
    if (!p2p.isConnected()) throw new ProbeError('CONTROL_CONNECTION_LOST');
  };
  // Internal access is intentional: the public frame channel is a projection and
  // isLiveStreaming(channel) alone cannot identify who owns this continuous run.
  const ownsStream = () => owner && p2p.continuousPlayback === owner && p2p.currentMessageState[1].p2pStreaming;
  const requireOwned = () => {
    connected();
    if (!claimed || !owners.has(p2p) || !ownsStream()) throw new ProbeError('CONTROL_INACTIVE');
  };
  function restoreStreamTimeout(rearm = false) {
    if (!startupTimeoutChanged) return;
    p2p.setStreamTimeouts({ streamDataWait: originalStreamWait });
    startupTimeoutChanged = false;
    if (ownsStream()) {
      if (rearm) p2p.waitForStreamData(1, true);
      else {
        clearTimeout(p2p.currentMessageState[1].p2pStreamingTimeout);
        p2p.currentMessageState[1].p2pStreamingTimeout = undefined;
      }
    }
  }
  const onFrame = frame => {
    result.startup.frameEvents++;
    const filtered = result.startup.filteredFrames;
    if (!ownsStream()) { filtered.notOwned++; return; }
    if (frame.channel !== channel) { filtered.wrongChannel++; return; }
    if (!['video', 'audio'].includes(frame.kind)) return;
    if (!Number.isSafeInteger(frame.timestamp)) { filtered.invalidTime++; return; }
    if (frame.timestamp < begin * 1000) { filtered.beforeWindow++; return; }
    const observation = { phase, kind: frame.kind, observedAtMs: Date.now(), mediaTimeMs: frame.timestamp,
      projectedChannel: frame.channel };
    result.frames.push(observation);
    if (frame.kind === 'video') lastVideo = observation;
    if (!startupVideo && frame.kind === 'video' && frame.timestamp < end * 1000
      && observation.observedAtMs < result.startup.startedAtMs + STARTUP_MEDIA_BUDGET_MS) {
      startupVideo = observation;
      result.startup.firstVideoAtMs = observation.observedAtMs;
      // The parser has just armed its data timer. Restore both its setting and
      // that timer immediately, before any pause or subsequent media handling.
      restoreStreamTimeout(true);
    }
    if (phase === 'paused' && frame.kind === 'video' && frame.timestamp > pausePosition) pauseMediaAdvanced = true;
  };
  const drain = (streamChannel, _metadata, video, audio) => {
    if (streamChannel === channel && ownsStream()) { video.resume(); audio.resume(); }
  };
  function wait(event, select, action, timeoutMs, { allowStop = false, timeoutCode = 'CONTROL_TIMEOUT', resolveOnTimeout = false } = {}) {
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer); p2p.off(event, receive); p2p.off('close', disconnected); p2p.off('livestream stopped', stopped);
      };
      const finish = (error, value) => { clean(); error ? reject(error) : resolve(value); };
      const receive = (...args) => {
        try { const value = select(...args); if (value !== undefined) finish(null, value); }
        catch (error) { finish(error); }
      };
      const disconnected = () => finish(new ProbeError('CONTROL_CONNECTION_LOST'));
      const stopped = streamChannel => {
        if (!allowStop && streamChannel === channel) finish(new ProbeError('CONTROL_INACTIVE'));
      };
      const timer = setTimeout(() => finish(resolveOnTimeout ? null : new ProbeError(timeoutCode)), timeoutMs);
      p2p.on(event, receive); p2p.on('close', disconnected); p2p.on('livestream stopped', stopped);
      try { action(); } catch (error) { finish(error instanceof ProbeError ? error : new ProbeError('CONTROL_SEND_FAILED')); }
    });
  }
  async function command(operation, action, marker, timeoutMs = 1500) {
    stage = operation;
    const observation = { operation, sentAtMs: Date.now(), receivedAtMs: null, returnCode: null,
      mediaTimeBeforeMs: lastVideo?.mediaTimeMs ?? null, mediaTimeAtReplyMs: null,
      correlation: marker ? 'custom_data_identity' : 'exclusive_serial' };
    result.operations.push(observation);
    if (operation === 'start') result.startup.startedAtMs = observation.sentAtMs;
    unresolvedCommand = true;
    await wait('command', response => {
      if (response.command_type !== 6001) return;
      if (response.channel !== channel) { result.channelChecks.commandRejected++; return; }
      if (response.customData !== marker) return;
      result.channelChecks.commandMatched++;
      observation.receivedAtMs = Date.now(); observation.mediaTimeAtReplyMs = lastVideo?.mediaTimeMs ?? null;
      if (!Number.isInteger(response.return_code)) throw new ProbeError('CONTROL_RESPONSE_INVALID');
      observation.returnCode = response.return_code;
      unresolvedCommand = false;
      if (response.return_code !== 0) throw new ProbeError('CONTROL_REJECTED');
      // Start observing at the acknowledgement itself, including frames emitted
      // before the awaiting continuation gets its next turn.
      if (operation === 'pause') { pausePosition = observation.mediaTimeBeforeMs; phase = 'paused'; }
      return true;
    }, action, timeoutMs, { allowStop: operation === 'stop' });
    return observation;
  }
  function waitVideo(predicate, timeoutMs, timeoutCode) {
    requireOwned();
    if (lastVideo && predicate(lastVideo)) return Promise.resolve();
    return wait('continuous playback frame', () => {
      requireOwned();
      if (lastVideo && predicate(lastVideo)) return true;
    }, () => {}, timeoutMs, { timeoutCode });
  }
  function control(cmd, filePath, position) {
    requireOwned();
    const marker = {};
    return command(cmd === 1 ? 'pause' : 'resume', () => p2p.sendCommandWithStringPayload({
      commandType: 1700, channel, value: JSON.stringify({ commandType: 6001, data: {
        session_id: 125, cmd, play_type: 0, play_speed: 1, begin_time: position,
        file_path: filePath, device_sn: serial, index: 0,
      } }),
    }, marker), marker);
  }
  try {
    if (!Number.isInteger(channel) || channel < 0 || !Number.isSafeInteger(begin) || begin < 0
      || !Number.isSafeInteger(end) || end <= begin || end - begin > 60
      || (candidateSpeed !== undefined && !ANDROID_SPEED_CANDIDATES.includes(candidateSpeed))
      || typeof serial !== 'string' || !serial || typeof accountId !== 'string' || !accountId)
      throw new ProbeError('CONTROL_INPUT_INVALID');
    connected();
    const isPlayback = item => item.nestedCommandType === 6001 || item.commandType === 6001;
    if (owners.has(p2p) || p2p.continuousPlayback || p2p.isCurrentlyStreaming()
      || [...p2p.messageStates.values()].some(isPlayback) || p2p.sendQueue.some(isPlayback))
      throw new ProbeError('CONTROL_SESSION_BUSY');
    owners.add(p2p); claimed = true;
    p2p.on('continuous playback frame', onFrame); p2p.on('livestream started', drain);
    stage = 'query_context';
    const response = await wait('continuous recording ranges', (responseChannel, data) => {
      if (responseChannel !== channel) { result.channelChecks.queryRejected++; return; }
      if (data.begin_time === begin && data.end_time === end) { result.channelChecks.queryMatched++; return data; }
    }, () => p2p.queryContinuousRecordings(serial, channel, begin, end), 15000);
    connected();
    // Android assigns the current record's path; default Gson omits null. Keep
    // missing/null distinct in evidence, and preserve actual strings including ''.
    const records = response.videos.filter(row => Number.isSafeInteger(row.start_time) && Number.isSafeInteger(row.stop_time)
      && row.start_time <= begin && row.stop_time >= end);
    if (records.length !== 1 || (Object.hasOwn(records[0], 'file_path')
      && records[0].file_path !== null && typeof records[0].file_path !== 'string'))
      throw new ProbeError('CONTROL_CONTEXT_UNAVAILABLE');
    const record = records[0];
    const filePath = typeof record.file_path === 'string' ? record.file_path : undefined;
    result.context = { filePathMode: !Object.hasOwn(record, 'file_path') ? 'omitted' : record.file_path === null ? 'null' : 'string',
      positionSource: null, positionOffsetMs: null };
    stage = 'startup_context';
    originalStreamWait = p2p.streamTimeouts?.streamDataWait;
    if (!Number.isFinite(originalStreamWait) || originalStreamWait <= 0 || typeof p2p.setStreamTimeouts !== 'function'
      || typeof p2p.waitForStreamData !== 'function' || typeof p2p.endStream !== 'function')
      throw new ProbeError('CONTROL_CONTEXT_UNAVAILABLE');
    originalEndStream = p2p.endStream;
    // A pre-first-media endStream does not emit the public stopped event. Record
    // the local transition while leaving the adapter's synchronous behavior intact.
    p2p.endStream = function (dataType, ...args) {
      const wasOwned = dataType === 1 && ownsStream();
      try { return originalEndStream.call(this, dataType, ...args); }
      finally {
        if (wasOwned && !ownsStream()) result.startup.localStreamStoppedAtMs = Date.now();
      }
    };
    const startMarker = candidateSpeed === undefined ? undefined : {};
    await command('start', () => {
      connected();
      p2p.setStreamTimeouts({ streamDataWait: STARTUP_MEDIA_BUDGET_MS });
      startupTimeoutChanged = true;
      const previous = p2p.continuousPlayback;
      const sender = p2p.sendCommandWithStringPayload;
      if (candidateSpeed !== undefined) {
        let sent = false;
        // Reuse the adapter's VIDEO setup, replacing its single synchronous
        // start send with q0's fields. Never send a speed-1 start first.
        p2p.sendCommandWithStringPayload = function (command) {
          const payload = JSON.parse(command.value);
          if (sent || !owners.has(p2p) || p2p.continuousPlayback?.deviceSN !== serial
            || p2p.continuousPlayback.channel !== channel || !p2p.currentMessageState[1].p2pStreaming
            || command.commandType !== 1700 || command.channel !== channel
            || payload.commandType !== 6001 || payload.data.cmd !== 0)
            throw new ProbeError('CONTROL_INACTIVE');
          sent = true;
          return sender.call(p2p, { ...command, value: JSON.stringify({ commandType: 6001, data: {
            session_id: 125, cmd: 0, begin_time: begin, play_speed: candidateSpeed, play_type: 0,
            device_sn: serial, account_id: accountId, index: 0, file_path: filePath,
          } }) }, startMarker);
        };
      }
      try { p2p.startContinuousPlayback(serial, channel, accountId, begin); }
      finally {
        p2p.sendCommandWithStringPayload = sender;
        const current = p2p.continuousPlayback;
        if (current !== previous && current?.deviceSN === serial && current.channel === channel) owner = current;
      }
    }, startMarker, STARTUP_MEDIA_BUDGET_MS);
    const deadline = Date.now() + (end - begin) * 1000 + 5000;
    stage = 'media_context';
    const remainingStartupMs = result.startup.startedAtMs + STARTUP_MEDIA_BUDGET_MS - Date.now();
    if (!startupVideo && remainingStartupMs <= 0) throw new ProbeError('CONTROL_STARTUP_TIMEOUT');
    await waitVideo(() => Boolean(startupVideo), Math.max(1, remainingStartupMs), 'CONTROL_STARTUP_TIMEOUT');
    requireOwned();
    result.context.positionSource = 'this_run_video_timestamp';
    result.context.positionOffsetMs = startupVideo.mediaTimeMs - begin * 1000;
    if (candidateSpeed !== undefined) {
      stage = 'candidate_media';
      await waitVideo(video => video.mediaTimeMs >= end * 1000, Math.max(1, deadline - Date.now()), 'CONTROL_MEDIA_TIMEOUT');
      result.status = 'completed';
      return result;
    }
    phase = 'pause_pending';
    const pause = await control(1, '', 0);
    stage = 'pause_observation';
    result.pauseWindow = { startedAtMs: pause.receivedAtMs, endedAtMs: null, mediaTimeBeforeMs: pause.mediaTimeBeforeMs };
    const checkPause = () => {
      if (pauseMediaAdvanced) throw new ProbeError('PAUSE_MEDIA_ADVANCED');
      requireOwned();
    };
    try {
      checkPause();
      await wait('continuous playback frame', checkPause, () => {}, 500, { resolveOnTimeout: true });
    } finally { result.pauseWindow.endedAtMs = Date.now(); }
    stage = 'resume_context';
    requireOwned();
    // A slow event loop must not resume a stream after the adapter's 5 s idle
    // deadline. Return a local timeout instead of misclassifying device support.
    if (Date.now() - pause.sentAtMs >= 4000) throw new ProbeError('CONTROL_TIMEOUT');
    if (!lastVideo || lastVideo.mediaTimeMs < begin * 1000 || lastVideo.mediaTimeMs >= end * 1000)
      throw new ProbeError('CONTROL_CONTEXT_UNAVAILABLE');
    phase = 'resume_pending';
    result.context.positionOffsetMs = lastVideo.mediaTimeMs - begin * 1000;
    await control(2, filePath, Math.floor(lastVideo.mediaTimeMs / 1000));
    phase = 'after_resume'; stage = 'media_after_resume';
    await waitVideo(video => video.phase === 'after_resume' && video.mediaTimeMs >= end * 1000,
      Math.max(1, deadline - Date.now()), 'CONTROL_MEDIA_TIMEOUT');
    result.status = 'completed';
  } catch (error) {
    result.error = { code: error instanceof ProbeError ? error.code : 'CONTROL_OBSERVATION_FAILED', stage };
  } finally {
    if (claimed) {
      let stopFailed = false;
      const startupIncomplete = result.startup.startedAtMs !== null && !startupVideo;
      const cleanupFailure = error => {
        const failure = { code: error instanceof ProbeError ? error.code : 'CONTROL_CLEANUP_FAILED', stage: 'stop' };
        if (result.error) result.cleanupError = failure;
        else result.error = failure;
      };
      try { restoreStreamTimeout(); }
      catch (error) { stopFailed = true; cleanupFailure(error); }
      if (!unresolvedCommand && !pauseMediaAdvanced && !startupIncomplete && p2p.isConnected() && ownsStream()) {
        try { await command('stop', () => p2p.stopContinuousPlayback(), undefined); }
        catch (error) { stopFailed = true; cleanupFailure(error); }
      }
      // Unconfirmed commands or advancing media during pause prohibit another
      // control, including stop. Await termination of this dedicated connection.
      if ((unresolvedCommand || stopFailed || pauseMediaAdvanced || startupIncomplete) && owner && p2p.isConnected()
        && (p2p.continuousPlayback === owner || (!p2p.continuousPlayback && !p2p.isCurrentlyStreaming()))) {
        try {
          await p2p.close();
          if (p2p.isConnected()) throw new ProbeError('CONTROL_CLEANUP_FAILED');
          result.connectionTerminated = true;
        }
        catch (error) { cleanupFailure(error); }
      }
      p2p.off('continuous playback frame', onFrame); p2p.off('livestream started', drain);
      if (originalEndStream) p2p.endStream = originalEndStream;
      owners.delete(p2p);
    }
    if (result.error) result.status = 'failed';
  }
  return result;
}

module.exports = { runPlaybackControlsProbe, ANDROID_SPEED_CANDIDATES };
