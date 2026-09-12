const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { finished: streamFinished } = require('node:stream/promises');
const { failure } = require('./errors.cjs');

// Decode every input frame and encode a video-only fragmented MP4. Runtime output
// is not a capability verification record; hardware acceptance retains/full-decodes a sample.
function createRuntime({ video, codec, ffmpeg = process.env.EUFY_FFMPEG || 'ffmpeg' }) {
  const runtime = new EventEmitter();
  runtime.output = new PassThrough({ highWaterMark: 1024 * 1024 });
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-xerror', '-fflags', '+genpts',
    '-probesize', '32768', '-analyzeduration', '0', '-f', codec, '-i', 'pipe:0', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-g', '15', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  runtime.pid = child.pid || null;
  let closing = false, closed = false, launchError = false, killTimer, closingPromise, runtimeError;
  const fail = code => { runtimeError ||= failure(code); if (!closing) runtime.emit('failure', runtimeError); };
  child.once('error', () => { launchError = true; fail('LIVE_RUNTIME_ERROR'); });
  child.stdin.on('error', () => fail('LIVE_DECODER_ERROR'));
  child.stdout.on('error', () => fail('LIVE_RUNTIME_ERROR'));
  child.stderr.resume(); // Never return command output, account data or filesystem paths to clients.
  child.stdout.once('data', () => runtime.emit('ready'));
  child.stdout.pipe(runtime.output);
  video.pipe(child.stdin);
  const childFinished = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; clearTimeout(killTimer);
    if (!closing) fail(launchError ? 'LIVE_RUNTIME_ERROR' : 'LIVE_DECODER_ERROR');
    resolve({ code, signal });
  }));
  runtime.close = ({ graceful = false, signal, drainMs = 10000 } = {}) => closingPromise ||= (async () => {
    closing = true; video.unpipe(child.stdin);
    let mediaError, drainTimer;
    const force = () => {
      child.stdin.destroy(); child.stdout.unpipe(runtime.output); child.stdout.destroy(); runtime.output.destroy();
      if (!closed && !killTimer) { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }
    };
    const abort = () => { mediaError ||= signal?.reason || failure('LIVE_MEDIA_TIMEOUT'); force(); };
    // A child can exit while the PassThrough still buffers complete MP4 fragments.
    // Wait for its readable end as well; the session separately awaits response finish.
    const drained = graceful ? streamFinished(runtime.output, { readable: true, writable: false, cleanup: true })
      .catch(() => { mediaError ||= failure('LIVE_CONNECTION_LOST'); force(); }) : Promise.resolve();
    if (graceful) {
      signal?.addEventListener('abort', abort, { once: true });
      drainTimer = setTimeout(abort, drainMs);
      if (signal?.aborted) abort(); else child.stdin.end();
    } else force();
    const result = await childFinished;
    if (graceful && (result.code !== 0 || result.signal || runtimeError)) {
      mediaError ||= runtimeError || failure('LIVE_DECODER_ERROR'); force();
    }
    await drained;
    clearTimeout(drainTimer); signal?.removeEventListener('abort', abort);
    runtime.output.destroy();
    // Media failure is distinct from leaked resources: the child and output are
    // closed, so the session may release its lease while reporting a failed stream.
    return { error: graceful ? mediaError || null : null };
  })();
  return runtime;
}
module.exports = { createRuntime };
