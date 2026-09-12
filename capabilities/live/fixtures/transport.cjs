const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Offline only. A deterministic transport, never hardware acceptance evidence.
function transport({ channel = 1, reject = false, media = true, closeGate, connectGate } = {}) {
  const p2p = new EventEmitter();
  let connected = false, opened = 0, stopped = 0, closed = 0;
  const video = new PassThrough(), audio = new PassThrough();
  p2p.isConnected = () => connected;
  const camera = { getSerial: () => 'camera', getModel: () => 'T8600', getStationSerial: () => 'base', getChannel: () => channel };
  const station = new EventEmitter();
  Object.assign(station, { p2pSession: p2p, getSerial: () => 'base', getModel: () => 'T8030',
    startLivestream() {
      opened++;
      queueMicrotask(() => {
        p2p.emit('command', { channel, command_type: 1003, return_code: reject ? -1 : 0 });
        if (!reject && media) p2p.emit('livestream started', channel, { videoCodec: 0, audioCodec: -1, videoFPS: 15 }, video, audio);
      });
    }, stopLivestream() { stopped++; p2p.emit('command', { channel, command_type: 1004, return_code: 0 }); },
  });
  return { p2p, video, audio, station, camera,
    async connect(_serial, signal) { if (connectGate) await connectGate; signal?.throwIfAborted(); connected = true; },
    async close() { if (closeGate) await closeGate; connected = false; closed++; video.destroy(); audio.destroy(); },
    counts: () => ({ opened, stopped, closed }),
  };
}
module.exports = { transport };
