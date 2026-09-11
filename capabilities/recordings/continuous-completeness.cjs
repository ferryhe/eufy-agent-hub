// Conservative observation rule, not a claim that the source produced no missing frames.
// Until hardware establishes a different cadence, gaps greater than 100 ms need review.
const MAX_FRAME_DELTA_MS = 100;

function recordingSegments(ranges, begin, end) {
  const segments = [];
  let coveredUntil = begin;
  for (const range of [...ranges].sort((a,b)=>a.start_time-b.start_time)) {
    if (!Number.isSafeInteger(range.start_time) || !Number.isSafeInteger(range.stop_time) || range.stop_time <= range.start_time)
      throw new Error('Invalid continuous recording range');
    const start = Math.max(begin, range.start_time, coveredUntil);
    const stop = Math.min(end, range.stop_time);
    if (stop <= start) continue;
    segments.push({begin:start,end:stop});
    coveredUntil = stop;
  }
  return segments;
}

function assessCompleteness(capture, {decode = {status:'not_run',full:false}} = {}) {
  const reasons = [];
  const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
  const beginMs = capture.begin * 1000, endMs = capture.end * 1000;
  const rangeGaps = [];
  let cursor = beginMs;
  for (const segment of recordingSegments(capture.ranges || [],capture.begin,capture.end)) {
    if (segment.begin * 1000 > cursor) rangeGaps.push({beginMs:cursor,endMs:segment.begin * 1000});
    cursor = segment.end * 1000;
  }
  if (cursor < endMs) rangeGaps.push({beginMs:cursor,endMs});
  if (rangeGaps.length) add('recording_range_gap');
  const streams = {};
  for (const kind of ['video','audio']) {
    const frames = capture.frames.filter(frame=>frame.kind === kind);
    const timestamps = frames.map(frame=>frame.timestamp);
    const positiveDeltas = timestamps.slice(1).map((timestamp,i)=>timestamp-timestamps[i]).filter(delta=>Number.isFinite(delta) && delta > 0);
    const smallestDelta = positiveDeltas.length ? positiveDeltas.reduce((smallest,delta)=>Math.min(smallest,delta)) : null;
    const gapLimitMs = smallestDelta === null ? MAX_FRAME_DELTA_MS : Math.min(MAX_FRAME_DELTA_MS,smallestDelta*1.5);
    const gaps = [], discontinuities = [];
    for (let i=0; i<timestamps.length; i++) {
      const current = timestamps[i], previous = timestamps[i-1];
      if (!Number.isSafeInteger(current) || current < beginMs || current >= endMs) {
        discontinuities.push({index:i,reason:'invalid_timestamp'});
      } else if (i && current <= previous) {
        discontinuities.push({index:i,reason:'non_increasing_timestamp',previousMs:previous,timestampMs:current});
      } else if (i && current - previous > gapLimitMs) {
        gaps.push({beginMs:previous,endMs:current,deltaMs:current-previous});
      }
    }
    streams[kind] = {count:frames.length,gapLimitMs,firstTimestampMs:timestamps[0] ?? null,lastTimestampMs:timestamps.at(-1) ?? null,gaps,discontinuities};
    if (gaps.length) add(`${kind}_timestamp_gap`);
    if (discontinuities.length) add(`${kind}_timestamp_discontinuity`);
    if (frames.some(frame=>!(frame.length > 0))) add('empty_frame');
  }
  const video = capture.frames.filter(frame=>frame.kind === 'video');
  const usable = video.length > 0 && video[0].keyFrame && video[0].length > 0;
  if (!video.length) add('no_video');
  else if (!usable) add('no_initial_keyframe');
  if (video.length && streams.video.firstTimestampMs !== beginMs) add('leading_gap');
  if (!capture.reachedEnd) add('end_not_reached');
  const segments = capture.segments || [];
  if (!segments.length || segments.some(segment=>!segment.reachedEnd)) add('segment_not_completed');
  for (const segment of segments) {
    const frames = video.filter(frame=>frame.timestamp >= segment.begin * 1000 && frame.timestamp < segment.end * 1000);
    if (!frames.length || !frames[0].keyFrame || frames[0].timestamp !== segment.begin * 1000) add('segment_leading_gap');
    const last = frames.at(-1)?.timestamp;
    if (last === undefined || !Number.isSafeInteger(segment.boundaryTimestampMs) ||
        segment.boundaryTimestampMs < segment.end * 1000 || segment.boundaryTimestampMs - last > streams.video.gapLimitMs)
      add('trailing_gap');
  }
  if (streams.audio.count && (streams.audio.firstTimestampMs - beginMs > MAX_FRAME_DELTA_MS || endMs - streams.audio.lastTimestampMs > MAX_FRAME_DELTA_MS))
    add('audio_boundary_gap');
  if (capture.diagnostics?.length) add('capture_error');
  if (decode.status !== 'passed' || decode.full !== true) add('decode_not_verified');
  else if (!(decode.videoFrames >= video.length && decode.videoFrames > 0) || !(decode.durationMs >= endMs-beginMs-MAX_FRAME_DELTA_MS))
    add('decoded_coverage_short');
  return {status:!usable ? 'failed' : reasons.length ? 'partial' : 'complete',
    ruleVersion:1,maxFrameDeltaMs:MAX_FRAME_DELTA_MS,requested:{beginMs,endMs},
    streams,rangeGaps,reasons,decode};
}

module.exports = { recordingSegments, assessCompleteness };
