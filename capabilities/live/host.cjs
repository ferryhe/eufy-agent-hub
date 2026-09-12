// Bounded one-shot acceptance host. Run only with the resident owner stopped.
// The same LiveSessions controller is used by v1; this is not a protocol bypass.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { OUTPUT } = require('../recordings/continuous-export.cjs');
const { createDecoder } = require('./decoder.cjs');
const { decodeSample } = require('./sample.cjs');
const { describeDevices } = require('../devices/capabilities.cjs');

const hostError = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
function boundDevice(raw, serial) {
  if (!Array.isArray(raw)) throw hostError('HOST_BINDING_MISMATCH');
  const matches = raw.filter(device => device.device_sn === serial);
  if (matches.length !== 1) throw hostError('HOST_BINDING_MISMATCH');
  const target = matches[0];
  if (raw.filter(device => device.device_sn === target.parent_sn).length !== 1
    || raw.filter(device => device.parent_sn === target.parent_sn && device.device_channel === target.device_channel).length !== 1)
    throw hostError('HOST_BINDING_MISMATCH');
  return describeDevices(raw).find(device => device.serial === serial);
}

async function runLiveHost({ runtime, binding, durationMs = 5000, signal }) {
  const proof = { version: 1, status: 'failed', hardwareVerified: false, error: null, cleanupComplete: false,
    observedAt: new Date().toISOString(), media: { transport: 'MJPEG', audio: false, receivedBytes: 0, decodedFrames: 0 }, capabilityUpdated: false };
  let server, directory, consume, reader, stage = 'restore', sampleBytes = 0;
  const sample = [];
  const stop = () => { server?.shutdown().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 10000) throw hostError('HOST_ARGUMENTS_INVALID');
    await runtime.session.restore(); signal?.throwIfAborted();
    stage = 'bind';
    const device = await runtime.resolveDevice(binding.serial); signal?.throwIfAborted();
    const scope = device?.verificationScope;
    if (!scope || scope.serial !== binding.serial || scope.homeBase?.serial !== binding.homeBaseId || scope.channel !== binding.channel
      || scope.model !== 'T8600' || scope.homeBase.model !== 'T8030') throw hostError('HOST_BINDING_MISMATCH');
    proof.binding = { deviceIdHash: digest(scope.serial), homeBaseIdHash: digest(scope.homeBase.serial),
      cameraModel: scope.model, cameraFirmware: scope.firmware, homeBaseModel: scope.homeBase.model,
      homeBaseFirmware: scope.homeBase.firmware, channel: scope.channel, inventoryMatched: true };
    const { createServer } = require('../../interface/server.cjs');
    fs.mkdirSync(OUTPUT, { recursive: true });
    directory = fs.mkdtempSync(path.join(OUTPUT, 'live-host-'));
    const decoder = runtime.liveOptions?.createDecoder || createDecoder;
    server = createServer({ port: 0, session: runtime.session, recordings: { close() {} }, outputRoot: directory,
      exports: { outputRoot: path.join(directory, 'jobs') }, deviceRepository: { read: () => ({ records: [] }) },
      live: { ...runtime.liveOptions, createDecoder: options => decoder({ ...options, onFrame: frame => {
        if (options.onFrame(frame) === false) return;
        sampleBytes += frame.length;
        if (sampleBytes > 32 * 1024 * 1024) return options.onError(hostError('LIVE_DECODER_FAILED'));
        sample.push(frame);
      } }) } });
    // Restore exactly once above; listen directly without invoking server.start's
    // restore hook. Root has already drained the previous resident owner.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const json = async (route, data) => {
      const response = await fetch(origin + route, { method: data === undefined ? 'GET' : 'POST', signal,
        headers: { 'Content-Type': 'application/json', Connection: 'close' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const value = await response.json();
      if (response.status >= 400) throw hostError(value.error?.code || 'HOST_OPERATION_FAILED');
      return value;
    };
    stage = 'start';
    const input = { serial: binding.serial, requestId: 'bounded-live-acceptance', maxDurationMs: durationMs + 2000 };
    const opened = (await json('/api/v1/live-sessions', input)).live;
    signal?.throwIfAborted();
    const duplicate = (await json('/api/v1/live-sessions', input)).live;
    proof.requestIdempotent = opened.sessionId === duplicate.sessionId;
    stage = 'conflict';
    try {
      await json('/api/v1/exports', { requestId: 'must-conflict', serial: binding.serial,
        day: '2026-09-12', start: '00:00', end: '00:01', timezone: 'UTC' });
      throw hostError('HOST_PROOF_INCOMPLETE');
    } catch (error) {
      if (error.code !== 'SERVICE_BUSY') throw error;
      proof.sharedHomeBaseConflict = { operation: 'continuous_export', code: 'SERVICE_BUSY', preempted: false };
    }
    stage = 'media';
    const response = await fetch(origin + opened.media.url, { signal });
    if (response.status !== 200) throw hostError('HOST_PROOF_INCOMPLETE');
    reader = response.body.getReader();
    consume = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; proof.media.receivedBytes += value.length; } })();
    consume.catch(() => {});
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(hostError('HOST_INTERRUPTED')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, durationMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    stage = 'stop';
    const stopped = (await json(`/api/v1/live-sessions/${opened.sessionId}/stop`, {})).live;
    const repeated = (await json(`/api/v1/live-sessions/${opened.sessionId}/stop`, {})).live;
    await consume;
    proof.stopIdempotent = stopped.sessionId === repeated.sessionId && repeated.cleanupComplete;
    proof.media.decodedFrames = stopped.media.decodedFrames;
    proof.stopConfirmed = stopped.stopConfirmed; proof.operations = stopped.operations;
    proof.channelChecks = stopped.channelChecks; proof.capabilityStatus = stopped.capability.status;
    proof.resources = stopped.resources;
    proof.cleanupComplete = stopped.cleanupComplete && !(await json('/api/v1/session')).busy;
    if (stopped.error) throw hostError(stopped.error.code);
    stage = 'full_decode';
    proof.sample = { format: 'mjpeg', frames: sample.length, bytes: sampleBytes,
      fullDecode: await (runtime.decodeSample || decodeSample)(sample) };
    if (!proof.media.receivedBytes || proof.media.decodedFrames < 2 || !proof.stopConfirmed || !proof.cleanupComplete
      || !proof.requestIdempotent || !proof.stopIdempotent || !proof.sample.fullDecode.passed
      || proof.sample.frames !== proof.media.decodedFrames || !proof.sample.fullDecode.childClosed
      || !Object.values(proof.resources).every(Boolean)) throw hostError('HOST_PROOF_INCOMPLETE');
    proof.status = 'completed';
  } catch (error) {
    const allowed = require('./session.cjs').statuses;
    const code = allowed[error?.code] || ['HOST_ARGUMENTS_INVALID', 'HOST_BINDING_MISMATCH', 'HOST_INTERRUPTED', 'HOST_PROOF_INCOMPLETE'].includes(error?.code)
      ? error.code : 'HOST_OPERATION_FAILED';
    proof.error = { code, stage };
  } finally {
    signal?.removeEventListener('abort', stop);
    try {
      await reader?.cancel().catch(() => {}); await consume?.catch(() => {});
      if (server) {
        try { await server.shutdown(); }
        finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
      } else await runtime.session.close?.();
      sample.length = 0;
      if (directory) {
        const relative = path.relative(OUTPUT, directory);
        if (!relative.startsWith('live-host-') || relative.includes(path.sep)) throw hostError('LIVE_CLEANUP_FAILED');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch { proof.cleanupComplete = false; proof.status = 'failed'; proof.error = { code: 'LIVE_CLEANUP_FAILED', stage: 'cleanup' }; }
  }
  return proof;
}

function createRealRuntime(sessionPath) {
  const { setLoggingLevel, LogLevel } = require('../../vendor/eufy-security-client/build/logging');
  setLoggingLevel('all', LogLevel.Off);
  const { LocalEufySession } = require('../auth/session.cjs');
  class ExistingSession extends LocalEufySession {
    // Failed restore must not remove the root owner's saved session file.
    logout(key) { const saved = this.sessionPath; this.sessionPath = undefined;
      try { return super.logout(key); } finally { this.sessionPath = saved; } }
  }
  const session = new ExistingSession(undefined, { sessionPath });
  return { session, resolveDevice: async serial => {
    const inventory = await session.api.getDevsListDecrypted();
    return boundDevice(inventory?.devices, serial);
  } };
}

function createDryRunRuntime() {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const { CommandName, DeviceType } = require('../../adapters/eufy');
  const raw = [{ device_sn: 'fixture-base', device_model: 'T8030', device_type: DeviceType.HB3, local_ip: '192.0.2.1', main_sw_version: 'b1', sec_sw_version: 'b2' },
    { device_sn: 'fixture-camera', device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247, parent_sn: 'fixture-base',
      device_channel: 1, main_sw_version: 'c1', sec_sw_version: 'c2' }];
  const station = new EventEmitter(); let connected = false;
  const ack = name => station.emit('command result', station, { channel: 1, return_code: 0, customData: { command: { name } } });
  Object.assign(station, { getSerial: () => 'fixture-base', getModel: () => 'T8030',
    p2pSession: { isConnected: () => connected, isCurrentlyStreaming: () => false }, isLiveStreaming: () => connected,
    startLivestream() { queueMicrotask(() => {
      ack(CommandName.DeviceStartLivestream); station.emit('livestream start', station, 1, { videoCodec: 0 }, new PassThrough(), new PassThrough());
    }); }, stopLivestream() { queueMicrotask(() => ack(CommandName.DeviceStopLivestream)); } });
  return { raw, session: { state: { phase: 'connected' }, api: { getDevsListDecrypted: async () => ({ devices: raw }) }, restore: async () => {}, isAuthenticated: () => true },
    resolveDevice: async serial => boundDevice(raw, serial),
    decodeSample: async frames => ({ passed: true, decodedFrames: frames.length, exitCode: 0, childClosed: true, fixture: true }),
    liveOptions: { createConnection: () => ({ station, camera: { getSerial: () => 'fixture-camera', getModel: () => 'T8600',
      getStationSerial: () => 'fixture-base', getChannel: () => 1 }, connect: async () => { connected = true; }, close: async () => { connected = false; } }),
    createDecoder: ({ onFrame }) => { const frame = () => onFrame(Buffer.from([255,216,0,255,217])); queueMicrotask(frame);
      const timer = setInterval(frame, 100); return { close: async () => clearInterval(timer) }; } } };
}

function preflight(env) {
  const input = env.EUFY_SESSION_PATH, output = env.EUFY_LIVE_EVIDENCE_PATH;
  const root = path.resolve(__dirname, '../..');
  const outside = file => { const relative = path.relative(root, file); return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); };
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output) || !outside(output)
    || path.resolve(input).toLowerCase() === path.resolve(output).toLowerCase() || !fs.statSync(input).isFile()
    || fs.existsSync(output) || !env.EUFY_LIVE_DEVICE_SERIAL?.trim() || !env.EUFY_LIVE_HOMEBASE_SERIAL?.trim()
    || !/^\d+$/.test(env.EUFY_LIVE_CHANNEL || '') || env.EUFY_LIVE_RESIDENT_STOPPED !== '1') throw hostError('HOST_PREFLIGHT_FAILED');
  fs.accessSync(path.dirname(output), fs.constants.W_OK);
}

