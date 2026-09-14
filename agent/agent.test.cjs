const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { ScriptedModel, functionCall, assistantMessage, modelResponder } = require('@openai/agents/testing');
const { RecordingTools, describeJob } = require('./tools.cjs');
const { createRecordingAgent } = require('./runtime.cjs');
const { fixture, window } = require('./fixture.cjs');
const { hardwareFetch } = require('./validate.cjs');
async function setup(t, options) {
  const f = await fixture(options); t.after(() => f.close());
  return { f, client: new RecordingTools({ baseUrl: f.url, statePath: path.join(f.directory, 'agent.json') }) };
}
const call = (name, args, id = name) => [functionCall(name, args, { callId: id })];
const lastOutput = request => {
  const item = request.input.filter(i => i.type === 'function_call_result').at(-1);
  const output = typeof item.output === 'string' ? item.output : item.output.text;
  return JSON.parse(output);
};

test('service resolves exact device, retains normalization and separates eligible export from unknown Live evidence', async t => {
  const { client } = await setup(t);
  client.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (url.pathname === '/api/v1/devices' && response.ok) {
      const value = await response.json();
      for (const device of value.devices) device.capabilities.liveVideo = { status: 'unknown', reason: 'no_evidence', evidence: [] };
      return Response.json(value);
    }
    return response;
  };
  const resolved = await client.resolve(window.device);
  assert.equal(resolved.device.serial, 'camera'); assert.equal(resolved.device.recordingExport.supported, true);
  assert.equal(resolved.device.capabilities.liveVideo.status, 'unknown');
  const receipt = await client.ranges(window);
  assert.equal(receipt.serial, 'camera');
  assert.equal(receipt.window.normalized.start, '2026-08-27T20:30:00.000Z');
  assert.equal(receipt.window.input.timezone, 'America/Toronto');
  const defaultZone = await client.ranges({ ...window, timezone: null });
  assert.equal(defaultZone.window.input.timezone, null);
  assert.equal(defaultZone.window.normalized.timezone, 'America/Toronto');
  assert.equal((await client.capability({ device: 'camera', capability: 'rtsp' })).status, 'unknown');
});
test('unknown and repeated names cannot obtain export receipts; missing details require clarification', async t => {
  const { f, client } = await setup(t, { devices: [{ device_sn: 'a', device_name: 'Repeated' }, { device_sn: 'b', device_name: 'Repeated' }] });
  assert.equal((await client.ranges(window)).error.code, 'DEVICE_NOT_FOUND');
  assert.equal((await client.ranges({ ...window, device: 'Repeated' })).error.code, 'AMBIGUOUS_DEVICE');
  assert.equal((await client.ranges({ ...window, start: '' })).error.code, 'CLARIFICATION_REQUIRED');
  assert.equal((await client.submit({ receiptId: 'invented' })).error.code, 'NORMALIZATION_REQUIRED');
  assert.equal(f.calls.capture, 0); assert.equal(f.calls.ranges, 0);
  assert.equal((await client.ranges({ ...window, device: 'a' })).serial, 'a');
});
test('all calendar, DST, timezone and cross-midnight errors come unchanged from resident', async t => {
  const { client } = await setup(t);
  for (const [input, code] of [
    [{ day: '2026-11-01', start: '01:15', end: '01:45' }, 'AMBIGUOUS_OR_NONEXISTENT_TIME'],
    [{ day: '2026-03-08', start: '02:15', end: '03:15' }, 'AMBIGUOUS_OR_NONEXISTENT_TIME'],
    [{ timezone: 'Invalid/Zone' }, 'INVALID_TIMEZONE'], [{ endDay: '2026-08-28' }, 'INVALID_WINDOW'],
    [{ start: '23:30', end: '00:30' }, 'INVALID_WINDOW'], [{ day: '2026-02-30' }, 'INVALID_WINDOW'],
  ]) assert.equal((await client.ranges({ ...window, ...input })).error.code, code);
});
for (const [options, code] of [[{ empty: true }, 'NO_RECORDING'], [{ offline: true }, 'DEVICE_UNAVAILABLE'],
  [{ devices: [{ device_sn: 'camera', device_name: window.device, device_model: 'T0000', device_type: 0 }] }, 'UNSUPPORTED_DEVICE']]) {
  test(`range failure ${code} never submits`, async t => {
    const { f, client } = await setup(t, options);
    assert.equal((await client.ranges(window)).error.code, code); assert.equal(f.calls.capture, 0);
  });
}
test('normal login page excludes challenge material, while jobs/artifacts and request reuse survive logout', async t => {
  const { f, client } = await setup(t);
  const receipt = await client.ranges(window);
  const submitted = await client.submit({ receiptId: receipt.id });
  await client.wait({ jobId: submitted.job.jobId, timeoutMs: 3000, pollMs: 10 });
  f.expire();
  const session = await client.session(); assert.equal(session.authenticated, false); assert.equal(session.captcha, undefined);
  assert.equal(session.loginPage, `${f.url}/`);
  assert.equal((await client.devices()).error.code, 'UNAUTHENTICATED');
  assert.equal((await client.submit({ receiptId: receipt.id })).job.jobId, submitted.job.jobId);
  assert.ok((await client.artifacts({ jobId: submitted.job.jobId })).videos.length);
});
test('lost response persists one request before side effects and recovers after process reconstruction', async t => {
  const { f, client } = await setup(t);
  const receipt = await client.ranges(window);
  let lose = true;
  const ids = [];
  client.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (url.pathname === '/api/v1/exports') {
      ids.push(JSON.parse(options.body).requestId);
      if (lose) { lose = false; throw new Error('Response lost after submit'); }
    }
    return response;
  };
  const lost = await client.submit({ receiptId: receipt.id }); assert.equal(lost.error.code, 'SERVICE_UNAVAILABLE');
  const resumed = new RecordingTools({ baseUrl: f.url, statePath: client.statePath, fetchImpl: client.fetch });
  const results = await Promise.all([resumed.submit({ receiptId: receipt.id }), resumed.submit({ receiptId: receipt.id })]);
  assert.equal(results[0].job.jobId, results[1].job.jobId); assert.equal(new Set(ids).size, 1);
  assert.equal(results[0].job.requestId, lost.requestId);
  await resumed.wait({ jobId: results[0].job.jobId, timeoutMs: 3000, pollMs: 10 });
  assert.equal(f.calls.capture, 1);
});
for (const [options, status] of [[{}, 'complete'], [{ partial: true }, 'partial'], [{ failed: true }, 'failed']]) {
  test(`authoritative ${status} and registered artifacts retain coverage and decode semantics`, async t => {
    const { client } = await setup(t, options);
    const receipt = await client.ranges(window), submitted = await client.submit({ receiptId: receipt.id });
    const result = await client.wait({ jobId: submitted.job.jobId, timeoutMs: 3000, pollMs: 10 });
    assert.equal(result.status, status); assert.equal(result.complete, status === 'complete');
    const artifacts = await client.artifacts({ jobId: submitted.job.jobId });
    for (const video of artifacts.videos) assert.equal(video.outcome, status);
    if (status === 'partial') assert.ok(artifacts.videos.length);
    if (status === 'complete') {
      assert.equal(result.validation.passed, true); assert.equal(result.job.result.coverageVerified, true);
      assert.equal(describeJob({ ...result.job, result: { ...result.job.result, coverageVerified: false } }).complete, false);
      assert.equal(describeJob({ ...result.job, result: { ...result.job.result, validation: { passed: false } } }).complete, false);
    }
  });
}
test('bounded observer exits without cancelling owned capture; later read obtains completion', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { f, client } = await setup(t, { gate });
  try {
    const receipt = await client.ranges(window), submitted = await client.submit({ receiptId: receipt.id });
    const observed = await client.wait({ jobId: submitted.job.jobId, timeoutMs: 20, pollMs: 10 });
    assert.equal(observed.error.code, 'WAIT_TIMEOUT'); assert.equal(observed.lastResult.job.state, 'running');
    const stop = new AbortController(); stop.abort();
    assert.equal((await client.wait({ jobId: submitted.job.jobId, signal: stop.signal })).error.code, 'OBSERVER_STOPPED');
    release();
    assert.equal((await client.wait({ jobId: submitted.job.jobId, timeoutMs: 3000, pollMs: 10 })).status, 'complete');
    assert.equal(f.calls.capture, 1);
  } finally { release(); }
});
test('actual SDK Runner executes HTTP tools and reuses receipt/job across user turns', async t => {
  const { f, client } = await setup(t);
  let receiptId, jobId;
  const model = new ScriptedModel([
    call('recording_ranges', window),
    modelResponder(({ request }) => { receiptId = lastOutput(request).id; return call('recording_export', { receiptId }); }),
    modelResponder(({ request }) => { jobId = lastOutput(request).job.jobId; return [assistantMessage('已提交。')]; }),
    call('recording_ranges', window, 'again-ranges'),
    modelResponder(({ request }) => { assert.equal(lastOutput(request).id, receiptId); return call('recording_export', { receiptId }, 'again-export'); }),
    modelResponder(({ request }) => { assert.equal(lastOutput(request).job.jobId, jobId); return [assistantMessage('同一任务。')]; }),
  ]);
  const runtime = createRecordingAgent({ client, model });
  await runtime.turn('导出 Synthetic camera 在 2026-08-27 的 16:30–16:31，America/Toronto。');
  await runtime.turn('请再给我刚才这段录像。');
  await client.wait({ jobId, timeoutMs: 3000, pollMs: 10 });
  assert.equal(f.calls.capture, 1); model.assertComplete();
  assert.equal(model.firstCall.request.modelSettings.maxTokens, 1200);
  assert.equal(model.firstCall.request.handoffs.length, 0);
  assert.ok(model.calls[3].request.input.length > model.firstCall.request.input.length);
  assert.equal(model.firstCall.request.tools.some(t => /password|verify|cancel|retry/.test(t.name)), false);
});
test('SDK max-turn boundary cannot create an unacknowledged export', async t => {
  const { f, client } = await setup(t);
  const model = new ScriptedModel([call('recording_export', { receiptId: 'invented' })]);
  const runtime = createRecordingAgent({ client, model, maxTurns: 1 });
  await assert.rejects(runtime.turn('export'), /turn/i);
  assert.equal(client.events[0].output.error.code, 'NORMALIZATION_REQUIRED'); assert.equal(f.calls.capture, 0);
});
test('state persistence tolerates the observed temporary Windows sharing denial before submission', async t => {
  const { client } = await setup(t);
  const receipt = await client.ranges(window);
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (source, destination) => {
    if (destination === client.statePath && ++attempts === 1 && process.platform === 'win32')
      throw Object.assign(new Error('temporary sharing denial'), { code: 'EPERM' });
    return rename(source, destination);
  };
  try { assert.ok((await client.submit({ receiptId: receipt.id })).job.jobId); }
  finally { fs.renameSync = rename; }
});
test('SDK cannot select an ambiguous candidate serial without the caller naming it', async t => {
  const { f, client } = await setup(t, { devices: [{ device_sn: 'camera-a', device_name: 'Repeated' }, { device_sn: 'camera-b', device_name: 'Repeated' }] });
  const model = new ScriptedModel([
    call('recording_ranges', { ...window, device: 'Repeated' }),
    modelResponder(({ request }) => { assert.equal(lastOutput(request).error.code, 'AMBIGUOUS_DEVICE'); return call('recording_ranges', { ...window, device: 'camera-a' }, 'guess'); }),
    modelResponder(({ request }) => { assert.equal(lastOutput(request).error.code, 'CLARIFICATION_REQUIRED'); return [assistantMessage('请选择设备序列号。')]; }),
    call('recording_ranges', { ...window, device: 'camera-a' }, 'selected'),
    modelResponder(({ request }) => { assert.equal(lastOutput(request).serial, 'camera-a'); return [assistantMessage('已选择。')]; }),
  ]);
  const runtime = createRecordingAgent({ client, model });
  await runtime.turn('导出 Repeated 在 2026-08-27 16:30–16:31 America/Toronto 的录像。');
  assert.equal(f.calls.ranges, 0);
  await runtime.turn('我选择 camera-a。');
  assert.equal(f.calls.ranges, 1); assert.equal(f.calls.capture, 0); model.assertComplete();
});
test('Chinese prose can name a device without adding spaces around its name', async t => {
  const { client } = await setup(t);
  client.state.userInputs = ['请导出Synthetic camera在2026-08-27的录像。'];
  assert.equal((await client.ranges(window)).serial, 'camera');
});
test('returned video links are usable absolute registered resident URLs', async t => {
  const { client } = await setup(t);
  const receipt = await client.ranges(window), submitted = await client.submit({ receiptId: receipt.id });
  await client.wait({ jobId: submitted.job.jobId, timeoutMs: 3000, pollMs: 10 });
  const result = await client.artifacts({ jobId: submitted.job.jobId });
  assert.ok(result.videos[0].url.startsWith(client.baseUrl + '/api/v1/jobs/'));
  const response = await fetch(result.videos[0].url);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic-media-bytes');
});
test('resident response validation and HTTP timeout are distinct from device-offline errors', async t => {
  const { client } = await setup(t);
  await client.session();
  client.fetch = async () => Response.json({ devices: [{ serial: 'bad-contract' }] });
  assert.equal((await client.devices()).error.code, 'INVALID_RESPONSE');
  client.timeoutMs = 20;
  client.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  assert.equal((await client.devices()).error.code, 'SERVICE_UNAVAILABLE');
});
test('challenge state returns only the normal page and never image or code fields', async t => {
  const { client } = await setup(t);
  await client.session();
  client.fetch = async () => Response.json({ authenticated: false, phase: 'captcha', busy: false, captcha: 'private-image', residentEpoch: 'fixture-resident',
    loginUrl: '/api/v1/session/login', verificationUrl: '/api/v1/session/verify', logoutUrl: '/api/v1/session/logout' });
  const result = await client.session();
  assert.equal(result.phase, 'captcha'); assert.equal(result.loginPage, client.baseUrl + '/');
  assert.equal(JSON.stringify(result).includes('private-image'), false); assert.equal(result.verificationUrl, undefined);
});
test('hardware runner deterministically fences origin, window, device and one export identity', async () => {
  const original = global.fetch;
  let sends = 0;
  global.fetch = async () => { sends++; return Response.json({ ok: true }); };
  try {
    const guarded = hardwareFetch('http://127.0.0.1:3190', 'allowed');
    const body = { requestId: 'one', serial: 'allowed', day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'America/Toronto' };
    const post = value => ({ method: 'POST', body: JSON.stringify(value) });
    await assert.rejects(guarded('http://127.0.0.1:3187/api/v1/exports', post(body)), /origin/);
    await assert.rejects(guarded('http://127.0.0.1:3190/api/v1/exports', post({ ...body, end: '16:51' })), /window/);
    await assert.rejects(guarded('http://127.0.0.1:3190/api/v1/exports', post({ ...body, serial: 'other' })), /device/);
    await guarded('http://127.0.0.1:3190/api/v1/exports', post(body));
    await guarded('http://127.0.0.1:3190/api/v1/exports', post(body));
    await assert.rejects(guarded('http://127.0.0.1:3190/api/v1/exports', post({ ...body, requestId: 'two' })), /one hardware/);
    assert.equal(sends, 2);
  } finally { global.fetch = original; }
});
test('R1: SDK carries a uniquely user-named device through its returned serial into range and export', async t => {
  const serial = 'fixture-unique-01', name = 'Front entrance';
  const { f, client } = await setup(t, { devices: [{ device_sn: serial, device_name: name }] });
  let receiptId, jobId, requestId;
  const model = new ScriptedModel([
    call('device_resolve', { device: name }),
    modelResponder(({ request }) => {
      assert.equal(lastOutput(request).device.serial, serial);
      return call('recording_ranges', { ...window, device: lastOutput(request).device.serial });
    }),
    modelResponder(({ request }) => {
      const receipt = lastOutput(request);
      assert.equal(receipt.serial, serial, 'unique name resolution must authorize its returned service ID');
      receiptId = receipt.id;
      return call('recording_export', { receiptId });
    }),
    modelResponder(({ request }) => {
      const value = lastOutput(request);
      jobId = value.job.jobId; requestId = value.job.requestId;
      return [assistantMessage('已提交。')];
    }),
    call('device_capability', { device: serial, capability: 'continuousRecordingExport' }, 'follow-up-capability'),
    modelResponder(({ request }) => {
      assert.equal(lastOutput(request).serial, serial);
      return [assistantMessage('已查询该设备的能力。')];
    }),
  ]);
  const runtime = createRecordingAgent({ client, model });
  await runtime.turn(`导出 ${name} 在 2026-08-27 16:30–16:31 America/Toronto 的录像。`);
  await runtime.turn('再看看这台设备的录像导出能力。');
  assert.equal((await client.wait({ jobId, timeoutMs: 3000, pollMs: 10 })).status, 'complete');
  assert.equal(f.calls.capture, 1); model.assertComplete();
  assert.deepEqual(client.events.slice(0, 3).map(e => e.name), ['device_resolve', 'recording_ranges', 'recording_export']);
  assert.equal(client.state.userInputs.some(input => input.includes(serial)), false);
  // Reopening the same caller state keeps the resolved ID and the original request after logout.
  const resumed = new RecordingTools({ baseUrl: f.url, statePath: client.statePath });
  f.expire();
  const receipt = await resumed.ranges({ ...window, device: serial });
  assert.equal(receipt.id, receiptId);
  const existing = await resumed.submit({ receiptId });
  assert.equal(existing.job.jobId, jobId); assert.equal(existing.job.requestId, requestId);
  assert.equal(f.calls.capture, 1);
});
test('R1: listed, unknown and ambiguous candidates do not grant a serial handoff', async t => {
  const { f, client } = await setup(t, { devices: [
    { device_sn: 'candidate-01', device_name: 'Repeated' }, { device_sn: 'candidate-02', device_name: 'Repeated' },
  ] });
  client.state.userInputs = ['查看 Repeated 和 Missing。'];
  await client.devices();
  assert.equal((await client.resolve('Missing')).error.code, 'DEVICE_NOT_FOUND');
  assert.equal((await client.resolve('Repeated')).error.code, 'AMBIGUOUS_DEVICE');
  assert.equal(Object.keys(client.state.resolvedDevices ?? {}).length, 0);
  assert.equal((await client.resolve('candidate-01')).error.code, 'CLARIFICATION_REQUIRED');
  assert.equal((await client.capability({ device: 'candidate-01', capability: 'continuousRecordingExport' })).error.code, 'CLARIFICATION_REQUIRED');
  assert.equal((await client.ranges({ ...window, device: 'candidate-01' })).error.code, 'CLARIFICATION_REQUIRED');
  assert.equal((await client.ranges({ ...window, device: '' })).error.code, 'CLARIFICATION_REQUIRED');
  assert.equal(f.calls.ranges, 0); assert.equal(f.calls.capture, 0);
  client.state.userInputs.push('我选择 candidate-02。');
  assert.equal((await client.resolve('candidate-02')).device.serial, 'candidate-02');
  assert.equal((await client.resolve('candidate-01')).error.code, 'CLARIFICATION_REQUIRED');
});
