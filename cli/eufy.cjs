#!/usr/bin/env node
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { Writable, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const commands = {
  'auth status': [], 'auth login': ['email', 'password', 'country'], 'auth verify': ['code'],
  'auth refresh': [], 'auth logout': [], 'devices list': [], 'devices get': [], 'devices capabilities': [],
  'recordings ranges': ['day', 'start', 'end', 'end-day', 'timezone'],
  'recordings export': ['serial', 'request-id', 'day', 'start', 'end', 'end-day', 'timezone'],
  'jobs get': [], 'jobs wait': [], 'artifacts list': [], 'artifacts get': ['output'],
};
const help = { usage: 'eufy [global options] <command> [options]', commands: [
  'auth status', 'auth login [--email EMAIL --password PASSWORD --country CA]', 'auth verify [--code CODE]',
  'auth refresh', 'auth logout', 'devices list', 'devices get SERIAL', 'devices capabilities SERIAL CAPABILITY',
  'recordings ranges SERIAL --day DAY --start HH:mm --end HH:mm [--timezone IANA] [--end-day DAY]',
  'recordings export --request-id ID [--serial SERIAL --day DAY --start HH:mm --end HH:mm --timezone IANA --end-day DAY]',
  'jobs get JOB_ID', 'jobs wait JOB_ID', 'artifacts list JOB_ID', 'artifacts get JOB_ID ARTIFACT_ID --output FILE',
], options: {
  '--json': 'One structured result on stdout; all prompts and progress on stderr.',
  '--url URL': 'Resident origin (default EUFY_URL or http://127.0.0.1:3187).',
  '--timeout MS': 'Auth/wait deadline and maximum HTTP request duration (default 300000; each HTTP request at most 30000).',
  '--poll-interval MS': 'Polling interval (default 1000).',
  '--interactive': 'Read prompts even with piped stdin; terminal prompts are automatic.',
  '--no-interactive': 'Return pending auth state; continue with auth verify.',
  '--help': 'Show this implemented command list.',
}, exits: { 0: 'Success/accepted; artifact bytes saved (inspect outcome)', 2: 'CLI usage', 3: 'Service unavailable',
  4: 'Authentication required, challenge pending or auth failed', 5: 'Not found', 6: 'No recordings',
  7: 'Partial export', 8: 'Failed/cancelled export', 9: 'Other HTTP failure', 10: 'Client IO/invalid response', 11: 'Wait timeout' } };
const fault = (code, message, exit, extra = {}) => Object.assign(new Error(message), { value: { error: { code, message }, ...extra }, exit });
const usage = message => fault('CLI_USAGE', message, 2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function resultExit(value, status = 200) {
  const code = value.error?.code || value.job?.error?.code;
  if (['UNAUTHENTICATED', 'LOGIN_REQUIRED'].includes(code)) return 4;
  if (status === 404) return 5;
  if (code === 'PARTIAL_RECORDING') return 7;
  if (['EXPORT_FAILED', 'JOB_CANCELLED'].includes(code) || ['failed', 'cancelled'].includes(value.job?.state)) return 8;
  if (status >= 400) return 9;
  if (value.code === 'NO_RECORDING') return 6;
  return 0;
}

async function main() {
  let json = process.argv.includes('--json'), rl, iterator;
  const emit = (value, exit = 0) => { process.stdout.write(`${JSON.stringify(value, null, json ? undefined : 2)}\n`); process.exitCode = exit; };
  try {
    const globals = ['json', 'url', 'timeout', 'poll-interval', 'interactive', 'no-interactive', 'help'];
    const booleans = new Set(['json', 'interactive', 'no-interactive', 'help']);
    const options = Object.fromEntries([...new Set([...globals, ...Object.values(commands).flat()])].map(name => [name, { type: booleans.has(name) ? 'boolean' : 'string' }]));
    let parsed;
    try { parsed = parseArgs({ options, allowPositionals: true }); } catch (error) { throw usage(error.message); }
    const { values, positionals } = parsed; json = Boolean(values.json);
    if (values.help || positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'help')) {
      if (json) emit(help);
      else process.stdout.write(`${help.usage}\n\n${help.commands.join('\n')}\n\n${Object.entries(help.options).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\nExit codes: ${JSON.stringify(help.exits)}\n`);
      return;
    }
    const command = positionals.slice(0, 2).join(' '), args = positionals.slice(2);
    if (!Object.hasOwn(commands, command)) throw usage(`Unknown command: ${command}. Run eufy help.`);
    for (const key of Object.keys(values)) if (!globals.includes(key) && !commands[command].includes(key)) throw usage(`--${key} is not supported by ${command}.`);
    const count = ['devices capabilities', 'artifacts get'].includes(command) ? 2
      : ['devices get', 'recordings ranges', 'jobs get', 'jobs wait', 'artifacts list'].includes(command) ? 1 : 0;
    if (args.length !== count || args.some(arg => !arg.trim())) throw usage(`${command} requires ${count} positional argument(s). Run eufy help.`);
    const positive = (name, fallback) => {
      const n = values[name] === undefined ? fallback : Number(values[name]);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw usage(`--${name} must be a positive integer in milliseconds (at most 2147483647).`);
      return n;
    };
    const timeout = positive('timeout', 300000), interval = positive('poll-interval', 1000);
    let origin;
    try { origin = new URL(values.url || process.env.EUFY_URL || 'http://127.0.0.1:3187'); } catch { throw usage('Invalid resident URL.'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) throw usage('--url must be an HTTP(S) service origin without a path.');
    if (values.interactive && values['no-interactive']) throw usage('Choose --interactive or --no-interactive.');
    const interactive = !values['no-interactive'] && (values.interactive || process.stdin.isTTY);
    const deadline = Date.now() + timeout;
    let lastResult;
    const expired = () => { if (Date.now() >= deadline) throw fault('WAIT_TIMEOUT', 'Timed out waiting; resident work and pending challenges remain available.', 11, { lastResult }); };
    async function request(route, body, bytes = false) {
      let response;
      try {
        response = await fetch(new URL(route, origin), { method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(timeout, 30000)),
        });
      } catch (error) { throw fault('SERVICE_UNAVAILABLE', `Cannot reach resident service at ${origin.origin}: ${error.message}`, 3); }
      if (bytes && response.ok) return response;
      let value;
      try { value = await response.json(); } catch { throw fault('INVALID_RESPONSE', 'Resident service did not return JSON.', 10); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_RESPONSE', 'Resident service returned an invalid result.', 10);
      if (!response.ok) throw Object.assign(new Error(value.error?.message || `HTTP ${response.status}`), { value, exit: resultExit(value, response.status) });
      return value;
    }
    async function prompt(label) {
      if (!interactive) return undefined;
      if (!rl) {
        // A single iterator retains lines already supplied by scripted stdin; terminal input is not echoed.
        rl = readline.createInterface({ input: process.stdin, output: new Writable({ write(_chunk, _encoding, done) { done(); } }), terminal: Boolean(process.stdin.isTTY) });
        iterator = rl[Symbol.asyncIterator]();
      }
      process.stderr.write(label);
      const next = await iterator.next();
      return next.done ? undefined : next.value;
    }
    async function authFollow(value, logout = false, accepted = false) {
      for (;;) {
        lastResult = value;
        // Recording work also sets busy. A confirmed logout or existing login need not wait for capture.
        if (logout && !value.authenticated && value.phase === 'login_required') return { value, exit: 0 };
        if (!logout && !accepted && value.authenticated && value.phase !== 'busy') return { value, exit: 0 };
        if (value.busy || value.phase === 'busy') {
          process.stderr.write('Waiting for resident authentication...\n');
          expired(); await sleep(Math.min(interval, Math.max(1, deadline - Date.now()))); expired();
          value = await request('/api/v1/session'); continue;
        }
        if (!logout && value.authenticated) return { value, exit: 0 };
        if (['captcha', 'tfa'].includes(value.phase)) {
          if (value.phase === 'captcha' && value.captcha && interactive) {
            const match = /^data:image\/(png|jpeg|gif);base64,(.+)$/s.exec(value.captcha);
            if (match) {
              const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-captcha-'));
              const file = path.join(directory, `challenge.${match[1]}`);
              fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
              process.stderr.write(`Captcha image: ${file}\nOpen this image to read the current challenge.\n`);
            } else process.stderr.write(`View the current captcha at ${origin.origin}/\n`);
          }
          const code = await prompt(value.phase === 'captcha' ? 'Captcha answer: ' : 'Email verification code: ');
          if (code === undefined) {
            process.stderr.write('Challenge pending. Continue with eufy auth verify --code CODE on this resident service.\n');
            return { value, exit: 4 };
          }
          if (!code.trim()) continue;
          await request('/api/v1/session/verify', { code });
          accepted = true;
          value = await request('/api/v1/session'); continue;
        }
        process.stderr.write(`Authentication requires attention: ${value.phase}. Use auth login.\n`);
        return { value, exit: 4 };
      }
    }
    let value, exit;
    const encoded = args.map(encodeURIComponent);
    if (command.startsWith('auth ')) {
      if (command === 'auth status') {
        value = await request('/api/v1/session'); exit = value.authenticated ? 0 : 4;
      } else {
        let accepted = false;
        if (command === 'auth login') {
          value = await request('/api/v1/session');
          if (!value.authenticated && !value.busy && !['busy', 'captcha', 'tfa'].includes(value.phase)) {
            const data = {};
            for (const [name, label] of [['email', 'Email: '], ['password', 'Password: '], ['country', 'Country (two letters, e.g. CA): ']]) {
              data[name] = values[name] ?? await prompt(label);
              if (!data[name]) throw usage(`auth login requires --${name} or interactive input.`);
            }
            await request('/api/v1/session/login', data); accepted = true; value = await request('/api/v1/session');
          }
        } else {
          const action = command.split(' ')[1];
          let body = {};
          if (action === 'verify') {
            const code = values.code ?? await prompt('Verification code: ');
            if (!code) {
              value = await request('/api/v1/session');
              ({ value, exit } = await authFollow(value)); emit(value, exit); return;
            }
            body = { code };
          }
          await request(`/api/v1/session/${action}`, body); accepted = true; value = await request('/api/v1/session');
        }
        ({ value, exit } = await authFollow(value, command === 'auth logout', accepted));
      }
    } else if (command.startsWith('devices ')) {
      value = await request(command === 'devices list' ? '/api/v1/devices' : `/api/v1/devices/${encoded[0]}${command === 'devices capabilities' ? `/capabilities/${encoded[1]}` : ''}`);
    } else if (command.startsWith('recordings ')) {
      const body = {};
      for (const key of commands[command]) if (values[key] !== undefined) body[key === 'request-id' ? 'requestId' : key === 'end-day' ? 'endDay' : key] = values[key];
      if (command === 'recordings export' && !body.requestId?.trim()) throw usage('recordings export requires --request-id ID.');
      if (command === 'recordings ranges' && ['day', 'start', 'end'].some(key => !body[key])) throw usage('recordings ranges requires --day, --start and --end.');
      value = await request(command === 'recordings ranges' ? `/api/v1/devices/${encoded[0]}/recording-ranges` : '/api/v1/exports', body);
      if (value.job) process.stderr.write(`Job ${value.job.jobId}: ${value.job.state}. Follow with eufy jobs wait ${value.job.jobId}.\n`);
    } else if (command.startsWith('jobs ')) {
      value = await request(`/api/v1/jobs/${encoded[0]}`);
      let previous;
      while (command === 'jobs wait' && ['queued', 'running'].includes(value.job?.state) && !value.job.error) {
        lastResult = value;
        const progress = `${value.job.jobId}: ${value.job.state} / ${value.job.stage} (${Math.round(value.job.progress * 100)}%)`;
        if (progress !== previous) process.stderr.write(`${progress}\n`);
        previous = progress; expired(); await sleep(Math.min(interval, Math.max(1, deadline - Date.now()))); expired();
        value = await request(`/api/v1/jobs/${encoded[0]}`);
      }
    } else {
      if (command === 'artifacts get' && !values.output) throw usage('artifacts get requires --output FILE.');
      value = await request(`/api/v1/jobs/${encoded[0]}/artifacts`);
      if (command === 'artifacts get') {
        const artifact = value.artifacts.find(item => item.id === args[1]);
        if (!artifact) throw fault('ARTIFACT_NOT_FOUND', 'Unknown artifact for this job.', 5);
        const response = await request(artifact.url, undefined, true);
        const output = path.resolve(values.output);
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(output));
        value = { jobId: value.jobId, artifact, output };
        process.stderr.write(`Saved ${output}; artifact outcome: ${artifact.outcome}.\n`);
      }
    }
    exit ??= resultExit(value);
    if (exit) process.stderr.write(`${value.error?.code || value.job?.error?.code || value.code || value.phase}: ${value.error?.message || value.job?.error?.message || 'Inspect the structured result.'}\n`);
    emit(value, exit);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    emit(error.value || { error: { code: 'CLIENT_IO_ERROR', message: error.message } }, error.exit || 10);
  } finally { rl?.close(); }
}

main();
