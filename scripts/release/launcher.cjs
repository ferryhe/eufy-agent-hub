const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_ID = 'eufy-agent-hub';
const PROTOCOL = 1;
const PORT = 3187;
const RELEASE_ROOT = path.resolve(__dirname, '../..');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function defaultDataRoot() {
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable.');
  return path.join(process.env.LOCALAPPDATA, 'EufyAgentHub');
}
function controlName(dataRoot) {
  const identity = path.resolve(dataRoot).replaceAll('/', '\\').toLowerCase();
  const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\${APP_ID}-${suffix}` : path.join(dataRoot, `.${APP_ID}-${suffix}.sock`);
}
function listenControl(name, token, handler) {
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let source = '';
    socket.on('data', chunk => {
      source += chunk;
      if (source.length > 8192) socket.destroy();
      if (!source.includes('\n')) return;
      socket.pause();
      Promise.resolve().then(async () => {
        const message = JSON.parse(source.slice(0, source.indexOf('\n')));
        if (message.app !== APP_ID || message.protocol !== PROTOCOL || message.token !== token)
          throw new Error('CONTROL_UNAUTHORIZED');
        return handler(message.command);
      }).then(value => socket.end(`${JSON.stringify({ ok: true, value })}\n`), error =>
        socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(name, () => { server.off('error', reject); resolve(server); });
  });
}
function requestControl(name, token, command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(name);
    let source = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('CONTROL_TIMEOUT')), timeout);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ app: APP_ID, protocol: PROTOCOL, token, command })}\n`));
    socket.on('data', chunk => {
      source += chunk;
      if (source.length > 8192) return finish(new Error('CONTROL_RESPONSE_TOO_LARGE'));
      if (!source.includes('\n')) return;
      try {
        const response = JSON.parse(source.slice(0, source.indexOf('\n')));
        finish(response.ok ? null : new Error(response.error), response.value);
      } catch (error) { finish(error); }
    });
    socket.once('error', finish);
    socket.once('end', () => { if (!settled) finish(new Error('CONTROL_CLOSED')); });
  });
}
function tokenPath(dataRoot) { return path.join(dataRoot, 'control', 'token'); }
function residentLogPath(dataRoot) { return path.join(dataRoot, 'logs', 'resident.log'); }
function readToken(dataRoot) { return fs.readFileSync(tokenPath(dataRoot), 'utf8').trim(); }
async function currentStatus(dataRoot) {
  try { return await requestControl(controlName(dataRoot), readToken(dataRoot), 'status'); }
  catch (error) { if (['ENOENT', 'ECONNREFUSED', 'CONTROL_CLOSED'].includes(error.code) || error.message === 'CONTROL_CLOSED') return null; throw error; }
}
function openBrowser() {
  if (process.env.EUFY_NO_BROWSER === '1') return;
  spawn('explorer.exe', [`http://127.0.0.1:${PORT}/app/`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
async function spawnResident(dataRoot, options = {}) {
  const logFile = residentLogPath(dataRoot);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] Starting resident.\n`);
  const output = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(options.executable || process.execPath, options.args || [__filename, 'resident'], {
      detached: options.detached ?? true, stdio: ['ignore', output, output], windowsHide: true,
      env: { ...process.env, ...options.env, EUFY_DATA_ROOT: dataRoot },
    });
  } catch (error) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Resident spawn failed: ${error.message}\n`);
    throw new Error(`Resident spawn failed: ${error.message}. See ${logFile}.`, { cause: error });
  } finally { fs.closeSync(output); }
  return new Promise((resolve, reject) => {
    const failed = error => {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Resident spawn failed: ${error.message}\n`);
      reject(new Error(`Resident spawn failed: ${error.message}. See ${logFile}.`, { cause: error }));
    };
    child.once('error', failed);
    child.once('spawn', () => {
      child.off('error', failed);
      child.on('error', error => fs.appendFileSync(logFile, `[${new Date().toISOString()}] Resident error: ${error.message}\n`));
      child.unref();
      resolve({ child, logFile });
    });
  });
}
function configureRuntime() {
  const required = {
    node: path.join(RELEASE_ROOT, 'runtime', 'node', 'node.exe'),
    python: path.join(RELEASE_ROOT, 'runtime', 'python', 'python.exe'),
    ffmpeg: path.join(RELEASE_ROOT, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
    app: path.join(RELEASE_ROOT, 'interface', 'app-dist', 'index.html'),
  };
  for (const [name, file] of Object.entries(required)) if (!fs.existsSync(file)) throw new Error(`Bundled ${name} is missing: ${file}`);
  if (path.resolve(process.execPath) !== path.resolve(required.node)) throw new Error(`Resident must use bundled Node: ${required.node}`);
  process.env.EUFY_PYTHON = required.python;
  process.env.EUFY_FFMPEG = required.ffmpeg;
  return required;
}
async function stopHttp(server) {
  const cleanup = server.shutdown(); cleanup.catch(() => {});
  const closed = server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
  const settled = await Promise.allSettled([cleanup, closed]);
  const errors = settled.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, 'Resident stop failed');
}
async function resident(dataRoot = defaultDataRoot()) {
  const name = controlName(dataRoot), token = crypto.randomBytes(32).toString('hex');
  let state = 'starting', failure = null, app, stop;
  const owner = await listenControl(name, token, async command => {
    if (command === 'status') return { app: APP_ID, protocol: PROTOCOL, dataRoot: path.resolve(dataRoot), state,
      port: state === 'ready' ? PORT : null, error: failure };
    if (command !== 'stop') throw new Error('CONTROL_COMMAND_INVALID');
    if (!stop) throw new Error(state === 'failed' ? failure : 'SERVICE_NOT_READY');
    await stop(); return { state: 'stopped' };
  });
  fs.mkdirSync(path.dirname(tokenPath(dataRoot)), { recursive: true });
  fs.writeFileSync(tokenPath(dataRoot), token, { mode: 0o600 });
  try {
    configureRuntime();
    const { createServer } = require('../../interface/server.cjs');
    app = createServer({ dataRoot, port: PORT });
    let stopping;
    stop = () => stopping ||= (async () => { state = 'stopping'; await stopHttp(app); state = 'stopped'; owner.close(); })();
    await new Promise((resolve, reject) => {
      const failed = error => { app.off('listening', resolve); reject(error); };
      app.once('error', failed); app.once('listening', () => { app.off('error', failed); resolve(); }); app.start();
    });
    state = 'ready';
    const onSignal = () => stop().catch(error => { console.error(error); process.exitCode = 1; });
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    await new Promise(resolve => owner.once('close', resolve));
  } catch (error) {
    failure = error.code === 'EADDRINUSE' ? 'Another application owns port 3187.' : error.message;
    state = 'failed';
    if (app) await stopHttp(app).catch(() => {});
    await delay(10000); owner.close();
    throw error;
  } finally { fs.rmSync(tokenPath(dataRoot), { force: true }); }
}
async function start(dataRoot = defaultDataRoot()) {
  const logFile = residentLogPath(dataRoot);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.closeSync(fs.openSync(logFile, 'a'));
  const existing = await currentStatus(dataRoot);
  if (existing?.state === 'ready') { openBrowser(); return existing; }
  if (existing && existing.state !== 'starting') throw new Error(`${existing.error || `Resident is ${existing.state}.`} See ${logFile}.`);
  if (!existing) await spawnResident(dataRoot);
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay(100);
    const status = await currentStatus(dataRoot);
    if (status?.state === 'ready') { openBrowser(); return status; }
    if (status?.state === 'failed') throw new Error(`${status.error}. See ${logFile}.`);
  }
  throw new Error(`Resident did not start. See ${logFile}.`);
}
async function stop(dataRoot = defaultDataRoot()) {
  const status = await currentStatus(dataRoot);
  if (!status) return { state: 'not_running' };
  return requestControl(controlName(dataRoot), readToken(dataRoot), 'stop', 120000);
}

if (require.main === module) {
  const command = process.argv[2] || 'start';
  const operation = command === 'start' ? start() : command === 'resident' ? resident(process.env.EUFY_DATA_ROOT || defaultDataRoot())
    : command === 'stop' ? stop() : Promise.reject(new Error('Use start, resident, or stop.'));
  operation.then(result => { if (command !== 'resident') console.log(result.state); }, error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { controlName, listenControl, requestControl, residentLogPath, spawnResident, configureRuntime, resident, start, stop };
