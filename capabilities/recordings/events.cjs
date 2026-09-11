const { Station, Camera, P2PConnectionType, CommandType } = require('../../adapters/eufy');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { isRecordingCamera, supportsEventRecordings } = require('../devices/recording-support.cjs');

function waitFor(emitter, event, action, select, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); emitter.off(event, listener); };
    const listener = (...args) => {
      try {
        const value = select(...args);
        if (value === undefined) return;
        clean(); resolve(value);
      } catch (error) { clean(); reject(error); }
    };
    const timer = setTimeout(() => { clean(); reject(new Error(`等待 ${event} 超时`)); }, timeoutMs);
    emitter.on(event, listener);
    Promise.resolve().then(action).catch(error => { clean(); reject(error); });
  });
}

class LocalRecordings {
  constructor(session) { this.session = session; }

  async connect(serial) {
    if (!this.session.authenticated) throw new Error('请先登录。');
    if (this.camera?.getSerial() === serial && this.station?.isConnected()) return;
    this.close();
    const inventory = await this.session.api.getDevsListDecrypted();
    const raw = inventory.devices.find(device => device.device_sn === serial);
    if (!raw) throw new Error('未找到设备。');
    const base = inventory.devices.find(device => device.device_sn === raw.parent_sn);
    if (!base || base.device_model !== 'T8030') throw new Error('当前录像提取仅接入 HomeBase 3。');
    if (!supportsEventRecordings(raw, inventory.devices)) throw new Error('此设备不支持当前事件录像提取。');
    const ip = base.local_ip || base.params?.find(param => param.param_type === 1176)?.param_value;
    if (!ip) throw new Error('HomeBase 未提供局域网地址。');
    const cameras = inventory.devices.filter(device => device.parent_sn === base.device_sn && isRecordingCamera(device))
      .map(device => ({ ...device, station_sn: base.device_sn }));
    const provider = {
      isConnected: () => this.session.authenticated,
      getDevices: () => Object.fromEntries(cameras.map(device => [device.device_sn, device])),
      refreshStationData: async () => {},
      // Local discovery and the library's LAN command encryption do not need legacy cloud keys.
      request: async () => { throw new Error('此连接只使用局域网。'); },
      getCipher: async () => undefined,
      getVoices: async () => ({}),
    };
    const wire = { ...base, station_sn: base.device_sn, station_name: base.device_name,
      station_model: base.device_model, devices: cameras };
    this.camera = await Camera.getInstance(provider, cameras.find(device => device.device_sn === serial), { simultaneousDetections: false });
    this.camera.initialize();
    this.station = await Station.getInstance(provider, wire, ip);
    this.station.setConnectionType(P2PConnectionType.ONLY_LOCAL);
    this.station.initialize();
    this.status = { connected: false, device: raw.device_name, station: base.device_name, errors: [] };
    this.station.on('command result', (_station, result) => {
      if (result.return_code !== 0) this.status.errors.push({command:result.command_type,code:result.return_code});
    });
    this.station.on('connection error', () => this.status.errors.push({message:'HomeBase 连接失败'}));
    try {
      await waitFor(this.station, 'connect', () => this.station.connect(), () => true);
      this.status.connected = true;
    } catch (error) { this.close(); throw error; }
  }

  async listDay(serial, day) {
    this.records = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式错误。');
    await this.connect(serial);
    const start = new Date(`${day}T12:00:00`);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    let previousCount = 0;
    for (const limit of [1000, 2000, 10000]) {
      const records = await waitFor(this.station, 'database query by date',
        () => this.station.databaseQueryByDate([serial], start, end, 0, 0, 0, limit),
        (_station, code, rows) => { if (code !== 0) throw new Error(`录像查询失败：${code}`); return rows; });
      if (records.length < limit && records.length !== previousCount) {
        this.records = records.filter(record => record.device_sn === serial && record.station_sn === this.station.getSerial());
        return this.records;
      }
      if (records.length === 0) { this.records = []; return []; }
      if (records.length === previousCount) throw new Error('HomeBase 限制了查询条数，无法确认列表完整。');
      previousCount = records.length;
    }
    throw new Error('录像达到查询上限，无法确认列表完整。');
  }

  close() {
    this.station?.close();
    this.camera?.destroy();
    this.station = undefined;
    this.camera = undefined;
    if (this.status) this.status.connected = false;
  }

  async download(recordId, outputDir) {
    const record = this.records?.find(record => record.record_id === recordId);
    if (!record || record.device_sn !== this.camera?.getSerial()) throw new Error('请先查询该设备的录像。');
    if (!this.station.isConnected()) throw new Error('HomeBase 连接已断开。');
    fs.mkdirSync(outputDir, { recursive: true });
    const prefix = path.join(outputDir, String(record.record_id));
    fs.rmSync(prefix + '.json', { force: true });
    return new Promise((resolve, reject) => {
      let metadata, confirmed = false, ended = false, pipes, settled = false, streams = [];
      const clean = () => {
        clearTimeout(timer);
        this.station.off('download start', started);
        this.station.off('download finish', finished);
        this.station.off('download complete', complete);
        this.station.off('command result', command);
      };
      const fail = async error => {
        if (settled) return; settled = true; clean();
        try { this.station.cancelDownload(this.camera); } catch { /* Preserve the original failure. */ }
        for (const stream of streams) stream.destroy();
        if (pipes) await pipes.catch(() => {});
        reject(error);
      };
      const finish = async () => {
        if (!confirmed || !ended || !pipes || settled) return;
        try {
          await pipes;
          if (settled) return;
          if (!fs.statSync(prefix + '.video').size) throw new Error('录像下载为空。');
          fs.writeFileSync(prefix + '.json', JSON.stringify({record:{...record,start_time:record.start_time.toISOString(),end_time:record.end_time.toISOString()},metadata,complete:true},null,2));
          settled = true; clean();
          resolve({prefix,metadata,complete:true,bytes:fs.statSync(prefix + '.video').size});
        } catch(error) { fail(error); }
      };
      const started = (_s, channel, meta, video, audio) => {
        if (channel !== this.camera.getChannel()) return;
        metadata = meta;
        streams = [video, audio];
        pipes = Promise.all([
          pipeline(video, fs.createWriteStream(prefix + '.video')),
          pipeline(audio, fs.createWriteStream(prefix + '.audio')),
        ]);
        pipes.catch(fail);
        finish();
      };
      const finished = (_s, channel) => { if (channel === this.camera.getChannel()) { ended = true; finish(); } };
      const complete = (_s, channel) => { if (channel === this.camera.getChannel()) { confirmed = true; finish(); } };
      const command = (_s, result) => {
        if (result.channel === this.camera.getChannel() && result.command_type === CommandType.CMD_DOWNLOAD_VIDEO && result.return_code !== 0) fail(new Error(`录像下载被拒绝：${result.return_code}`));
      };
      const timer = setTimeout(() => fail(new Error('录像下载超时，未标记为成功。')), 90000);
      this.station.on('download start', started);
      this.station.on('download finish', finished);
      this.station.on('download complete', complete);
      this.station.on('command result', command);
      this.station.startDownload(this.camera, record.storage_path, record.cipher_id).catch(fail);
    });
  }
}

module.exports = { LocalRecordings, waitFor };
