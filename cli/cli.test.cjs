const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cli } = require('./test-helper.cjs');


async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = { method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    const { status = 200, value, bytes } = await handler(call);
    res.writeHead(status, { 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' });
    res.end(bytes || JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { calls, run: (args, input) => cli(['--url', url, '--json', '--poll-interval', '5', ...args], input) };
}

test('installed command metadata, help and invalid usage are structured without contacting service', async () => {
  const pkg = require('../package.json'); assert.equal(pkg.bin.eufy, 'cli/eufy.cjs');
  const help = await cli(['--json', 'help']); assert.equal(help.code, 0);
  for (const command of ['auth login', 'devices capabilities', 'recordings export', 'jobs wait', 'artifacts get'])
    assert.ok(help.value.commands.some(line => line.startsWith(command)));
  assert.doesNotMatch(help.stdout, /jobs cancel|retry|live/);
  for (const args of [['jobs', 'cancel', 'x'], ['devices', 'list', '--day', 'today'], ['jobs', 'get'], ['--timeout', 'bad', 'auth', 'status']]) {
    const r = await cli(['--json', ...args]); assert.equal(r.code, 2); assert.equal(r.value.error.code, 'CLI_USAGE');
  }
});

test('unreachable resident gives a structured service-unavailable result', async () => {
  const r = await cli(['--json', 'devices', 'list']);
  assert.equal(r.code, 3); assert.equal(r.value.error.code, 'SERVICE_UNAVAILABLE');
});

test('HTTP bodies and terminal HTTP-200 errors remain unchanged with stable exits', async t => {
  let response;
  const f = await fixture(t, () => response);
  for (const [status, error, exit] of [[401, 'UNAUTHENTICATED', 4], [404, 'DEVICE_NOT_FOUND', 5], [409, 'SERVICE_BUSY', 9], [503, 'DEVICE_UNAVAILABLE', 9]]) {
    response = { status, value: { error: { code: error, message: 'fixture message' } } };
    const r = await f.run(['devices', 'get', 'unknown']); assert.equal(r.code, exit); assert.deepEqual(r.value, response.value);
  }
  for (const [code, outcome, exit] of [['PARTIAL_RECORDING', 'partial', 7], ['EXPORT_FAILED', 'failed', 8], ['JOB_CANCELLED', 'cancelled', 8], ['LOGIN_REQUIRED', 'cancelled', 4]]) {
    response = { value: { job: { jobId: 'durable', state: outcome === 'cancelled' ? 'cancelled' : 'failed', result: { outcome }, error: { code, message: code } } } };
    for (const command of ['get', 'wait']) {
      const r = await f.run(['jobs', command, 'durable']); assert.equal(r.code, exit); assert.deepEqual(r.value, response.value);
    }
  }
});

test('ranges and request-ID replay pass caller strings to HTTP without local normalization', async t => {
  const value = { window: { normalized: { timezone: 'Europe/London' } }, availability: 'none', code: 'NO_RECORDING', ranges: [], coverage: null };
  const f = await fixture(t, () => ({ value }));
  const r = await f.run(['recordings', 'ranges', 'camera a', '--day', '2026-10-25', '--start', '01:30', '--end', '02:30', '--end-day', '2026-10-26', '--timezone', 'Europe/London']);
  assert.equal(r.code, 6); assert.deepEqual(r.value, value);
  assert.deepEqual(f.calls[0], { method: 'POST', url: '/api/v1/devices/camera%20a/recording-ranges', body: { day: '2026-10-25', start: '01:30', end: '02:30', endDay: '2026-10-26', timezone: 'Europe/London' } });
  await f.run(['recordings', 'export', '--request-id', 'exact ID']);
  assert.deepEqual(f.calls.at(-1).body, { requestId: 'exact ID' });
});

test('auth polls acceptance, prompts captcha/email to stderr and continues existing challenge', async t => {
  let phase = 'idle', busyPolls = 0, loginCount = 0;
  const f = await fixture(t, call => {
    if (call.method === 'POST') {
      if (call.url.endsWith('/login')) { loginCount++; assert.deepEqual(call.body, { email: 'fixture@example.test', password: 'fixture-password', country: 'CA' }); phase = 'captcha'; }
      else if (call.body.code === 'image-answer') phase = 'tfa';
      else if (call.body.code === '123456') phase = 'connected';
      busyPolls = 1; return { status: 202, value: { ok: true } };
    }
    if (busyPolls-- > 0) return { value: { phase: 'busy', authenticated: false, busy: true, captcha: null } };
    return { value: { phase, authenticated: phase === 'connected', busy: false,
      captcha: phase === 'captcha' ? 'data:image/png;base64,aW1hZ2U=' : null } };
  });
  const r = await f.run(['auth', 'login', '--interactive'], 'fixture@example.test\nfixture-password\nCA\nimage-answer\n123456\n');
  assert.equal(r.code, 0); assert.equal(r.value.phase, 'connected');
  assert.match(r.stderr, /Captcha image:/); assert.match(r.stderr, /Email verification code:/); assert.doesNotMatch(r.stdout, /fixture-password|image-answer/);
  phase = 'tfa';
  const pending = await f.run(['auth', 'login', '--no-interactive']); assert.equal(pending.code, 4); assert.equal(pending.value.phase, 'tfa');
  const continued = await f.run(['auth', 'verify', '--code', '123456']); assert.equal(continued.code, 0); assert.equal(loginCount, 1);
  phase = 'error'; const failed = await f.run(['auth', 'status']); assert.equal(failed.code, 4); assert.equal(failed.value.phase, 'error');
});

test('wait reports progress only on stderr and times out without cancelling work', async t => {
  const value = { job: { jobId: 'pending', state: 'running', stage: 'capture', progress: 0.2, error: null } };
  const f = await fixture(t, () => ({ value }));
  const r = await f.run(['jobs', 'wait', 'pending', '--timeout', '150']);
  assert.equal(r.code, 11); assert.equal(r.value.error.code, 'WAIT_TIMEOUT'); assert.deepEqual(r.value.lastResult, value);
  assert.match(r.stderr, /capture/); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('R1: accepted auth mutations still await genuine authentication work and confirmed logout', async t => {
  for (const action of ['login', 'verify', 'refresh', 'logout']) {
    let accepted = false, polls = 0;
    const f = await fixture(t, call => {
      if (call.method === 'POST') { accepted = true; return { status: 202, value: { ok: true } }; }
      if (!accepted) return { value: { authenticated: false, phase: 'idle', busy: false, captcha: null } };
      polls++;
      if (polls === 1) return { value: { authenticated: true, phase: 'connected', busy: true, captcha: null } };
      return { value: { authenticated: action !== 'logout', phase: action === 'logout' ? 'login_required' : 'connected', busy: false, captcha: null } };
    });
    const args = action === 'login' ? ['--email', 'fixture@example.test', '--password', 'fixture-password', '--country', 'CA']
      : action === 'verify' ? ['--code', '123456'] : [];
    const r = await f.run(['auth', action, ...args]);
    assert.equal(r.code, 0); assert.equal(polls, 2, `${action} must not treat 202 or an intermediate authenticated snapshot as completion`);
    assert.equal(r.value.authenticated, action !== 'logout'); assert.equal(r.value.busy, false);
  }
});

test('artifact downloads follow registered URL and emit metadata, never bytes, on JSON stdout', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-cli-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifact = { id: 'a', name: 'partial.mp4', url: '/registered-file', outcome: 'partial', playable: true, validated: true };
  const f = await fixture(t, call => call.url === '/registered-file' ? { bytes: Buffer.from('fixture bytes') } : { value: { jobId: 'j', artifacts: [artifact] } });
  const output = path.join(directory, 'saved.mp4');
  const r = await f.run(['artifacts', 'get', 'j', 'a', '--output', output]);
  assert.equal(r.code, 0); assert.deepEqual(r.value.artifact, artifact); assert.equal(r.value.output, output);
  assert.equal(fs.readFileSync(output, 'utf8'), 'fixture bytes');
  const absent = await f.run(['artifacts', 'get', 'j', 'absent', '--output', output]); assert.equal(absent.code, 5);
});
