const { Station, Camera, P2PConnectionType } = require('./index.cjs');
const { isAuthenticated } = require('../../capabilities/auth/session.cjs');

// A single-use LAN connection. Every awaited setup boundary observes cancellation;
// close waits for setup before destroying partially constructed vendor objects.
class LiveConnection {
  constructor(session) { this.session = session; this.abort = new AbortController(); }
  connect(serial, signal) {
    if (this.connecting) return this.connecting;
    this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    return this.connecting = this._connect(serial);
  }
  _check(api) {
    this.signal.throwIfAborted();
    if (!isAuthenticated(this.session) || this.session.api !== api)
      throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED', status: 401 });
  }
  async _connect(serial) {
    const api = this.session.api; this._check(api);
    const inventory = await api.getDevsListDecrypted(); this._check(api);
    const raw = inventory.devices.find(row => row.device_sn === serial);
    const base = inventory.devices.find(row => row.device_sn === raw?.parent_sn);
    if (raw?.device_model !== 'T8600' || base?.device_model !== 'T8030') throw new Error('Unsupported live owner');
    const ip = base.local_ip || base.params?.find(param => param.param_type === 1176)?.param_value;
    if (!ip) throw Object.assign(new Error('DEVICE_OFFLINE'), { code: 'DEVICE_OFFLINE', status: 503 });
    const cameras = inventory.devices.filter(row => row.parent_sn === base.device_sn).map(row => ({ ...row, station_sn: base.device_sn }));
    const provider = {
      isConnected: () => true,
      getDevices: () => Object.fromEntries(cameras.map(row => [row.device_sn, row])),
      refreshStationData: async () => {}, request: async () => { throw new Error('LAN only connection'); },
      getCipher: async () => undefined, getVoices: async () => ({}),
    };
    this.camera = await Camera.getInstance(provider, cameras.find(row => row.device_sn === serial), { simultaneousDetections: false });
    this._check(api); this.camera.initialize();
    this.station = await Station.getInstance(provider, { ...base, station_sn: base.device_sn, station_name: base.device_name,
      station_model: base.device_model, devices: cameras }, ip);
    this._check(api); this.station.setConnectionType(P2PConnectionType.ONLY_LOCAL); this.station.initialize();
    await new Promise((resolve, reject) => {
      const clean = () => { this.station.off('connect', connected); this.station.off('connection error', failed);
        this.signal.removeEventListener('abort', aborted); };
      const connected = () => { clean(); resolve(); };
      const failed = () => { clean(); reject(new Error('Live connection failed')); };
      const aborted = () => { clean(); reject(this.signal.reason); };
      this.station.once('connect', connected); this.station.once('connection error', failed);
      this.signal.addEventListener('abort', aborted, { once: true });
      if (this.signal.aborted) return aborted();
      Promise.resolve(this.station.connect()).catch(failed);
    });
    this._check(api);
  }
  close() {
    return this.closing ||= (async () => {
      this.abort.abort(new Error('Live connection closed'));
      await this.connecting?.catch(() => {});
      try { await this.station?.destroy(); }
      finally { this.camera?.destroy(); }
    })();
  }
}
module.exports = { LiveConnection };
