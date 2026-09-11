const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serviceError } = require('../../api/messages.cjs');

function ffmpegPath() {
  if (process.env.EUFY_FFMPEG) return process.env.EUFY_FFMPEG;
  return 'ffmpeg';
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    let log = '';
    child.stderr.on('data', chunk => { log = (log + chunk.toString()).slice(-20000); });
    child.stdout.resume();
    child.on('error', error => reject(error.code === 'ENOENT'
      ? serviceError('未找到 FFmpeg，请设置 EUFY_FFMPEG 为可执行文件路径，或将 FFmpeg 加入 PATH。', 'service.recordings.ffmpegMissing', {}, { cause: error })
      : error));
    child.on('close', code => code === 0 ? resolve(log) : reject(serviceError(`视频处理失败：${log.slice(-2000)}`, 'service.recordings.processingFailed', { detail: log.slice(-2000) })));
  });
}

async function exportRecording(prefix, destination) {
  const info = JSON.parse(fs.readFileSync(prefix + '.json', 'utf8'));
  if (!info.complete) throw serviceError('下载未确认完成。', 'service.recordings.downloadUnconfirmed');
  const videoFormat = info.metadata.videoCodec === 1 ? 'hevc' : 'h264';
  const input = ['-r', String(info.metadata.videoFPS), '-f', videoFormat, '-i', prefix + '.video'];
  const hasAudio = fs.statSync(prefix + '.audio').size > 0;
  if (hasAudio) input.push('-f', 'aac', '-i', prefix + '.audio');
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  await runFfmpeg(['-y', ...input, '-map', '0:v:0', ...(hasAudio ? ['-map', '1:a:0'] : []),
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', destination]);
  // Decode every frame; an existing file alone is not a successful export.
  await runFfmpeg(['-v','error','-xerror','-i',destination,'-f','null','-']);
  return { file: destination, bytes: fs.statSync(destination).size, start: info.record.start_time,
    end: info.record.end_time, timezone: 'America/Toronto', recordId: info.record.record_id };
}

module.exports = { exportRecording, runFfmpeg };
