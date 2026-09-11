// The station library parses device-local index timestamps using the process timezone.
process.env.TZ = 'America/Toronto';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { LocalEufySession } = require('../capabilities/auth/session.cjs');
const { installRecordingRoutes } = require('../api/legacy-recording-routes.cjs');
const { errorBody, serviceError } = require('../api/messages.cjs');

function createServer(options = {}) {
  const port = Number(options.port ?? process.env.EUFY_PORT ?? 3187);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('EUFY_PORT 必须是 0–65535 之间的端口。');
  const session = options.session || new LocalEufySession();
  let busy = false;
  const getOrigin = () => `http://127.0.0.1:${server.address()?.port ?? port}`;
  const server = http.createServer(async (req, res) => {
    const origin = getOrigin();
    const route = new URL(req.url, origin).pathname;
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    const reject = (status, message, key) => send(status, errorBody(serviceError(message, key)));
    if (req.headers.host !== new URL(origin).host) return reject(403, '请使用本地链接。', 'ui.error.localLink');
    if (req.method === 'GET' && route === '/') return send(200, fs.readFileSync(path.join(__dirname, 'pages/local-login.html')), 'text/html; charset=utf-8');
    const scripts = { '/assets/i18n.mjs': 'i18n/i18n.mjs', '/assets/local-login.mjs': 'pages/local-login.mjs' };
    if (req.method === 'GET' && Object.hasOwn(scripts, route)) return send(200, fs.readFileSync(path.join(__dirname, scripts[route])), 'text/javascript; charset=utf-8');
    const locale = { '/locales/en.json': 'en', '/locales/zh-CN.json': 'zh-CN' }[route];
    if (req.method === 'GET' && locale) {
      const readCatalog = name => JSON.parse(fs.readFileSync(path.join(__dirname, `i18n/${name}.${locale}.json`), 'utf8'));
      return send(200, { ...readCatalog('ui'), ...readCatalog('service') });
    }
    if (req.method === 'GET' && route === '/status') return send(200, { ...session.state, busy, version: 'mega-inventory-1' });
    if (req.method !== 'POST' || !['/login', '/verify', '/refresh'].includes(route)) return send(404, {});
    if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) {
      return reject(403, '请从本地登录页面提交。', 'ui.error.localPage');
    }
    if (busy) return reject(409, '正在连接，请稍候。', 'ui.error.busy');
    let data;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) return reject(413, '输入过长。', 'ui.error.inputLong');
      }
      data = JSON.parse(body);
      if (route === '/login') {
        if (typeof data.email !== 'string' || !data.email.trim() || typeof data.password !== 'string' || !data.password || typeof data.country !== 'string' || !/^[a-z]{2}$/i.test(data.country.trim())) {
          return reject(400, '请填写邮箱、密码和两位国家代码。', 'ui.error.credentials');
        }
      } else if (route === '/refresh') {
        if (!session.authenticated) return reject(400, '请先完成登录。', 'ui.error.loginFirst');
      } else if (!['tfa', 'captcha'].includes(session.state.phase) || typeof data.code !== 'string' || !data.code.trim()) {
        return reject(400, '请先登录，再输入验证码。', 'ui.error.verifyFirst');
      }
    } catch {
      return reject(400, '输入格式有误。', 'ui.error.inputFormat');
    }
    busy = true;
    send(202, { ok: true });
    try {
      if (route === '/login') await session.login(data);
      else if (route === '/refresh') await session.refresh();
      else await session.verify(data.code.trim());
    } catch (error) {
      session.fail(error);
    } finally {
      busy = false;
    }
  });
  const recordingRoutes = installRecordingRoutes(server, session, {
    isBusy: () => busy, getOrigin, recordings: options.recordings, outputRoot: options.outputRoot,
  });
  server.once('close', () => {
    recordingRoutes.recordings.close();
    session.close?.();
  });
  server.start = callback => server.listen(port, '127.0.0.1', callback);
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.start(() => console.log(`Eufy login ready: http://127.0.0.1:${server.address().port}`));
  // The protocol library may retain UDP handles after closing its station.
  // Only the standalone entry point owns the process lifetime.
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { createServer };
