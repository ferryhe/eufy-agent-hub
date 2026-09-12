const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const Ajv = require('ajv');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, extra = {}) => ({ error: { code, message }, ...extra });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = job => ['succeeded', 'failed', 'cancelled'].includes(job.state);

function describeJob(job, artifacts = job.artifacts) {
  const result = job.result;
  const complete = job.state === 'succeeded' && result?.outcome === 'complete'
    && result.coverageVerified === true && result.validation?.passed === true;
  const status = complete ? 'complete' : result?.outcome === 'partial' ? 'partial'
    : terminal(job) ? (job.state === 'cancelled' ? 'cancelled' : 'failed') : job.state;
  return { job, status, complete, videos: artifacts.filter(a => a.playable && a.validated),
    coverage: result?.coverage ?? null, validation: result?.validation ?? null,
    diagnostics: result?.diagnostics ?? [], error: job.error };
}

class RecordingTools {
  constructor({ baseUrl = process.env.EUFY_URL || 'http://127.0.0.1:3187', statePath,
    timeoutMs = 10000, fetchImpl = fetch } = {}) {
    this.baseUrl = new URL(baseUrl).origin;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.statePath = statePath;
    this.state = { version: 1, origin: this.baseUrl, receipts: {}, requests: {}, history: [] };
    if (statePath && fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (this.state.version !== 1 || this.state.origin !== this.baseUrl)
        throw new Error('Agent state belongs to a different service or version.');
    }
    this.pending = new Map();
    this.events = [];
    this.contractPromise = null;
  }
  save() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { flush: true });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(tmp, this.statePath); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }
  async request(method, route, body, definition) {
    try {
      if (!this.contractPromise) this.contractPromise = (async () => {
        const response = await this.fetch(new URL('/api/v1/contract', this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) throw new Error('Contract unavailable');
        const contract = await response.json();
        const ajv = new Ajv({ strict: false });
        ajv.addSchema(contract);
        return { ajv, id: contract.$id };
      })().catch(error => { this.contractPromise = null; throw error; });
      const { ajv, id } = await this.contractPromise;
      const response = await this.fetch(new URL(route, this.baseUrl), {
        method, headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs),
      });
      const value = await response.json();
      const validate = ajv.getSchema(`${id}#/definitions/${response.ok ? definition : 'error'}`);
      if (!validate || !validate(value)) return fail('INVALID_RESPONSE', 'Resident response does not match API v1.');
      if (value.error?.code === 'UNAUTHENTICATED') return { ...value, loginPage: `${this.baseUrl}/` };
      return value;
    } catch (error) {
      return fail('SERVICE_UNAVAILABLE', 'Resident request failed or timed out. Existing submissions keep their identity.');
    }
  }
  async session() {
    const value = await this.request('GET', '/api/v1/session', null, 'session');
    if (value.error) return value;
    // Challenges and credentials stay on the resident's normal login page.
    return { authenticated: value.authenticated, phase: value.phase, busy: value.busy,
      loginPage: `${this.baseUrl}/` };
  }
  async devices() { return this.request('GET', '/api/v1/devices', null, 'devices'); }
  async resolve(device) {
    if (typeof device !== 'string' || !device.trim()) return fail('CLARIFICATION_REQUIRED', 'Specify a device name or serial.');
    if (this.state.userInputs && !this.userSelected(device))
      return fail('CLARIFICATION_REQUIRED', 'Use the exact device name the user supplied, or ask the user to select a serial.');
    const value = await this.devices();
    if (value.error) return value;
    const matches = value.devices.filter(d => d.serial === device.trim() || d.name.toLowerCase() === device.trim().toLowerCase());
    if (!matches.length) return fail('DEVICE_NOT_FOUND', 'No exact device match. Ask the user for a listed device.', { devices: value.devices });
    if (matches.length !== 1) return fail('AMBIGUOUS_DEVICE', 'More than one device matches. Ask the user to select its serial.', { devices: matches });
    // A uniquely resolved user name also selects the service ID returned to later tools.
    // Listing candidates or an ambiguous/unknown lookup never establishes this mapping.
    if (this.state.userInputs && this.userNamed(device)) {
      (this.state.resolvedDevices ??= {})[matches[0].serial] = device.trim();
      this.save();
    }
    return { device: matches[0] };
  }
  userSelected(device) {
    const source = this.state.resolvedDevices?.[device.trim()];
    return this.userNamed(device) || (typeof source === 'string' && this.userNamed(source));
  }
  userNamed(device) {
    const escaped = device.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, 'iu');
    return this.state.userInputs.some(text => match.test(text));
  }
  async capability({ device, capability }) {
    const resolved = await this.resolve(device);
    if (resolved.error) return resolved;
    return this.request('GET', `/api/v1/devices/${encodeURIComponent(resolved.device.serial)}/capabilities/${encodeURIComponent(capability)}`, null, 'capabilityResponse');
  }
  async ranges({ device, day, start, end, timezone, endDay }) {
    if (![device, day, start, end].every(v => typeof v === 'string' && v.trim()))
      return fail('CLARIFICATION_REQUIRED', 'Specify device, calendar date, start and end. Do not guess missing or ambiguous details.');
    if (this.state.userInputs && !this.userSelected(device))
      return fail('CLARIFICATION_REQUIRED', 'The user must name or select this device before range lookup.');
    const input = { day, start, end };
    if (timezone) input.timezone = timezone;
    if (endDay) input.endDay = endDay;
    // Reuse acknowledged work even after logout, without reinterpreting its dates.
    const previous = Object.values(this.state.receipts).find(r =>
      (r.device.serial === device || r.device.name.toLowerCase() === device.trim().toLowerCase())
      && JSON.stringify(r.input) === JSON.stringify(input) && this.state.requests[r.id]);
    if (previous) return copy(previous);
    const resolved = await this.resolve(device);
    if (resolved.error) return resolved;
    if (!resolved.device.recordingExport.supported)
      return fail('UNSUPPORTED_DEVICE', 'This device is not eligible for recording export.', resolved);
    const value = await this.request('POST', `/api/v1/devices/${encodeURIComponent(resolved.device.serial)}/recording-ranges`, input, 'ranges');
    if (value.error) return value;
    if (value.serial !== resolved.device.serial) return fail('INVALID_RESPONSE', 'Range response identifies a different device.');
    if (value.availability === 'none' || !value.ranges.length)
      return fail('NO_RECORDING', 'The service found no recording in this window.', value);
    const id = fingerprint([value.serial, value.window.normalized.start, value.window.normalized.end]);
    const receipt = { id, device: resolved.device, input, ...value };
    this.state.receipts[id] = receipt;
    this.save();
    return copy(receipt);
  }
  async submit({ receiptId }) {
    const receipt = this.state.receipts[receiptId];
    if (!receipt) return fail('NORMALIZATION_REQUIRED', 'First obtain a recording_ranges receipt from this session.');
    if (this.pending.has(receiptId)) return this.pending.get(receiptId);
    const operation = this.submitReceipt(receipt).then(result => {
      // Accepted work stays discoverable even if the next model request fails.
      if (result.job && this.state.presentation) {
        const item = { type: 'job-card', jobId: result.job.jobId };
        if (!this.state.presentation.views.some(v => v.type === item.type && v.jobId === item.jobId)) this.state.presentation.views.push(item);
        this.save();
      }
      return result;
    });
    this.pending.set(receiptId, operation);
    try { return await operation; } finally { this.pending.delete(receiptId); }
  }
  async submitReceipt(receipt) {
    let entry = this.state.requests[receipt.id];
    if (!entry) {
      entry = { requestId: `agent-${randomUUID()}`, body: { serial: receipt.serial, ...receipt.input } };
      this.state.requests[receipt.id] = entry;
    }
    this.save(); // Persist even after an earlier write failure, BEFORE any HTTP side effect.
    if (entry.jobId) return this.job({ jobId: entry.jobId });
    const value = await this.request('POST', '/api/v1/exports', { requestId: entry.requestId, ...entry.body }, 'submission');
    if (value.error) return { ...value, requestId: entry.requestId, receiptId: receipt.id };
    entry.jobId = value.job.jobId;
    this.save();
    return { ...this.view(value.job), reused: value.reused, receiptId: receipt.id };
  }
  view(job, artifacts) {
    const result = describeJob(job, artifacts);
    result.videos = result.videos.map(artifact => ({ ...artifact, url: new URL(artifact.url, this.baseUrl).href }));
    return result;
  }
  async job({ jobId }) {
    const value = await this.request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`, null, 'jobResponse');
    return value.error ? value : this.view(value.job);
  }
  async artifacts({ jobId }) {
    const [job, value] = await Promise.all([this.job({ jobId }),
      this.request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts`, null, 'artifacts')]);
    if (job.error && !job.job) return job;
    if (value.error) return value;
    return { ...this.view(job.job, value.artifacts), artifacts: value.artifacts };
  }
  async wait({ jobId, timeoutMs = 30000, pollMs = 1000, signal, onProgress } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000 || !Number.isFinite(pollMs) || pollMs < 10)
      throw new Error('Wait must be bounded to 0–3600000 ms with pollMs >= 10.');
    const until = Date.now() + timeoutMs;
    let latest;
    do {
      if (signal?.aborted) return fail('OBSERVER_STOPPED', 'Observer stopped; resident job is not cancelled.', { lastResult: latest });
      latest = await this.job({ jobId });
      onProgress?.(latest);
      if (!latest.job || terminal(latest.job)) return latest;
      if (Date.now() >= until) break;
      try { await delay(Math.min(pollMs, Math.max(1, until - Date.now())), null, { signal }); } catch { /* observer only */ }
    } while (Date.now() <= until);
    return fail('WAIT_TIMEOUT', 'Observation timed out; use job_get later. Resident work continues.', { lastResult: latest });
  }
}
module.exports = { RecordingTools, describeJob };
