const fs = require('node:fs');
const path = require('node:path');
const { LocalRecordings } = require('../capabilities/recordings/events.cjs');
const { exportRecording } = require('../capabilities/recordings/export.cjs');

const timezone = 'America/Toronto';
const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function torontoTime(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('请填写有效的日期和时间。');
  const local = `${day} ${time}:00`;
  const naive = Date.parse(`${day}T${time}:00Z`);
  const matches = [4, 5].map(offset => naive + offset * 3600000).filter(value => Number.isFinite(value) && clock.format(value) === local);
  if (matches.length !== 1) throw new Error('此时间不存在或因夏令时重复，请选择明确的时间。');
  return matches[0];
}

function parseWindow(data) {
  if (typeof data.serial !== 'string' || !/^[a-z\d]{8,32}$/i.test(data.serial)) throw new Error('请选择设备。');
  const start = torontoTime(data.day, data.start);
  const end = torontoTime(data.day, data.end);
  if (end <= start) throw new Error('结束时间必须晚于开始时间，且在同一天。');
  return { serial: data.serial, day: data.day, start, end, timezone };
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
  const state = { busy: false, message: '选择设备和 Toronto 时间，查询事件录像。', query: null, records: [], saved: [] };
  const media = new Map();
  function addSaved(clip, device, serial) {
    const file = path.resolve(clip.file);
    if (!file.startsWith(outputRoot + path.sep) || !fs.existsSync(file) || path.extname(file) !== '.mp4') return;
    const id = Buffer.from(path.relative(outputRoot, file)).toString('base64url');
    media.set(id, file);
    if (!serial) {
      const metadataFile = path.join(path.dirname(file), 'raw', `${clip.recordId}.json`);
      if (fs.existsSync(metadataFile)) serial = JSON.parse(fs.readFileSync(metadataFile, 'utf8')).record.device_sn;
    }
    const saved = { id, device, serial, recordId: String(clip.recordId), start: clip.start, end: clip.end, bytes: clip.bytes, url: `/recordings/media/${id}` };
    state.saved = [...state.saved.filter(item => item.id !== id && !(serial && item.serial === serial && item.recordId === saved.recordId)), saved];
    state.saved.sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
  }
  if (fs.existsSync(outputRoot)) {
    for (const directory of fs.readdirSync(outputRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
      const file = path.join(outputRoot, directory.name, 'manifest.json');
      if (!fs.existsSync(file)) continue;
      try { const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); for (const clip of manifest.clips || []) addSaved(clip, manifest.device, manifest.serial); } catch { /* Ignore incomplete exports. */ }
    }
  }
  const original = server.listeners('request')[0];
  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    const origin = getOrigin();
    const route = new URL(req.url, origin).pathname;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== new URL(origin).host) return send(403, { error: '请使用本地链接。' });
      if (!route.startsWith('/recordings')) {
        if (req.method === 'POST' && state.busy) return send(409, { error: '正在处理录像，请稍候。' });
        if (req.method === 'POST' && route === '/login') { recordings.close(); state.records = []; state.query = null; }
        return original(req, res);
      }
      if (req.method === 'GET' && route === '/recordings/status') return send(200, state);
      if (['GET', 'HEAD'].includes(req.method) && route.startsWith('/recordings/media/')) {
        const file = media.get(route.slice('/recordings/media/'.length));
        if (!file || !fs.existsSync(file)) return send(404, { error: '未找到已导出录像。' });
        return serveMedia(req, res, file);
      }
      if (req.method !== 'POST' || !['/recordings/query', '/recordings/download'].includes(route)) return send(404, {});
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '请从本地页面提交。' });
      if (!session.authenticated) return send(401, { error: '请先登录。' });
      if (state.busy || options.isBusy?.() || session.state.phase === 'busy') return send(409, { error: '正在处理，请稍候。' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: '输入过长。' }); }
      let data, query, selected;
      try {
        data = JSON.parse(body);
        if (route.endsWith('/query')) query = parseWindow(data);
        else {
          selected = state.records.find(record => record.id === String(data.recordId));
          if (!selected) throw new Error('请先查询并选择录像。');
        }
      } catch (error) { return send(400, { error: error.message }); }
      if (state.busy || options.isBusy?.() || session.state.phase === 'busy') return send(409, { error: '正在处理，请稍候。' });
      state.busy = true;
      state.message = query ? '正在读取 HomeBase 的事件录像索引…' : '正在下载并转换录像，完成后可播放…';
      send(202, { ok: true });
      try {
        if (query) {
          state.records = []; state.query = query;
          const records = await recordings.listDay(query.serial, query.day);
          state.records = records.filter(record => record.start_time.getTime() < query.end && record.end_time.getTime() > query.start)
            .sort((a, b) => a.start_time - b.start_time)
            .map(record => ({ id: String(record.record_id), start: record.start_time.toISOString(), end: record.end_time.toISOString() }));
          state.message = `找到 ${state.records.length} 段事件录像。此列表不代表完整连续录像。`;
        } else {
          const query = state.query;
          const directory = path.join(outputRoot, `${query.serial}_${query.day}`);
          const result = await recordings.download(Number(selected.id), path.join(directory, 'raw'));
          const clip = await exportRecording(result.prefix, path.join(directory, `${query.serial}_${selected.id}.mp4`));
          const manifestFile = path.join(directory, 'manifest.json');
          const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { device: recordings.status.device, serial: query.serial, timezone, continuousCoverage: false, clips: [] };
          manifest.clips = [...manifest.clips.filter(item => String(item.recordId) !== selected.id), clip];
          fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
          addSaved(clip, manifest.device, query.serial);
          state.message = '录像已保存，并通过完整解码检查。可在下方播放或下载。';
        }
      } catch (error) { state.message = error.message; }
      finally { state.busy = false; }
    } catch (error) {
      if (!res.headersSent) send(500, { error: error.message });
      else res.destroy();
    }
  });
  return { state, recordings };
}

module.exports = { installRecordingRoutes, parseWindow, torontoTime, serveMedia };
