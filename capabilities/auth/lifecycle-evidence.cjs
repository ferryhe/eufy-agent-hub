// Opt-in acceptance runner. The controller starts it only after independent review.
const fs = require('node:fs');
const path = require('node:path');
const { LocalEufySession } = require('./session.cjs');
const { createServer } = require('../../interface/server.cjs');
const { fork } = require('node:child_process');

async function startLifecycleEvidence({ directory, port = 3189,
  createSession, onReady = () => {} }) {
  if (!path.isAbsolute(directory || '')) throw new Error('An absolute private evidence directory is required');
  const repository = path.resolve(__dirname, '../..');
  const relative = path.relative(repository, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Evidence must be outside the worktree');
  if (Number(port) === 3187) throw new Error('Port 3187 is reserved for the existing service');
  fs.mkdirSync(directory, { recursive: true });
  const sessionPath = path.join(directory, 'session.json');
  const reportPath = path.join(directory, 'auth-lifecycle.json');
  if (fs.existsSync(sessionPath) || fs.existsSync(reportPath)) throw new Error('Use a fresh private evidence directory');
  const report = { version: 1, startedAt: new Date().toISOString(), normalLogin: false,
    restart: null, logout: null, newDeviceRequest: null, complete: false };
  let server, child, timer, running = false, stopped = false, finish, fail;
  const completion = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  const close = async () => {
    if (child && child.exitCode === null) {
      const processToClose = child;
      await new Promise(resolve => { processToClose.once('exit', resolve); processToClose.send('stop'); });
      child = undefined;
    }
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await server?.shutdown();
  };
  const open = async () => {
    if (!createSession) {
      child = fork(__filename, ['--resident'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, EUFY_AUTH_EVIDENCE_DIR: directory, EUFY_VALIDATION_PORT: String(port) } });
      return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Resident exited before ready')));
        child.once('message', message => message?.origin ? resolve(message.origin) : reject(new Error('Resident failed')));
      });
    }
    const session = createSession(sessionPath);
    server = createServer({ port, session, outputRoot: path.join(directory, 'local-output') });
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.start(resolve); server.ready.catch(reject);
    });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    stopped = true; clearInterval(timer);
    await close();
    if (!report.complete) { report.stopped = true; save(); fail(new Error('Validation stopped')); }
  };
  const origin = await open();
  onReady(origin);
  timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      const status = await fetch(origin + '/status').then(response => response.json());
      if (!status.authenticated || status.phase !== 'connected' || status.busy || status.diagnostics.length) { running = false; return; }
      clearInterval(timer);
      report.normalLogin = true; report.loginAt = new Date().toISOString();
      report.persisted = fs.existsSync(sessionPath); save();
      await close();
      if (stopped) return;
      const restarted = await open(); // A fresh Node process in a real run; never reuses provider memory.
      const state = await fetch(restarted + '/api/v1/session').then(response => response.json());
      report.restart = { authenticated: state.authenticated, phase: state.phase,
        result: state.authenticated ? 'restored' : state.phase === 'login_required' ? 'login_required' : 'unexpected' };
      const logout = await fetch(restarted + '/api/v1/session/logout', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const after = await fetch(restarted + '/api/v1/session').then(response => response.json());
      report.logout = { status: logout.status, authenticated: after.authenticated, sessionFileRemoved: !fs.existsSync(sessionPath) };
      const denied = await fetch(restarted + '/api/v1/devices'); const body = await denied.json();
      report.newDeviceRequest = { status: denied.status, code: body.error?.code || null };
      report.complete = report.normalLogin && report.persisted && report.restart.result !== 'unexpected'
        && logout.status === 202 && !after.authenticated && report.logout.sessionFileRemoved
        && denied.status === 401 && body.error?.code === 'UNAUTHENTICATED';
      report.finishedAt = new Date().toISOString(); save(); await close(); finish(report);
    } catch {
      // Do not put provider errors, account details or tokens in the evidence record.
      report.failure = 'VALIDATION_FAILED'; save(); await close(); fail(new Error('Validation failed; inspect the local page without publishing account data'));
    }
  }, 500);
  return { completion, stop, reportPath };
}

if (require.main === module && process.argv[2] === '--resident') {
  const directory = process.env.EUFY_AUTH_EVIDENCE_DIR;
  const server = createServer({ port: Number(process.env.EUFY_VALIDATION_PORT),
    sessionPath: path.join(directory, 'session.json'), outputRoot: path.join(directory, 'local-output') });
  server.start(() => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
  const stop = () => server.close(async () => {
    await server.shutdown(); process.exit(0);
  });
  process.once('message', message => { if (message === 'stop') stop(); });
  process.once('disconnect', stop);
} else if (require.main === module) {
  startLifecycleEvidence({ directory: process.env.EUFY_AUTH_EVIDENCE_DIR,
    onReady: origin => console.log(`Sign in normally at ${origin}. After login this runner restarts its own service, tests restore, then logs out.`),
  }).then(runner => {
    const stop = () => runner.stop().catch(() => {});
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    runner.completion.then(report => {
      console.log(`Auth lifecycle validation complete: ${report.complete}; restart: ${report.restart.result}; device rejection: ${report.newDeviceRequest.status}`);
      process.exit(report.complete ? 0 : 1);
    }, () => { console.error('Auth lifecycle validation did not complete.'); process.exit(1); });
  }, () => { console.error('Could not start the isolated validation service.'); process.exitCode = 1; });
}

module.exports = { startLifecycleEvidence };
