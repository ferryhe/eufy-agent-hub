const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JobService } = require('../../jobs/service.cjs');
const { normalizeWindow } = require('./time-window.cjs');
const { LocalContinuousRecordings } = require('./continuous.cjs');
const { assessCompleteness } = require('./continuous-completeness.cjs');

const OUTPUT = path.resolve(__dirname, '../../output');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

// Await close, including after abort, before releasing the HomeBase's job slot.
function runProcess(executable, args, { directory, stage, signal }) {
  return new Promise((resolve, reject) => {
    const stdout = fs.openSync(path.join(directory, `${stage}.stdout.log`), 'wx');
    const stderr = fs.openSync(path.join(directory, `${stage}.stderr.log`), 'wx');
    let error;
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', stdout, stderr] });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', cause => { error = cause; });
    child.once('close', code => {
      fs.closeSync(stdout); fs.closeSync(stderr);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (error || code !== 0) {
        const message = error?.code === 'ENOENT'
          ? `Cannot start ${executable}. Configure EUFY_PYTHON (with PyAV installed) and EUFY_FFMPEG.`
          : `${stage} failed (${error?.message || `exit ${code}`}); see ${stage}.stderr.log`;
        return reject(new Error(message));
      }
      resolve();
    });
  });
}

class ContinuousExportService {
  constructor({ session, outputRoot = path.join(OUTPUT, 'continuous-jobs'),
    python = process.env.EUFY_PYTHON || 'python', ffmpeg = process.env.EUFY_FFMPEG || 'ffmpeg',
    createCapture = () => new LocalContinuousRecordings(session), execute = runProcess } = {}) {
    const relative = path.relative(OUTPUT, path.resolve(outputRoot));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('Continuous job outputRoot must be a directory below this repository output/');
    this.python = python; this.ffmpeg = ffmpeg; this.createCapture = createCapture; this.execute = execute;
    this.stopping = new AbortController();
    this.jobs = new JobService({ outputRoot, worker: context => this.export(context) });
  }

  submit({ requestId, homeBaseId, serial, ...time }) {
    // The jobs contract makes identity global and independent of changed request input.
    const existing = this.jobs.list().find(job => job.requestId === requestId);
    if (existing) return existing;
    this.stopping.signal.throwIfAborted();
    if (typeof serial !== 'string' || !serial.trim()) throw new Error('A resolved camera serial is required');
    return this.jobs.submit({ requestId, homeBaseId, input: { serial, window: normalizeWindow(time) } });
  }

  get(jobId) { return this.jobs.get(jobId); }
  whenIdle() { return this.jobs.whenIdle(); }

  async shutdown() {
    this.stopping.abort(new Error('Export service shutting down'));
    for (const job of this.jobs.list()) if (job.state === 'queued') this.jobs.cancelQueued(job.jobId);
    await this.jobs.whenIdle();
  }

