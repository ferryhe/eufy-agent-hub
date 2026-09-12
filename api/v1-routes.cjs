const fs = require('node:fs');
const path = require('node:path');
const { ContinuousExportService } = require('../capabilities/recordings/continuous-export.cjs');
const { LocalContinuousRecordings } = require('../capabilities/recordings/continuous.cjs');
const { PlaybackSessions } = require('../capabilities/recordings/playback-session.cjs');
const { LiveSessions } = require('../capabilities/live/session.cjs');
const { normalizeWindow } = require('../capabilities/recordings/time-window.cjs');
const { recordingSegments } = require('../capabilities/recordings/continuous-completeness.cjs');
const { describeDevices, queryCapability } = require('../capabilities/devices/capabilities.cjs');
const { DeviceVerificationRepository } = require('../capabilities/devices/verification-store.cjs');
const { readDeviceInventory, failedDiscovery } = require('../capabilities/devices/discovery.cjs');
const { serveMedia } = require('./legacy-recording-routes.cjs');
const { contract, validateRequest } = require('./v1-contract.cjs');
const { isAuthenticated } = require('../capabilities/auth/session.cjs');

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const timeErrors = {
  'service.recordings.invalidTimezone': 'INVALID_TIMEZONE',
  'service.recordings.invalidDate': 'INVALID_WINDOW',
  'service.recordings.invalidDateTime': 'INVALID_WINDOW',
  'service.recordings.ambiguousTime': 'AMBIGUOUS_OR_NONEXISTENT_TIME',
  'service.recordings.invalidEndTime': 'INVALID_WINDOW',
};
function windowOf(data) {
  try { return normalizeWindow(data); }
  catch (error) { throw fault(400, timeErrors[error.i18n?.key] || 'INVALID_WINDOW', error.message); }
}
function artifactList(job) {
  return job.artifacts.map(item => {
    const id = Buffer.from(item.path).toString('base64url');
    const playable = item.path === job.result?.media?.path && job.result.media.playable === true
      && job.result.validation?.passed === true;
    return { id, name: path.posix.basename(item.path), path: item.path,
      playable, validated: playable, outcome: job.result?.outcome || null,
      url: `/api/v1/jobs/${job.jobId}/artifacts/${id}` };
  });
}
function jobView(job, loginRequired = false) {
  const { jobId, requestId, homeBaseId, state, stage, progress, createdAt, updatedAt, input, result } = job;
  const code = loginRequired || job.error?.code === 'LOGIN_REQUIRED' ? 'LOGIN_REQUIRED' : state === 'cancelled' ? 'JOB_CANCELLED'
    : job.error?.code === 'JOB_INTERRUPTED' ? 'JOB_INTERRUPTED' : state !== 'failed' ? null
    : result?.outcome === 'partial' ? 'PARTIAL_RECORDING' : 'EXPORT_FAILED';
  return { jobId, requestId, homeBaseId, serial: input.serial, window: input.window,
    retryOfJobId: job.retryOfJobId || null, attempt: job.attempt || 1, cancellationRequestedAt: job.cancellationRequestedAt || null,
    state, stage: loginRequired ? 'login_required' : stage, progress, createdAt, updatedAt, result, artifacts: artifactList(job),
    error: code ? { code, message: job.error?.message || code } : null };
}

