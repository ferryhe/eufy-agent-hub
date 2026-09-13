const fs = require('node:fs');
const path = require('node:path');
const { LocalRecordings } = require('../capabilities/recordings/events.cjs');
const { exportRecording } = require('../capabilities/recordings/export.cjs');
const { messageI18n, serviceError, setMessage, errorBody } = require('./messages.cjs');
const { normalizeWindow, localTime, resolveTimezone, LEGACY_TIMEZONE } = require('../capabilities/recordings/time-window.cjs');
const { isAuthenticated } = require('../capabilities/auth/session.cjs');

function torontoTime(day, time) {
  return localTime(day, time, LEGACY_TIMEZONE);
}

function parseWindow(data, options) {
  if (typeof data?.serial !== 'string' || !/^[a-z\d]{8,32}$/i.test(data.serial)) throw serviceError('请选择设备。', 'service.devices.select');
  const window = normalizeWindow(data, options);
  return { serial: data.serial, day: data.day, start: Date.parse(window.normalized.start),
    end: Date.parse(window.normalized.end), timezone: window.normalized.timezone, window, coverage: null };
}

function matchesExpectedQuery(expected, query) {
  if (!expected || !query || typeof expected.serial !== 'string' || typeof expected.day !== 'string'
    || typeof expected.start !== 'string' || typeof expected.end !== 'string'
    || (typeof expected.timezone !== 'string' && expected.timezone !== null)) return false;
  const actual = { serial: query.serial, ...query.window.input };
  return ['serial','day','start','end','timezone'].every(field => expected[field] === actual[field]);
}

function serveMedia(req, res, file) {
  const size = fs.statSync(file).size;
  let start = 0, end = size - 1, code = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    code = 206;
  }
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (new URL(req.url, 'http://localhost').searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function installRecordingRoutes(server, session, options = {}) {
  const getOrigin = options.getOrigin || (() => `http://127.0.0.1:${server.address()?.port || 3187}`);
  const outputRoot = path.resolve(options.outputRoot || path.join(__dirname, '../output'));
  const recordings = options.recordings || new LocalRecordings(session);
  const timezone = resolveTimezone(options.defaultTimezone);
  const state = { busy: false, timezone, message: '选择设备和时间，查询事件录像。', query: null, records: [], saved: [] };
  state.messageI18n = messageI18n('service.recordings.idle');
  const media = new Map();
  function addSaved(clip, device, serial, manifestTimezone) {
    const file = path.resolve(clip.file);
    if (!file.startsWith(outputRoot + path.sep) || !fs.existsSync(file) || path.extname(file) !== '.mp4') return;
    const id = Buffer.from(path.relative(outputRoot, file)).toString('base64url');
    media.set(id, file);
    if (!serial) {
      const metadataFile = path.join(path.dirname(file), 'raw', `${clip.recordId}.json`);
      if (fs.existsSync(metadataFile)) serial = JSON.parse(fs.readFileSync(metadataFile, 'utf8')).record.device_sn;
    }
    const saved = { id, device, serial, recordId: String(clip.recordId), start: clip.start, end: clip.end,
      timezone: clip.window?.normalized.timezone || clip.timezone || manifestTimezone || LEGACY_TIMEZONE,
      window: clip.window ?? null, coverage: clip.coverage ?? null, bytes: clip.bytes, url: `/recordings/media/${id}` };
    state.saved = [...state.saved.filter(item => item.id !== id && !(serial && item.serial === serial && item.recordId === saved.recordId)), saved];
    state.saved.sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
  }
  if (fs.existsSync(outputRoot)) {
    for (const directory of fs.readdirSync(outputRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const file = path.join(outputRoot, directory.name, 'manifest.json');
      if (!fs.existsSync(file)) continue;
      try { const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); for (const clip of manifest.clips || []) addSaved(clip, manifest.device, manifest.serial, manifest.timezone); } catch { /* Ignore incomplete exports. */ }
    }
  }
  const original = server.listeners('request')[0];
  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    const origin = getOrigin();
    const route = new URL(req.url, origin).pathname;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== new URL(origin).host) return send(403, errorBody(serviceError('请使用本地链接。', 'service.localLinkRequired')));
      if (!route.startsWith('/recordings')) {
        if (req.method === 'POST' && state.busy) return send(409, errorBody(serviceError('正在处理录像，请稍候。', 'service.recordings.busy')));
        if (req.method === 'POST' && route === '/login') { recordings.close(); state.records = []; state.query = null; }
        return original(req, res);
      }
      if (req.method === 'GET' && route === '/recordings/status') return send(200, state);
      if (['GET', 'HEAD'].includes(req.method) && route.startsWith('/recordings/media/')) {
        const file = media.get(route.slice('/recordings/media/'.length));
        if (!file || !fs.existsSync(file)) return send(404, errorBody(serviceError('未找到已导出录像。', 'service.recordings.exportNotFound')));
        return serveMedia(req, res, file);
      }
      if (req.method !== 'POST' || !['/recordings/query', '/recordings/download'].includes(route)) return send(404, {});
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return send(403, errorBody(serviceError('请从本地页面提交。', 'service.localPageRequired')));
      if (!isAuthenticated(session)) return send(401, errorBody(serviceError('请先登录。', 'service.auth.loginRequired')));
      if (state.busy || options.isBusy?.() || session.state.phase === 'busy') return send(409, errorBody(serviceError('正在处理，请稍候。', 'service.busy')));
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, errorBody(serviceError('输入过长。', 'service.inputTooLong'))); }
      if (!isAuthenticated(session)) return send(401, errorBody(serviceError('请先登录。', 'service.auth.loginRequired')));
      let data, query, selected;
      try {
        data = JSON.parse(body);
        if (route.endsWith('/query')) query = parseWindow(data, { defaultTimezone: timezone });
        else {
          if (Object.prototype.hasOwnProperty.call(data, 'expectedQuery') && !matchesExpectedQuery(data.expectedQuery, state.query))
            return send(409, errorBody(serviceError('请先查询该设备的录像。', 'service.recordings.queryDeviceFirst')));
          selected = state.records.find(record => record.id === String(data.recordId));
          if (!selected) throw serviceError('请先查询并选择录像。', 'service.recordings.selectFirst');
        }
      } catch (error) { return send(400, errorBody(error)); }
      if (state.busy || options.isBusy?.() || session.state.phase === 'busy') return send(409, errorBody(serviceError('正在处理，请稍候。', 'service.busy')));
      state.busy = true;
      setMessage(state, query ? '正在读取 HomeBase 的事件录像索引…' : '正在下载并转换录像，完成后可播放…',
        messageI18n(query ? 'service.recordings.querying' : 'service.recordings.exporting'));
      send(202, { ok: true, timezone: (query || state.query).timezone, window: (query || state.query).window, coverage: null });
      try {
        if (query) {
          state.records = []; state.query = query;
          const records = await recordings.listWindow(query.serial, query.window);
          state.records = records.filter(record => record.start_time.getTime() < query.end && record.end_time.getTime() > query.start)
            .sort((a, b) => a.start_time - b.start_time)
            .map(record => ({ id: String(record.record_id), start: record.start_time.toISOString(), end: record.end_time.toISOString(), timezone: query.timezone, coverage: null }));
          setMessage(state, `找到 ${state.records.length} 段事件录像。此列表不代表完整连续录像。`, messageI18n('service.recordings.found', { count: state.records.length }));
        } else {
          const query = state.query;
          const directory = path.join(outputRoot, `${query.serial}_${query.day}`);
          const result = await recordings.download(Number(selected.id), path.join(directory, 'raw'), query.window);
          const clip = await exportRecording(result.prefix, path.join(directory, `${query.serial}_${selected.id}.mp4`));
          const manifestFile = path.join(directory, 'manifest.json');
          const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { device: recordings.status.device, serial: query.serial, continuousCoverage: false, clips: [] };
          manifest.clips = [...manifest.clips.filter(item => String(item.recordId) !== selected.id), clip];
          // A directory can hold exports requested in different zones. Each clip is authoritative.
          const zones = new Set(manifest.clips.map(item => item.timezone || manifest.timezone || LEGACY_TIMEZONE));
          manifest.timezone = zones.size === 1 ? [...zones][0] : null;
          fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
          addSaved(clip, manifest.device, query.serial);
          setMessage(state, '录像已保存，并通过完整解码检查。可在下方播放或下载。', messageI18n('service.recordings.saved'));
        }
      } catch (error) { setMessage(state, error.message, error.i18n); }
      finally { state.busy = false; }
    } catch (error) {
      if (!res.headersSent) send(500, errorBody(error));
      else res.destroy();
    }
  });
  return { state, recordings };
}

module.exports = { installRecordingRoutes, parseWindow, torontoTime, serveMedia };