  async export(context) {
    const { job, partialDir, artifactsDir, updateProgress, registerArtifact } = context;
    const signal = this.stopping.signal;
    const directory = path.join(partialDir, 'capture');
    const logs = path.join(partialDir, 'logs');
    fs.mkdirSync(logs);
    const { serial, window } = job.input;
    const begin = Date.parse(window.normalized.start) / 1000, end = Date.parse(window.normalized.end) / 1000;
    let capture, acquisition, stage = 'runtime', media, completeness;
    const result = { outcome: 'failed', coverageVerified: false, validation: { passed: false },
      window, coverage: null, media: null, diagnostics: [] };
    const run = (name, executable, args) => {
      stage = name; signal.throwIfAborted();
      return this.execute(executable, args, { directory: logs, stage, signal });
    };
    try {
      updateProgress('runtime', 0.02);
      await run('python-runtime', this.python, ['-c', 'import av; print(av.__version__)']);
      await run('ffmpeg-runtime', this.ffmpeg, ['-version']);
      stage = 'capture'; updateProgress(stage, 0.05); signal.throwIfAborted();
      acquisition = this.createCapture();
      capture = await acquisition.captureRange(serial, begin, end, directory, { signal });
      // Always close our connection before another job on this HomeBase can start.
      acquisition.close(); acquisition = null;
      result.diagnostics.push(...(capture.diagnostics || []));
      completeness = assessCompleteness(capture);
      result.coverage = { video: completeness.streams.video, audio: completeness.streams.audio,
        rangeGaps: completeness.rangeGaps };
      signal.throwIfAborted();
      if (completeness.status === 'failed') throw new Error(`No usable capture: ${completeness.reasons.join(', ')}`);
      updateProgress('mux', 0.55);
      await run('mux', this.python, [path.join(__dirname, 'mux.py'), directory, '--allow-partial']);
      updateProgress('convert', 0.65);
      const candidate = path.join(directory, 'playback.mp4');
      await run('convert', this.ffmpeg, ['-hide_banner', '-nostdin', '-n', '-copyts', '-start_at_zero',
        '-i', path.join(directory, 'timed.ts'), '-map', '0:v:0', '-map', '0:a?',
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac',
        '-metadata', `recording_timezone=${window.normalized.timezone}`, '-movflags', '+faststart+use_metadata_tags', candidate]);
      updateProgress('decode', 0.85);
      await run('decode', this.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', candidate,
        '-map', '0:v:0', '-map', '0:a?', '-progress', 'pipe:1', '-f', 'null', '-']);
      // Decode timestamps too: FFmpeg progress alone can be dominated by the audio tail.
      await run('timeline', this.python, [path.join(__dirname, 'media-timeline.py'), directory]);
      media = JSON.parse(fs.readFileSync(path.join(directory, 'media-timeline.json'), 'utf8'));
      const progress = Object.fromEntries(fs.readFileSync(path.join(logs, 'decode.stdout.log'), 'utf8')
        .trim().split(/\r?\n/).map(line => line.split('=')));
      const video = media.streams.video, audio = media.streams.audio;
      const decode = { status: progress.progress === 'end' && Number(progress.frame) === video?.count && video.count > 0 &&
        (!completeness.streams.audio.count || audio?.count > 0) ? 'passed' : 'failed',
      full: true, videoFrames: video?.count || 0, audioFrames: audio?.count || 0,
      durationMs: video ? video.lastTimestampMs + video.lastDurationMs - video.firstTimestampMs : 0 };
      completeness = assessCompleteness(capture, { decode });
      const rawVideo = completeness.streams.video;
      const expectedFirst = rawVideo.firstTimestampMs - begin * 1000 - media.muxStartMs;
      const spanDifference = video ? Math.abs((video.lastTimestampMs - video.firstTimestampMs) -
        (rawVideo.lastTimestampMs - rawVideo.firstTimestampMs)) : Infinity;
      const timingPreserved = Boolean(video && Math.abs(video.firstTimestampMs - expectedFirst) <= 100 && spanDifference <= 100);
      if (!timingPreserved) {
        completeness.reasons.push('output_timeline_mismatch');
        if (completeness.status === 'complete') completeness.status = 'partial';
      }
      const rawAudio = completeness.streams.audio;
      const audioCoveragePreserved = !rawAudio.count || Boolean(audio && audio.count >= rawAudio.count &&
        Math.abs(audio.firstTimestampMs - (rawAudio.firstTimestampMs - begin * 1000 - media.muxStartMs)) <= 100 &&
        Math.abs((audio.lastTimestampMs - audio.firstTimestampMs) - (rawAudio.lastTimestampMs - rawAudio.firstTimestampMs)) <= 100);
      if (!audioCoveragePreserved) {
        completeness.reasons.push('output_audio_coverage_short');
        if (completeness.status === 'complete') completeness.status = 'partial';
      }
      result.validation = { passed: decode.status === 'passed', decode, timingPreserved, audioCoveragePreserved };
      result.outcome = completeness.status;
      result.coverageVerified = completeness.status === 'complete';
      result.timeline = { acquisitionBaseUnixMs: begin * 1000, muxStartMs: media.muxStartMs,
        mp4ZeroUnixMs: begin * 1000 + media.muxStartMs, streams: media.streams,
        mapping: 'MP4 timestamps = acquisition timestamps - acquisitionBaseUnixMs - muxStartMs',
        timingPreserved, rawVideoFrames: rawVideo.count, decodedVideoFrames: decode.videoFrames };
      signal.throwIfAborted();
      if (decode.status === 'passed') {
        // Only fully decoded candidates are offered as playable, including honest partials.
        const finalPath = result.outcome === 'complete' ? path.join(artifactsDir, 'playback.mp4') : candidate;
        if (finalPath !== candidate) fs.renameSync(candidate, finalPath);
        result.media = { path: path.relative(path.dirname(job.metadataPath), finalPath).split(path.sep).join('/'),
          bytes: fs.statSync(finalPath).size, outcome: result.outcome, playable: true };
      }
    } catch (error) {
      result.outcome = signal.aborted ? 'cancelled' : completeness?.status === 'partial' ? 'partial' : 'failed';
      result.error = { code: signal.aborted ? 'CANCELLED' : 'EXPORT_STAGE_FAILED', message: error.message };
      result.diagnostics.push({ stage, message: error.message });
    } finally {
      try { acquisition?.close(); }
      catch (error) { result.diagnostics.push({ stage: 'close', message: error.message }); result.coverageVerified = false; }
    }
    result.completeness = completeness || null;
    if (result.diagnostics.length && result.outcome === 'complete') result.outcome = 'partial';
    if (result.outcome !== 'complete') result.coverageVerified = false;
    const report = path.join(partialDir, 'result.json');
    writeJson(report, result);
    // Files are diagnostics/raw unless media above explicitly passed complete decoding.
    const register = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) register(file);
        else registerArtifact(path.relative(path.dirname(job.metadataPath), file),
          result.media && path.resolve(path.dirname(job.metadataPath), result.media.path) === file
            ? result.media : { role: 'diagnostic', validated: false });
      }
    };
    register(partialDir); register(artifactsDir);
    return result;
  }
}

module.exports = { ContinuousExportService, runProcess, OUTPUT };