async function main({ argv = process.argv.slice(2), env = process.env, createRuntime, checkPaths = preflight,
  writeEvidence = (file, proof) => fs.writeFileSync(file, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 }) } = {}) {
  const failure = code => ({ version: 1, status: 'failed', hardwareVerified: false, error: { code, stage: 'preflight' } });
  if (argv.length === 1 && argv[0] === '--help') return { version: 1, status: 'completed', mode: 'help',
    commands: ['--dry-run', '--run', '--record-proof'], ownership: 'Root must drain and stop the existing resident before --run; restore the same completed session once, without login or retries.',
    runEnvironment: ['EUFY_SESSION_PATH', 'EUFY_LIVE_EVIDENCE_PATH', 'EUFY_LIVE_DEVICE_SERIAL', 'EUFY_LIVE_HOMEBASE_SERIAL', 'EUFY_LIVE_CHANNEL', 'EUFY_LIVE_RESIDENT_STOPPED=1', 'EUFY_FFMPEG'],
    recordEnvironment: ['EUFY_LIVE_EVIDENCE_PATH', 'EUFY_CAPABILITY_RECORDS_PATH', 'EUFY_LIVE_PROOF_ACCEPTED=1'],
    dryRun: 'Uses only synthetic inventory, protocol, decoder and proof validation fixtures; never opens the real session or hardware.' };
  if (argv.length === 1 && argv[0] === '--record-proof') {
    try { return require('./record-proof.cjs').recordProof(env); }
    catch (error) { return failure(['HOST_PROOF_NOT_ACCEPTED', 'HOST_PROOF_INVALID', 'HOST_RECORD_FAILED'].includes(error.code) ? error.code : 'HOST_RECORD_FAILED'); }
  }
  if (argv.length !== 1 || !['--dry-run', '--run'].includes(argv[0])) return failure('HOST_ARGUMENTS_INVALID');
  const dryRun = argv[0] === '--dry-run';
  if (!dryRun) { try { checkPaths(env); } catch { return failure('HOST_PREFLIGHT_FAILED'); } }
  const controller = new AbortController(), interrupt = () => controller.abort(hostError('HOST_INTERRUPTED'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const timeout = setTimeout(interrupt, 120000);
  try {
    const runtime = createRuntime ? createRuntime(dryRun) : dryRun ? createDryRunRuntime() : createRealRuntime(env.EUFY_SESSION_PATH);
    const binding = dryRun ? { serial: 'fixture-camera', homeBaseId: 'fixture-base', channel: 1 }
      : { serial: env.EUFY_LIVE_DEVICE_SERIAL, homeBaseId: env.EUFY_LIVE_HOMEBASE_SERIAL, channel: Number(env.EUFY_LIVE_CHANNEL) };
    const proof = await runLiveHost({ runtime, binding, durationMs: dryRun ? 1000 : 5000, signal: controller.signal });
    proof.mode = dryRun ? 'dry-run' : 'run'; proof.mediaSource = dryRun ? 'protocol_and_decoder_fixture' : 'current_bound_device';
    if (!dryRun) { try { writeEvidence(env.EUFY_LIVE_EVIDENCE_PATH, { ...proof, privateBinding: binding }); } catch { return failure('HOST_EVIDENCE_FAILED'); } }
    return proof;
  } catch { return failure('HOST_RUNTIME_FAILED'); }
  finally { clearTimeout(timeout); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

if (require.main === module) main().then(proof => process.stdout.write(`${JSON.stringify(proof)}\n`, () => process.exit(proof.status === 'completed' ? 0 : 1)));
module.exports = { main, runLiveHost, createDryRunRuntime, createRealRuntime, preflight };
