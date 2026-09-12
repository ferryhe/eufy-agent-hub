const { spawn } = require('node:child_process');

// Full decode of the complete bounded JPEG sample collected by the acceptance
// host. Input pictures stay in memory; only progress counts enter the proof.
async function decodeSample(frames, { ffmpeg = process.env.EUFY_FFMPEG || 'ffmpeg' } = {}) {
  if (!frames.length) throw Object.assign(new Error('LIVE_DECODER_FAILED'), { code: 'LIVE_DECODER_FAILED' });
  const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror',
    '-f', 'mjpeg', '-i', 'pipe:0', '-map', '0:v:0', '-f', 'null', '-', '-progress', 'pipe:1'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let progress = '', errorCode, timedOut = false;
  child.stdout.on('data', chunk => { progress = (progress + chunk.toString()).slice(-8192); });
  child.stderr.resume(); child.stdin.on('error', () => {});
  child.on('error', error => { errorCode = error.code === 'ENOENT' ? 'LIVE_RUNTIME_UNAVAILABLE' : 'LIVE_DECODER_FAILED'; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
  const exitCode = await new Promise(resolve => {
    child.once('close', resolve);
    child.stdin.end(Buffer.concat(frames));
  });
  clearTimeout(timer);
  if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
  const decodedFrames = Number([...progress.matchAll(/(?:^|\n)frame=(\d+)/g)].at(-1)?.[1] || 0);
  return { passed: !timedOut && exitCode === 0 && decodedFrames === frames.length && progress.includes('progress=end'),
    decodedFrames, exitCode, childClosed: true };
}

module.exports = { decodeSample };
