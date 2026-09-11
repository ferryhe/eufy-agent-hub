const fs = require('node:fs');
const path = require('node:path');
const { LocalRecordings, waitFor } = require('./events.cjs');

// Use a separate instance so historical playback cannot replace the page's live connection.
class LocalContinuousRecordings extends LocalRecordings {
  async listRange(serial, begin, end) {
    await this.connect(serial);
    const p2p = this.station.p2pSession;
    return waitFor(p2p, 'continuous recording ranges',
      () => p2p.queryContinuousRecordings(serial, this.camera.getChannel(), begin, end),
      (channel, data) => channel === this.camera.getChannel() && data.begin_time === begin && data.end_time === end ? data : undefined,
      15000);
  }

  async captureRange(serial, begin, end, directory) {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin) throw new Error('录像时间范围无效。');
    if (this.capturing) throw new Error('正在提取录像。');
    this.capturing = true;
    let fd, p2p, frameListener, commandListener, errorListener, closeListener, drain;
    const index = [];
    let offset = 0, started = false, reachedEnd = false;
    try {
      const ranges = await this.listRange(serial, begin, end);
      if (!ranges.videos.some(v => v.start_time <= begin && v.stop_time >= end)) throw new Error('该时段没有完整的连续录像。');
      fs.mkdirSync(directory, { recursive: true });
      fd = fs.openSync(path.join(directory, 'frames.bin'), 'wx');
      p2p = this.station.p2pSession;
      // The ordinary video streams are not used here: their byte-only interface loses timestamps.
      drain = (_channel, _metadata, video, audio) => { video.resume(); audio.resume(); };
      p2p.on('livestream started', drain);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('提取超时，未收到结束时间的画面。')), (end - begin + 30) * 2000);
        let done = false;
        const finish = error => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        frameListener = frame => {
          if (done || frame.channel !== this.camera.getChannel()) return;
          if (frame.kind === 'video' && frame.timestamp >= end * 1000) { reachedEnd = true; finish(); return; }
          if (frame.timestamp < begin * 1000 || frame.timestamp >= end * 1000) return;
          if (!started) {
            if (frame.kind !== 'video' || !frame.keyFrame) return;
            started = true;
          }
          try {
            fs.writeSync(fd, frame.data);
            const { data, ...metadata } = frame;
            index.push({ ...metadata, offset, length: data.length });
            offset += data.length;
          } catch (error) { finish(error); }
        };
        commandListener = result => {
          if (result.command_type === 6001 && result.channel === this.camera.getChannel() && result.return_code !== 0)
            finish(new Error(`回放命令失败：${result.return_code}`));
        };
        errorListener = (_channel, error) => finish(error);
        closeListener = () => finish(new Error('HomeBase 连接中断。'));
        p2p.on('continuous playback frame', frameListener);
        p2p.on('command', commandListener);
        p2p.on('livestream error', errorListener);
        p2p.on('livestream stopped', closeListener);
        p2p.on('close', closeListener);
        try { p2p.startContinuousPlayback(serial, this.camera.getChannel(), this.session.api.userId, begin); }
        catch (error) { finish(error); }
      });
      if (!started) throw new Error('没有收到可解码的视频关键帧。');
      const result = { serial, begin, end, reachedEnd, bytes: offset, frames: index };
      fs.writeFileSync(path.join(directory, 'frames.json'), JSON.stringify(result));
      return result;
    } finally {
      if (p2p) {
        p2p.off('continuous playback frame', frameListener);
        p2p.off('command', commandListener);
        p2p.off('livestream error', errorListener);
        p2p.off('livestream stopped', closeListener);
        p2p.off('close', closeListener);
        p2p.stopContinuousPlayback();
        p2p.off('livestream started', drain);
      }
      if (fd !== undefined) fs.closeSync(fd);
      this.capturing = false;
    }
  }
}

module.exports = { LocalContinuousRecordings };
