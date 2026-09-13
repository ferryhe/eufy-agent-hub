// The station library parses device-local index timestamps using the process timezone.
process.env.TZ = 'America/Toronto';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { LocalEufySession, isAuthenticated } = require('../capabilities/auth/session.cjs');
const { installRecordingRoutes } = require('../api/legacy-recording-routes.cjs');
const { installV1Routes } = require('../api/v1-routes.cjs');
const { errorBody, serviceError } = require('../api/messages.cjs');
const { validateRequest } = require('../api/v1-contract.cjs');
const { installAgentRoutes } = require('./agent/http.cjs');

const appDist = path.join(__dirname, 'app-dist');
const appMime = file => ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(file)] || 'application/octet-stream');
function serveApp(req, res, pathname) {
  if (req.method !== 'GET' || !(pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/'))) return false;
  const relative = pathname.slice('/app/'.length);
  const candidate = relative && !relative.includes('..') ? path.join(appDist, relative) : '';
  const file = candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(appDist, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('React UI is not built. Run npm run build.'); return true; }
  res.writeHead(200, { 'Content-Type': appMime(file), 'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res); return true;
}

function createServer(options = {}) {
  const port = Number(options.port ?? process.env.EUFY_PORT ?? 3187);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('EUFY_PORT 必须是 0–65535 之间的端口。');
  const session = options.session || new LocalEufySession(undefined, {
    sessionPath: options.sessionPath ?? process.env.EUFY_SESSION_PATH ?? path.resolve(__dirname, '../output/auth/session.json'),
  });
  let busy = false;
  const getOrigin = () => `http://127.0.0.1:${server.address()?.port ?? port}`;
  const server = http.createServer(async (req, res) => {
    const origin = getOrigin();
    const pathname = new URL(req.url, origin).pathname;
    const versioned = pathname.startsWith('/api/v1/session/');
    const route = versioned ? pathname.replace('/api/v1/session', '') : pathname;
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    const reject = (status, message, key) => send(status, versioned
      ? { error: { code: status === 409 ? 'SERVICE_BUSY' : status === 403 ? 'LOCAL_ORIGIN_REQUIRED'
        : status === 401 ? 'UNAUTHENTICATED' : status === 413 ? 'INPUT_TOO_LONG' : 'INVALID_REQUEST', message } }
      : errorBody(serviceError(message, key)));
    if (req.headers.host !== new URL(origin).host) return reject(403, '请使用本地链接。', 'ui.error.localLink');
    if (serveApp(req, res, pathname)) return;
    if (req.method === 'GET' && route === '/') return send(200, fs.readFileSync(path.join(__dirname, 'pages/local-login.html')), 'text/html; charset=utf-8');
    const scripts = { '/assets/i18n.mjs': 'i18n/i18n.mjs', '/assets/local-login.mjs': 'pages/local-login.mjs',
      '/assets/results.mjs': 'components/results.mjs', '/assets/sidebar.mjs': 'agent/sidebar.mjs',
      '/assets/workspace.mjs': 'workspace/workspace.mjs', '/assets/contract.mjs': 'workspace/contract.mjs', '/components/results.mjs': 'components/results.mjs' };
    if (req.method === 'GET' && Object.hasOwn(scripts, route)) return send(200, fs.readFileSync(path.join(__dirname, scripts[route])), 'text/javascript; charset=utf-8');
    const locale = { '/locales/en.json': 'en', '/locales/zh-CN.json': 'zh-CN' }[route];
    if (req.method === 'GET' && locale) {
      const readCatalog = name => JSON.parse(fs.readFileSync(path.join(__dirname, `i18n/${name}.${locale}.json`), 'utf8'));
      return send(200, { ...readCatalog('ui'), ...readCatalog('service') });
    }
    if (req.method === 'GET' && route === '/status') {
      const authenticated = isAuthenticated(session);
      return send(200, { ...session.state, authenticated, busy, version: 'mega-inventory-1' });
    }
    if (req.method !== 'POST' || !['/login', '/verify', '/refresh', '/logout'].includes(route)) return send(404, {});
    if ((req.headers.origin !== origin && (!versioned || req.headers.origin)) || !req.headers['content-type']?.startsWith('application/json')) {
      return reject(403, '请从本地登录页面提交。', 'ui.error.localPage');
    }
    const authBusy = () => route === '/logout' ? busy || recordingRoutes.state.busy : isBusy();
    if (authBusy()) return reject(409, '正在连接，请稍候。', 'ui.error.busy');
    let data;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) return reject(413, '输入过长。', 'ui.error.inputLong');
      }
      // Another request may acquire the session while this body is arriving.
      if (authBusy()) return reject(409, '正在连接，请稍候。', 'ui.error.busy');
      data = JSON.parse(body);
      if (versioned) validateRequest(route === '/login' ? 'login' : route === '/verify' ? 'verification' : 'empty', data);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return reject(400, '输入格式有误。', 'ui.error.inputFormat');
      if (route === '/login') {
        if (typeof data.email !== 'string' || !data.email.trim() || typeof data.password !== 'string' || !data.password || typeof data.country !== 'string' || !/^[a-z]{2}$/i.test(data.country.trim())) {
          return reject(400, '请填写邮箱、密码和两位国家代码。', 'ui.error.credentials');
        }
      } else if (route === '/refresh') {
        if (!isAuthenticated(session)) return reject(401, '请先完成登录。', 'ui.error.loginFirst');
      } else if (route !== '/logout' && (!['tfa', 'captcha'].includes(session.state.phase) || typeof data.code !== 'string' || !data.code.trim())) {
        return reject(400, '请先登录，再输入验证码。', 'ui.error.verifyFirst');
      }
    } catch {
      return reject(400, '输入格式有误。', 'ui.error.inputFormat');
    }
    busy = true;
    if (route !== '/logout') send(202, { ok: true });
    try {
      if (route === '/login') {
        recordingRoutes.recordings.close();
        recordingRoutes.state.records = []; recordingRoutes.state.query = null;
        await session.login(data);
      }
      else if (route === '/logout') {
        await v1.loggedOut();
        session.logout();
        recordingRoutes.recordings.close();
        recordingRoutes.state.records = []; recordingRoutes.state.query = null;
        send(202, { ok: true });
      }
      else if (route === '/refresh') await session.refresh();
      else await session.verify(data.code.trim());
    } catch (error) {
      if (route === '/logout') send(error.status || 503, versioned
        ? { error: { code: error.code || 'CONTROL_CLEANUP_FAILED', message: error.code || 'CONTROL_CLEANUP_FAILED' } }
        : errorBody(serviceError('Playback cleanup failed.', 'ui.error.busy')));
      else session.fail(error);
    } finally {
      busy = false;
    }
  });
  const recordingRoutes = installRecordingRoutes(server, session, {
    isBusy: () => busy || v1.isBusy(), getOrigin, recordings: options.recordings, outputRoot: options.outputRoot,
  });
  const v1 = installV1Routes(server, session, {
    getOrigin, isBusy: () => busy || recordingRoutes.state.busy || session.state.phase === 'busy',
    exports: options.exports, createRanges: options.createRanges,
    capabilityRecordsPath: options.capabilityRecordsPath ?? process.env.EUFY_CAPABILITY_RECORDS_PATH,
    deviceRepository: options.deviceRepository,
    playback: options.playback,
    live: options.live,
  });
  const isBusy = () => busy || recordingRoutes.state.busy || v1.isBusy();
  const agentRoutes = installAgentRoutes(server, { getOrigin, ...options.agent });
  let shutdown;
  server.shutdown = () => shutdown ||= agentRoutes.shutdown().then(() => v1.shutdown()).finally(() => {
    recordingRoutes.recordings.close();
    session.close?.();
  });
  server.once('close', () => { server.shutdown().catch(error => console.error(error)); });
  server.start = callback => {
    server.ready = Promise.resolve(session.restore?.()).then(() => server.listen(port, '127.0.0.1', callback));
    return server;
  };
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.start(() => console.log(`Eufy login ready: http://127.0.0.1:${server.address().port}`));
  // The protocol library may retain UDP handles after closing its station.
  // Only the standalone entry point owns the process lifetime.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // End streaming responses before waiting for HTTP connections to drain.
    const shutdown = server.shutdown(); shutdown.catch(() => {});
    server.close(async () => {
      try { await shutdown; process.exit(0); }
      catch (error) { console.error(error); process.exit(1); }
    });
  };
  // Keep the owner visible while draining; SDK signal cleanup defers to it.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer };
