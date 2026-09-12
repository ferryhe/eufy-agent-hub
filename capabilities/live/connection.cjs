const { LocalRecordings } = require('../recordings/events.cjs');
const { queryDevice } = require('../devices/capabilities.cjs');

// Reuse the existing narrow LAN camera/HomeBase binding. The upstream close is
// synchronous and recreates UDP on socket close, so this disposable owner joins
// protocol close and retires that socket only after suppressing its recreation.
class LiveConnection extends LocalRecordings {
  constructor(session) { super(session); this.closures = []; }
  async connect(serial, options) {
    await super.connect(serial, options);
    const raw = this.station.getRawStation();
    this.verificationScope = queryDevice([raw, this.camera.getRawDevice()], serial).verificationScope;
    // Mega inventory does not require the legacy member wrapper used by
    // Station.startLivestream. Bind that missing field to this restored account.
    if (!raw.member?.admin_user_id) {
      if (typeof this.userId !== 'string' || !this.userId) throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED' });
      raw.member = { ...raw.member, admin_user_id: this.userId };
    }
  }
  close() {
    const station = this.station, camera = this.camera, p2p = station?.p2pSession;
    this.station = undefined; this.camera = undefined; this.userId = undefined;
    camera?.destroy();
    if (station) {
      const originalClose = p2p.close;
      let closing;
      p2p.close = () => closing ||= Promise.resolve().then(() => originalClose.call(p2p));
      // Stop reconnect admission before awaiting the P2P END response.
      station.close();
      const closure = (async () => {
        try {
          await p2p.close();
          const socket = p2p.socket;
          if (socket) {
            socket.removeAllListeners();
            await new Promise((resolve, reject) => {
              try { socket.close(resolve); }
              catch (error) { error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' ? resolve() : reject(error); }
            });
          }
          if (p2p.isConnected()) throw new Error('LIVE_CLEANUP_FAILED');
        } finally { p2p.close = originalClose; }
      })();
      closure.catch(() => {}); this.closures.push(closure);
    }
    const all = Promise.all(this.closures); all.catch(() => {}); return all;
  }
}

module.exports = { LiveConnection };
