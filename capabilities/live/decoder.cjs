const { spawn } = require('node:child_process');

const fail = code => Object.assign(new Error(code), { code });
// Decode to browser-readable JPEG frames in memory. Private elementary streams,
// pictures and FFmpeg diagnostic text are never written to logs or disk.
function createDecoder({ video, metadata, onFrame, onError, ffmpeg = process.env.EUFY_FFMPEG || 'ffmpeg', spawnProcess = spawn }) {
  if (![0, 1].includes(metadata.videoCodec)) throw fail('LIVE_DECODER_FAILED');
  const child = spawnProcess(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror',
    '-probesize', '32768', '-analyzeduration', '0', '-f', metadata.videoCodec === 1 ? 'hevc' : 'h264', '-i', 'pipe:0',
    '-an', '-vf', 'fps=5,scale=960:-2', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopping = false, buffer = Buffer.alloc(0), closed = false, failed = false, closePromise;
  const report = code => { if (!stopping && !failed) { failed = true; onError(fail(code)); } };
  child.stderr.resume();
  child.stdin.on('error', () => report('LIVE_DECODER_FAILED'));
  child.on('error', error => report(error.code === 'ENOENT' ? 'LIVE_RUNTIME_UNAVAILABLE' : 'LIVE_DECODER_FAILED'));
  const ended = new Promise(resolve => child.once('close', () => { closed = true; buffer = Buffer.alloc(0); report('LIVE_DECODER_FAILED'); resolve(); }));
  child.stdout.on('data', chunk => {
    if (stopping || failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8 * 1024 * 1024) return report('LIVE_DECODER_FAILED');
    let end;
    while ((end = buffer.indexOf(Buffer.from([255, 217]))) !== -1) {
      const frame = buffer.subarray(0, end + 2); buffer = buffer.subarray(end + 2);
      if (frame[0] !== 255 || frame[1] !== 216) return report('LIVE_DECODER_FAILED');
      onFrame(frame);
    }
  });
  video.pipe(child.stdin);
  return { close() {
    if (closePromise) return closePromise;
    stopping = true; video.unpipe(child.stdin); child.stdin.destroy(); buffer = Buffer.alloc(0);
    closePromise = (async () => {
      if (closed) return;
      child.kill();
      const kill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
      let timeout;
      try { await Promise.race([ended, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(fail('LIVE_CLEANUP_FAILED')), 5000); })]); }
      finally { clearTimeout(kill); clearTimeout(timeout); }
    })();
    return closePromise;
  } };
}

module.exports = { createDecoder };
