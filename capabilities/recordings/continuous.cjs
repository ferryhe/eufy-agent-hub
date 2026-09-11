const fs = require('node:fs');
const path = require('node:path');
const { LocalRecordings, waitFor } = require('./events.cjs');
const { recordingSegments, assessCompleteness } = require('./continuous-completeness.cjs');

// Use a separate instance so historical playback cannot replace the page's live connection.
class LocalContinuousRecordings extends LocalRecordings {
  async listRange(serial, begin, end, {signal} = {}) {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin) throw new Error('录像时间范围无效。');
    await this.connect(serial);
    signal?.throwIfAborted();
    const p2p = this.station.p2pSession;
    return waitFor(p2p, 'continuous recording ranges',
      () => p2p.queryContinuousRecordings(serial, this.camera.getChannel(), begin, end),
      (channel, data) => channel === this.camera.getChannel() && data.begin_time === begin && data.end_time === end ? data : undefined,
      15000);
  }

  async captureRange(serial, begin, end, directory, {signal} = {}) {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || end <= begin) throw new Error('录像时间范围无效。');
    if (this.capturing) throw new Error('正在提取录像。');
    this.capturing = true;
    let fd;
    const result = {serial,begin,end,reachedEnd:false,bytes:0,frames:[],ranges:[],segments:[],diagnostics:[]};
    try {
      fs.mkdirSync(directory, {recursive:true});
      if (fs.existsSync(path.join(directory,'frames.json'))) throw new Error('Capture manifest already exists');
      fd = fs.openSync(path.join(directory,'frames.bin'),'wx');
      try {
        signal?.throwIfAborted();
        const response = await this.listRange(serial,begin,end,{signal});
        signal?.throwIfAborted();
        const segments = recordingSegments(response.videos,begin,end);
        result.ranges = response.videos;
        for (const segment of segments) {
          signal?.throwIfAborted();
          result.segments.push(segment);
          await this.captureSegment(serial,segment,fd,result,signal);
          signal?.throwIfAborted();
        }
        result.reachedEnd = Boolean(result.segments.length && result.segments.at(-1).end === end && result.segments.at(-1).reachedEnd);
      } catch (error) {
        result.diagnostics.push({stage:signal?.aborted ? 'cancelled' : 'capture',
          message:signal?.aborted ? 'Continuous capture cancelled' : error.message});
        if (signal?.aborted) {
          // Setup may have installed a connection after the runner's earlier close request.
          try { this.close(); }
          catch (closeError) { result.diagnostics.push({stage:'close',message:closeError.message}); }
        }
      }
      // Partial raw data and index are retained even on disconnect, rejection or timeout.
      fs.closeSync(fd); fd = undefined;
      result.completeness = assessCompleteness(result);
      result.status = result.completeness.status;
      fs.writeFileSync(path.join(directory,'frames.json'),JSON.stringify(result,null,2),{flag:'wx'});
      return result;
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); }
      finally { this.capturing = false; }
    }
  }

  async captureSegment(serial, segment, fd, result, signal) {
    const p2p = this.station.p2pSession, channel = this.camera.getChannel();
    let frameListener, commandListener, errorListener, stoppedListener, closeListener, cancellationListener;
    // The ordinary streams lose timestamps; drain those while recording individual packets.
    const drain = (streamChannel,_metadata,video,audio) => {
      if (streamChannel === channel) { video.resume(); audio.resume(); }
    };
    p2p.on('livestream started',drain);
    try {
      await new Promise((resolve,reject)=>{
        let done = false, started = false;
        const finish = error => {
          if (done) return;
          done = true; clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(()=>finish(new Error('提取超时，未收到结束时间的画面。')),(segment.end-segment.begin+30)*2000);
        frameListener = frame => {
          if (done || frame.channel !== channel) return;
          if (!Number.isSafeInteger(frame.timestamp)) { finish(new Error('Invalid playback timestamp')); return; }
          if (frame.kind === 'video' && frame.timestamp >= segment.end * 1000) {
            segment.reachedEnd = true; segment.boundaryTimestampMs = frame.timestamp; finish(); return;
          }
          if (frame.timestamp < segment.begin * 1000 || frame.timestamp >= segment.end * 1000) return;
          if (!started) {
            if (frame.kind !== 'video' || !frame.keyFrame) return;
            started = true;
          }
          try {
            let written = 0;
            while (written < frame.data.length) {
              const count = fs.writeSync(fd,frame.data,written,frame.data.length-written);
              if (!count) throw new Error('Could not write complete playback frame');
              written += count;
            }
            const {data,...metadata} = frame;
            result.frames.push({...metadata,offset:result.bytes,length:data.length});
            result.bytes += data.length;
          } catch (error) { finish(error); }
        };
        commandListener = command => {
          if (command.command_type === 6001 && command.channel === channel && command.return_code !== 0)
            finish(new Error(`回放命令失败：${command.return_code}`));
        };
        errorListener = (streamChannel,error) => { if (streamChannel === channel) finish(error); };
        closeListener = () => finish(new Error('HomeBase 连接中断。'));
        stoppedListener = streamChannel => {
          if (streamChannel === channel) { segment.termination = 'stream_stopped'; finish(); }
        };
        cancellationListener = () => finish(new Error('Continuous capture cancelled'));
        signal?.addEventListener('abort',cancellationListener,{once:true});
        p2p.on('continuous playback frame',frameListener);
        p2p.on('command',commandListener);
        p2p.on('livestream error',errorListener);
        p2p.on('livestream stopped',stoppedListener);
        p2p.on('close',closeListener);
        try { p2p.startContinuousPlayback(serial,channel,this.session.api.userId,segment.begin); }
        catch (error) { finish(error); }
      });
    } finally {
      signal?.removeEventListener('abort',cancellationListener);
      p2p.off('continuous playback frame',frameListener);
      p2p.off('command',commandListener);
      p2p.off('livestream error',errorListener);
      p2p.off('livestream stopped',stoppedListener);
      p2p.off('close',closeListener);
      p2p.off('livestream started',drain);
      try { p2p.stopContinuousPlayback(); }
      catch (error) { result.diagnostics.push({stage:'stop',message:error.message}); }
    }
  }
}

module.exports = { LocalContinuousRecordings };
