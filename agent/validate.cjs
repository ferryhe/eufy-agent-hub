#!/usr/bin/env node
// Explicit, bounded acceptance runner. Default is synthetic resident + real model.
// Hardware mode never starts a service or signs in; root/user owns that separate step.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { RecordingTools } = require('./tools.cjs');
const { createRecordingAgent } = require('./runtime.cjs');

const authorized = { device: 'Drive Way', day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'America/Toronto' };
function hardwareFetch(baseUrl, serial) {
  const ids = new Set();
  return async (url, options = {}) => {
    url = new URL(url);
    if (url.origin !== baseUrl) throw new Error('Outside authorized resident origin');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      const rangeRoute = `/api/v1/devices/${encodeURIComponent(serial)}/recording-ranges`;
      if (![rangeRoute, '/api/v1/exports'].includes(url.pathname)) throw new Error('Outside authorized recording operations');
      for (const key of ['day', 'start', 'end', 'timezone']) if (body[key] !== authorized[key]) throw new Error('Outside authorized recording window');
      if (body.endDay && body.endDay !== authorized.day) throw new Error('Outside authorized recording date');
      if (url.pathname === '/api/v1/exports') {
        if (body.serial !== serial) throw new Error('Outside authorized device');
        ids.add(body.requestId);
        if (ids.size > 1) throw new Error('Only one hardware export identity is authorized');
      }
    }
    return fetch(url, options);
  };
}
async function validate(args = process.argv.slice(2)) {
  const hardware = args.includes('--hardware');
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  if (args.includes('--help')) {
    console.log('Synthetic: node agent/validate.cjs --evidence-dir ABSOLUTE_DIRECTORY\nHardware (only after independent review and coordinated login): node agent/validate.cjs --hardware --url http://127.0.0.1:3190 --evidence-dir ABSOLUTE_DIRECTORY\nHardware is restricted to Drive Way T8600/T8030, 2026-08-27 16:30–16:50 America/Toronto, one export identity.');
    return;
  }
  const evidenceDir = value('--evidence-dir');
  if (!evidenceDir || !path.isAbsolute(evidenceDir)) throw new Error('Provide an absolute private evidence directory.');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const model = process.env.EUFY_AGENT_MODEL || 'gpt-4.1-mini';
  const summary = { mode: hardware ? 'hardware' : 'synthetic-http', model, sdk: '0.18.0', modelGate: 'not-run', hardwareGate: hardware ? 'pending' : 'not-run',
    modelRequest: { api: 'responses', maxTurns: 8, maxOutputTokens: 1000, store: false, tracing: false, transportRetries: 0 } };
  let fixture;
  let client;
  try {
    let baseUrl = value('--url');
    let input;
    if (hardware) {
      if (!baseUrl || new URL(baseUrl).port === '3187') throw new Error('Hardware requires an explicit independent resident origin; 3187 is excluded.');
      baseUrl = new URL(baseUrl).origin;
      client = new RecordingTools({ baseUrl, statePath: path.join(evidenceDir, 'private-agent-state.json'), timeoutMs: 30000 });
      const session = await client.session();
      if (!session.authenticated) { summary.hardwareGate = 'login-required'; return summary; }
      const resolved = await client.resolve(authorized.device);
      if (resolved.error || resolved.device.model !== 'T8600' || resolved.device.verificationScope.homeBase?.model !== 'T8030')
        throw new Error('Authorized device was not uniquely resolved to T8600/T8030.');
      client.fetch = hardwareFetch(baseUrl, resolved.device.serial);
      input = authorized;
    } else {
      const fixtures = require('./fixture.cjs');
      fixture = await fixtures.fixture({ partial: true });
      baseUrl = fixture.url;
      input = fixtures.window;
      client = new RecordingTools({ baseUrl });
    }
    const runtime = createRecordingAgent({ client, model, maxTurns: 8, maxTokens: 1000, runTimeoutMs: 120000 });
    summary.modelGate = 'pending';
    await runtime.turn(`请导出设备“${input.device}”在 ${input.day} ${input.start} 到 ${input.end} 的连续录像，时区 ${input.timezone}。提交后告诉我任务编号和当前状态。`);
    summary.modelGate = 'passed';
    const exports = client.events.filter(e => e.name === 'recording_export' && e.output.job);
    if (!exports.length) {
      const codes = client.events.map(e => e.output.error?.code).filter(Boolean);
      summary.codes = [...new Set(codes)];
      summary.hardwareGate = hardware && codes.includes('NO_RECORDING') ? 'window-not-retained' : summary.hardwareGate;
      summary.workflow = 'no-export';
      return summary;
    }
    const ids = new Set(exports.map(e => e.output.job.jobId));
    if (ids.size !== 1) throw new Error('More than one export job');
    summary.uniqueJobCount = ids.size;
    const jobId = exports[0].output.job.jobId;
    const result = await client.wait({ jobId, timeoutMs: hardware ? 2400000 : 5000, pollMs: hardware ? 5000 : 10 });
    if (result.lastResult) { summary.workflow = 'observer-timeout'; return summary; }
    await runtime.turn(`请用 job_artifacts 查询任务 ${jobId} 的最终状态、覆盖和校验结果，给出真实视频链接；若部分录像必须明确说明 partial。`);
    const final = await client.artifacts({ jobId });
    if (!client.events.some(e => e.name === 'job_artifacts' && e.input.jobId === jobId)) throw new Error('Model did not query final artifacts');
    summary.workflow = 'model-tools-v1-job-artifact';
    summary.status = final.status;
    summary.complete = final.complete;
    summary.coverageVerified = final.job.result?.coverageVerified ?? false;
    summary.validationPassed = final.validation?.passed ?? false;
    summary.videoCount = final.videos.length;
    summary.toolCalls = client.events.map(e => e.name);
    if (hardware) {
      summary.hardwareGate = final.videos.length ? 'artifact-produced' : 'no-playable-artifact';
      fs.writeFileSync(path.join(evidenceDir, 'private-result.json'), JSON.stringify(final, null, 2));
      if (final.videos.length) {
        const url = new URL(final.videos[0].url, baseUrl);
        if (url.origin !== baseUrl || !url.pathname.startsWith(`/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/`)) throw new Error('Artifact is outside the registered job route');
        const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error('Registered artifact download failed');
        const hash = createHash('sha256'); let bytes = 0;
        const stream = Readable.fromWeb(response.body);
        stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
        await pipeline(stream, fs.createWriteStream(path.join(evidenceDir, 'private-video.mp4')));
        summary.artifact = { bytes, sha256: hash.digest('hex') };
      }
    } else {
      summary.syntheticCaptureCount = fixture.calls.capture;
      summary.mediaValidation = 'synthetic-adapter-fixture-only';
      if (final.status !== 'partial' || fixture.calls.capture !== 1 || !final.videos.length) throw new Error('Synthetic partial fixture acceptance failed');
    }
    return summary;
  } catch (error) {
    summary.error = { code: error.code ?? error.name, status: error.status ?? null, requestId: error.request_id ?? null };
    if (summary.modelGate === 'pending') summary.modelGate = 'failed';
    process.exitCode = 1;
    return summary;
  } finally {
    if (hardware && client) fs.writeFileSync(path.join(evidenceDir, 'private-tools.json'), JSON.stringify(client.events, null, 2));
    if (fixture) await fixture.close();
    fs.writeFileSync(path.join(evidenceDir, 'summary.json'), JSON.stringify(summary, null, 2));
  }
}
if (require.main === module) validate().then(result => { if (result) console.log(JSON.stringify(result, null, 2)); }).catch(() => {
  console.error('Validation configuration failed; use --help.'); process.exitCode = 1;
});
module.exports = { validate, hardwareFetch };