function installV1Routes(server, session, options) {
  const deviceRepository = options.deviceRepository || new DeviceVerificationRepository(options.capabilityRecordsPath);
  let exporter, pending = 0, rangeBusy = false, stopping = false;
  // Report known cloud expiry without logging out or disturbing accepted local work.
  const cloudAuthenticated = () => isAuthenticated(session);
  const view = job => jobView(job, job.state === 'queued' && !cloudAuthenticated());
  const requireCloudSession = () => {
    if (!cloudAuthenticated()) throw fault(401, 'UNAUTHENTICATED', 'Complete the local login first.');
  };
  const drained = [];
  const release = () => { if (--pending === 0) for (const resolve of drained.splice(0)) resolve(); };
  const ranges = new Set();
  const playback = new PlaybackSessions({ session, createConnection: options.playback?.createConnection,
    acquireMedia: homeBaseId => getExporter().jobs.acquireMedia(homeBaseId),
    resolveDevice: async serial => { const { devices, discovery } = await inventory(); return findDevice(devices, serial, discovery); } });
  const getExporter = () => exporter ||= new ContinuousExportService({ session, ...options.exports });
  const live = new LiveSessions({ session, ...options.live, jobs: { acquireMedia: homeBaseId => getExporter().jobs.acquireMedia(homeBaseId) },
    resolveDevice: async serial => { const { devices, discovery } = await inventory(); return findDevice(devices, serial, discovery); } });
  const active = () => pending > 0 || playback.isBusy() || live.isBusy() || Boolean(exporter?.jobs.list().some(job => ['queued', 'running'].includes(job.state)));
  // Listening follows session restoration. Recover durable work without a new
  // caller request, and include that work in the existing session/media guards.
  server.once('listening', getExporter);
  const original = server.listeners('request')[0];
  server.removeListener('request', original);
  server.on('request', async (req, res) => {
    const origin = options.getOrigin();
    const route = new URL(req.url, origin).pathname;
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (!route.startsWith('/api/v1')) {
        // Session replacement and legacy playback must not interrupt resident exports.
        if (req.method === 'POST' && active() && ['/login', '/verify', '/refresh', '/recordings/query', '/recordings/download'].includes(route))
          throw fault(409, 'SERVICE_BUSY', 'A recording operation owns the current session. Wait for it to finish.');
        return original(req, res);
      }
      if (req.headers.host !== new URL(origin).host) throw fault(403, 'LOCAL_HOST_REQUIRED', 'Use the local service address.');
      if (req.method === 'POST' && /^\/api\/v1\/session\/(login|verify|logout|refresh)$/.test(route)) {
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        if (options.isBusy()) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        return original(req, res);
      }
      if (route === '/api/v1/contract' && req.method === 'GET') return send(200, contract);
      if (route === '/api/v1/session' && req.method === 'GET') return send(200, {
        authenticated: cloudAuthenticated(), phase: session.state.phase,
        captcha: session.state.phase === 'captcha' ? session.state.captcha : null,
        busy: Boolean(options.isBusy() || active()), loginUrl: '/api/v1/session/login', verificationUrl: '/api/v1/session/verify', logoutUrl: '/api/v1/session/logout',
      });
      if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
      if (route === '/api/v1/live-sessions' && req.method === 'POST') {
        const data = await body(req, origin, 'liveStart');
        requireCloudSession();
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        if (options.isBusy() || pending || rangeBusy || playback.isBusy())
          throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        // LiveSessions deduplicates synchronous admissions; JobService owns the
        // HomeBase slot and rejects previously accepted queued/running history.
        const disconnected = () => { if (!res.writableEnded) live.cancelRequest(data.requestId); };
        res.once('close', disconnected);
        try { return send(201, { live: await live.start(data) }); }
        finally { res.off('close', disconnected); }
      }
      const liveMatch = /^\/api\/v1\/live-sessions\/([^/]+)(?:\/(stop|media))?$/.exec(route);
      if (liveMatch) {
        const id = decodeURIComponent(liveMatch[1]), action = liveMatch[2];
        if (req.method === 'GET' && !action) return send(200, { live: live.get(id) });
        if (req.method === 'POST' && action === 'stop') {
          await body(req, origin, 'empty'); return send(200, { live: await live.stop(id) });
        }
        if (req.method === 'GET' && action === 'media') { requireCloudSession(); live.attach(id, res); return; }
      }
      if (route === '/api/v1/playback-sessions' && req.method === 'POST') {
        const data = await body(req, origin, 'playbackStart');
        requireCloudSession();
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        if (options.isBusy() || active() || rangeBusy) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        const window = windowOf(data);
        pending++;
        try { return send(201, { playback: await playback.start({ serial: data.serial, speed: data.speed,
          begin: Date.parse(window.normalized.start) / 1000, end: Date.parse(window.normalized.end) / 1000 }) }); }
        finally { release(); }
      }
      const playbackMatch = /^\/api\/v1\/playback-sessions\/([^/]+)(?:\/(pause|resume|close))?$/.exec(route);
      if (playbackMatch) {
        const id = decodeURIComponent(playbackMatch[1]), action = playbackMatch[2];
        if (req.method === 'GET' && !action) return send(200, { playback: playback.get(id) });
        if (req.method === 'POST' && action) {
          await body(req, origin, 'empty');
          if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
          if (options.isBusy()) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
          pending++;
          try { return send(200, { playback: await playback[action](id) }); } finally { release(); }
        }
      }
      const match = /^\/api\/v1\/devices(?:\/([^/]+)(?:\/(recording-ranges)|\/capabilities\/([^/]+))?)?$/.exec(route);
      if (match && ((req.method === 'GET' && !match[2]) || (req.method === 'POST' && match[2]))) {
        requireCloudSession();
        if (options.isBusy() || (match[2] && (active() || rangeBusy))) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        const data = match[2] ? await body(req, origin, 'window') : null;
        requireCloudSession();
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        // Recheck after reading an asynchronously delivered request body.
        if (options.isBusy() || (match[2] && (active() || rangeBusy))) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        pending++;
        if (match[2]) rangeBusy = true;
        try {
          const { devices, discovery } = await inventory();
          if (!match[1]) return send(200, { devices, discovery });
          const device = findDevice(devices, decodeURIComponent(match[1]), discovery);
          if (match[3]) {
            const capability = decodeURIComponent(match[3]);
            return send(200, { serial: device.serial, capability, ...queryCapability(device, capability),
              verificationScope: device.verificationScope, discovery });
          }
          if (!match[2]) return send(200, { device, discovery });
          requireSupported(device);
          const window = windowOf(data);
          const begin = Date.parse(window.normalized.start) / 1000, end = Date.parse(window.normalized.end) / 1000;
          const connection = options.createRanges ? options.createRanges() : new LocalContinuousRecordings(session);
          const releaseMedia = getExporter().jobs.acquireMedia(device.homeBaseId);
          ranges.add(connection);
          try {
            const response = await connection.listRange(device.serial, begin, end);
            const available = recordingSegments(response.videos, begin, end).map(segment => ({
              start: new Date(segment.begin * 1000).toISOString(), end: new Date(segment.end * 1000).toISOString(),
            }));
            return send(200, { serial: device.serial, window, ranges: available, coverage: null,
              availability: available.length ? 'available' : 'none', code: available.length ? null : 'NO_RECORDING' });
          } catch (error) { throw fault(503, 'DEVICE_UNAVAILABLE', error.message); }
          finally { await connection.close(); ranges.delete(connection); releaseMedia(); }
        } finally { release(); if (match[2]) rangeBusy = false; }
      }
      if (route === '/api/v1/exports' && req.method === 'POST') {
        const data = await body(req, origin, 'identity');
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        const service = getExporter();
        const existing = service.jobs.list().find(job => job.requestId === data.requestId);
        if (existing) return send(200, { job: view(existing), reused: true });
        requireCloudSession();
        validateRequest('export', data);
        if (options.isBusy() || rangeBusy || playback.isBusy() || live.isBusy()) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        pending++;
        try {
          const { devices, discovery } = await inventory();
          // Another HTTP request can submit this identity while inventory is in flight.
          const reused = service.jobs.list().find(job => job.requestId === data.requestId);
          if (reused) return send(200, { job: view(reused), reused: true });
          const device = findDevice(devices, data.serial, discovery);
          requireSupported(device);
          windowOf(data); // Shared contract supplies stable validation errors before durable submission.
          let job;
          try { job = service.submit({ ...data, homeBaseId: device.homeBaseId }); }
          catch (error) { throw fault(409, 'JOB_UNAVAILABLE', error.message); }
          return send(202, { job: view(job), reused: false });
        } finally { release(); }
      }
      const control = /^\/api\/v1\/jobs\/([^/]+)\/(cancel|retry)$/.exec(route);
      if (control && req.method === 'POST') {
        const data = await body(req, origin, control[2] === 'cancel' ? 'empty' : 'retry');
        if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
        const service = getExporter(), previous = service.get(control[1]);
        if (!previous) throw fault(404, 'JOB_NOT_FOUND', 'Unknown job.');
        if (control[2] === 'cancel') {
          let job;
          try { job = service.cancel(previous.jobId); }
          catch (error) { throw fault(409, 'JOB_UNAVAILABLE', error.message); }
          return send(job.state === 'running' ? 202 : 200, { job: view(job) });
        }
        const existing = service.jobs.list().find(job => job.requestId === data.requestId);
        if (existing) return send(200, { job: view(existing), reused: true });
        requireCloudSession();
        if (options.isBusy() || rangeBusy || playback.isBusy() || live.isBusy()) throw fault(409, 'SERVICE_BUSY', 'A recording or login operation is active.');
        pending++;
        try {
          const { devices, discovery } = await inventory();
          if (stopping) throw fault(503, 'SERVICE_STOPPING', 'The resident service is shutting down.');
          const reused = service.jobs.list().find(job => job.requestId === data.requestId);
          if (reused) return send(200, { job: view(reused), reused: true });
          const device = findDevice(devices, previous.input.serial, discovery); requireSupported(device);
          if (device.homeBaseId !== previous.homeBaseId)
            throw fault(409, 'JOB_UNAVAILABLE', 'The camera HomeBase changed. Submit a new export after checking its device identity.');
          let job;
          try { job = service.retry(previous.jobId, data); }
          catch (error) { throw fault(409, 'JOB_UNAVAILABLE', error.message); }
          return send(202, { job: view(job), reused: false });
        } finally { release(); }
      }
      const jobMatch = /^\/api\/v1\/jobs\/([^/]+)(?:\/(artifacts)(?:\/([^/]+))?)?$/.exec(route);
      if (jobMatch && ['GET', 'HEAD'].includes(req.method)) {
        const job = getExporter().get(jobMatch[1]);
        if (!job) throw fault(404, 'JOB_NOT_FOUND', 'Unknown job.');
        if (!jobMatch[2] && req.method === 'GET') return send(200, { job: view(job) });
        if (!jobMatch[3] && req.method === 'GET') return send(200, { jobId: job.jobId, artifacts: artifactList(job) });
        const artifact = artifactList(job).find(item => item.id === jobMatch[3]);
        if (!artifact) throw fault(404, 'ARTIFACT_NOT_FOUND', 'Unknown artifact for this job.');
        const file = path.join(path.dirname(job.metadataPath), artifact.path);
        if (!fs.existsSync(file)) throw fault(404, 'ARTIFACT_NOT_FOUND', 'The registered artifact is unavailable.');
        if (artifact.playable) return serveMedia(req, res, file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file);
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      throw fault(404, 'NOT_FOUND', 'Unknown v1 endpoint.');
    } catch (error) {
      if (!res.headersSent) send(error.status || 500, { error: { code: error.status ? error.code : 'INTERNAL_ERROR', message: error.message },
        ...(error.discovery ? { discovery: error.discovery } : {}) });
      else res.destroy();
    }
  });
  async function inventory() {
    requireCloudSession();
    const data = await readDeviceInventory(session.api);
    requireCloudSession();
    if (data.error) throw Object.assign(fault(503, 'DEVICE_UNAVAILABLE', data.error.message), { discovery: data.discovery });
    try {
      const observations = deviceRepository.read();
      return { devices: describeDevices(data.devices, observations), discovery: data.discovery };
    } catch (error) {
      throw Object.assign(fault(503, 'CAPABILITY_RECORDS_UNAVAILABLE', `Device verification records are unavailable: ${error.message}`),
        { discovery: failedDiscovery(data.discovery, 'capability_records_unavailable') });
    }
  }
  return {
    isBusy: active,
    loggedOut: async () => { await live.closeActive(); await playback.closeActive(); exporter?.requireLogin(); },
    async shutdown() {
      stopping = true;
      await live.shutdown();
      // Admissions already in flight settle before we stop the resident worker.
      if (pending) await new Promise(resolve => drained.push(resolve));
      await playback.shutdown();
      for (const connection of ranges) connection.close();
      await exporter?.shutdown();
    },
  };
}
function findDevice(devices, serial, discovery) {
  const device = devices.find(item => item.serial === serial);
  if (!device) throw Object.assign(fault(404, 'DEVICE_NOT_FOUND', 'Device was not present in the retrieved inventory.'), { discovery });
  return device;
}
function requireSupported(device) {
  if (!device.recordingExport.supported) throw fault(422, 'UNSUPPORTED_DEVICE', 'Continuous export requires the supported T8600 camera and T8030 HomeBase path.');
  if (device.availability === 'unavailable') throw fault(503, 'DEVICE_UNAVAILABLE', 'The HomeBase has no LAN address.');
}
async function body(req, origin, schema) {
  if (req.headers.origin && req.headers.origin !== origin) throw fault(403, 'LOCAL_ORIGIN_REQUIRED', 'Use the local service origin.');
  if (!req.headers['content-type']?.startsWith('application/json')) throw fault(415, 'JSON_REQUIRED', 'Use application/json.');
  let source = '';
  for await (const chunk of req) { source += chunk; if (source.length > 16384) throw fault(413, 'INPUT_TOO_LONG', 'Request body is too long.'); }
  let data;
  try { data = JSON.parse(source); } catch { throw fault(400, 'INVALID_REQUEST', 'Invalid JSON.'); }
  validateRequest(schema, data);
  return data;
}

module.exports = { installV1Routes, jobView };
