const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { runPlaybackControlsHost, main, createDryRunRuntime } = require('./playback-controls-host.cjs');

const now = 200000;
const success = async () => ({ status: 'completed', verificationStatus: 'unverified', allowedSpeeds: null });

function remainingRuntime(peerCount = 0) {
  const runtime = createDryRunRuntime(), events = [], connections = [];
  const { DeviceType } = require('../../../adapters/eufy');
  for (let index = 0; index < peerCount; index++) runtime.inventory.devices.push({
    device_sn: `peer-${index}-private`, device_name: 'Peer', device_model: 'T8600',
    device_type: DeviceType.PROFESSIONAL_247, parent_sn: 'fake-base-private', device_channel: 8 + index,
  });
  const create = runtime.createService;
  runtime.createService = session => {
    assert.equal(session, runtime.session);
    assert.ok(connections.every(p2p => !p2p.isConnected()), 'Every previous dedicated P2P must be closed');
    const service = create(), p2p = service.station.p2pSession;
    connections.push(p2p);
    let current;
    const connect = service.connect, close = service.close, send = p2p.sendCommandWithStringPayload, stop = p2p.stopContinuousPlayback;
    service.connect = async serial => {
      current = runtime.inventory.devices.find(row => row.device_sn === serial);
      service.camera = { getSerial: () => current.device_sn, getModel: () => current.device_model,
        getName: () => current.device_name, getStationSerial: () => current.parent_sn, getChannel: () => current.device_channel };
      events.push(['connect', current.device_channel]); await connect(serial);
    };
    service.close = async () => { events.push(['close', current?.device_channel]); await close(); };
    p2p.sendCommandWithStringPayload = (command, marker) => {
      assert.equal(current.device_channel, 7, 'No peer playback/control');
      const data = JSON.parse(command.value).data;
      events.push(['start', data.play_speed]); return send(command, marker);
    };
    p2p.stopContinuousPlayback = () => { assert.equal(current.device_channel, 7, 'No peer stop'); events.push(['stop', 7]); return stop(); };
    return service;
  };
  return { runtime, events, connections };
}

test('remaining speeds dry-run runs only 4/8/16 and never promotes support or isolation', () => {
  const child = spawnSync(process.execPath, [require.resolve('./playback-controls-host.cjs'), '--dry-run', '--resume-speeds-4-8-16'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, EUFY_SESSION_PATH: 'must-not-read', ISSUE9_PROBE_EVIDENCE_PATH: 'must-not-write' } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.scope, 'speeds_4_8_16_only'); assert.equal(result.probe, undefined);
  assert.equal(result.closed, true);
  assert.deepEqual(result.speedObservations.map(row => row.requestedSpeed), [4, 8, 16]);
  assert.ok(result.speedObservations.every(row => row.status === 'completed' && row.allowedSpeeds === null && row.verificationStatus === 'unverified'));
  assert.equal(result.channelIsolation.status, 'unverified');
  assert.equal(result.peerObservation.status, 'unverified');
  assert.deepEqual(result.deviceScope, { cameraModel: 'T8600', cameraFirmware: { main: null, secondary: null },
    homeBaseModel: 'T8030', homeBaseFirmware: { main: null, secondary: null }, channel: 7 });
  assert.equal(child.stdout.includes('private'), false);
});

test('remaining speeds create fresh serial owners and exact current-window probes for 4/8/16', async () => {
  const { runtime, events, connections } = remainingRuntime();
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [['connect', 7], ['close', 7],
    ...[4, 8, 16].flatMap(speed => [['connect', 7], ['start', speed], ['stop', 7], ['close', 7]])]);
  assert.equal(new Set(connections).size, 4);
  assert.ok(connections.every(p2p => !p2p.isConnected() && p2p.streamTimeouts.streamDataWait === 5000));
  assert.deepEqual(runtime.calls.queries.map(({ begin, end }) => [begin, end]), [[now - 86400, now - 43200], [now - 43200, now],
    ...[4, 8, 16].map(() => [now - 120, now - 60])]);
  for (const observation of result.speedObservations) {
    assert.deepEqual(observation.operations.map(row => [row.operation, row.returnCode]), [['start', 0], ['stop', 0]]);
    assert.equal(observation.startup.mediaBudgetMs, 15000); assert.ok(observation.frames.length >= 2);
  }
});

test('16 dry-run runs only the fixed candidate without repeating earlier observations', () => {
  const child = spawnSync(process.execPath, [require.resolve('./playback-controls-host.cjs'), '--dry-run', '--resume-speed-16'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, EUFY_SESSION_PATH: 'must-not-read', ISSUE9_PROBE_EVIDENCE_PATH: 'must-not-write' } });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.scope, 'speed_16_only'); assert.equal(result.probe, undefined); assert.equal(result.closed, true);
  assert.deepEqual(result.speedObservations.map(row => row.requestedSpeed), [16]);
  assert.ok(result.speedObservations.every(row => row.status === 'completed' && row.allowedSpeeds === null && row.verificationStatus === 'unverified'));
  assert.equal(child.stdout.includes('private'), false);
});

test('16 uses the remaining flow with a fresh connection and no earlier control', async () => {
  const { runtime, events, connections } = remainingRuntime();
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [['connect', 7], ['close', 7],
    ['connect', 7], ['start', 16], ['stop', 7], ['close', 7]]);
  assert.equal(new Set(connections).size, 2);
  assert.ok(connections.every(p2p => !p2p.isConnected() && p2p.streamTimeouts.streamDataWait === 5000));
  assert.deepEqual(result.speedObservations.map(row => row.requestedSpeed), [16]);
});

test('16 cannot create its control owner until the preceding query connection confirms close', async () => {
  const { runtime, connections } = remainingRuntime(), create = runtime.createService, seen = [];
  let release;
  runtime.createService = session => {
    const service = create(session);
    if (connections.length === 1) {
      const p2p = service.station.p2pSession, close = p2p.close;
      p2p.close = async () => { await new Promise(resolve => { release = resolve; }); await close(); };
    }
    return service;
  };
  const pending = runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true, probe: async input => {
    seen.push(input.candidateSpeed); return success();
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, []); assert.equal(connections.length, 1); assert.equal(typeof release, 'function');
  release();
  assert.equal((await pending).status, 'completed'); assert.deepEqual(seen, [16]); assert.equal(connections.length, 2);
});

test('16 refuses to run if the preceding query owner stays connected after close', async () => {
  const { runtime, connections } = remainingRuntime(), create = runtime.createService;
  runtime.createService = session => { const service = create(session); service.station.p2pSession.close = async () => {}; return service; };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true, probe: () => assert.fail('No control before close') });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HOST_CLOSE_FAILED');
  assert.equal(result.closed, false); assert.deepEqual(result.speedObservations, []); assert.equal(connections.length, 1);
});

for (const code of ['CONTROL_REJECTED', 'CONTROL_STARTUP_TIMEOUT', 'CONTROL_CONNECTION_LOST', 'CONTROL_CLEANUP_FAILED']) {
  test(`16 records its own ${code} and ends without retrying`, async () => {
    const { runtime } = remainingRuntime(), seen = [];
    const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true, probe: async input => {
      seen.push(input.candidateSpeed);
      return { status: 'failed', requestedSpeed: input.candidateSpeed, error: { code, stage: 'candidate_media' } };
    } });
    assert.equal(result.status, 'failed'); assert.deepEqual(seen, [16]);
    assert.equal(runtime.calls.connect, 2); assert.equal(runtime.calls.close, 2); assert.equal(result.closed, true);
  });
}

for (const code of ['CONTROL_REJECTED', 'CONTROL_STARTUP_TIMEOUT', 'CONTROL_CONNECTION_LOST', 'CONTROL_CLEANUP_FAILED']) {
  test(`remaining speeds abort immediately on ${code} without another candidate`, async () => {
    const { runtime } = remainingRuntime(), seen = [];
    const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: async input => {
      seen.push(input.candidateSpeed);
      return { status: 'failed', requestedSpeed: input.candidateSpeed, error: { code, stage: 'start' } };
    } });
    assert.equal(result.status, 'failed'); assert.deepEqual(seen, [4]);
    assert.equal(runtime.calls.connect, 2); assert.equal(runtime.calls.close, 2);
    assert.equal(result.closed, true);
  });
}

test('remaining scope selects only current inventory firmware fields and safe nulls', async () => {
  const { runtime } = remainingRuntime();
  Object.assign(runtime.inventory.devices[1], { main_sw_version: '3.5.0', sec_sw_version: null, token: 'token-private', file_path: 'path-private' });
  Object.assign(runtime.inventory.devices[0], { main_sw_version: '', sec_sw_version: '1.2.3', account: 'account-private', payload: { secret: 'payload-private' } });
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: success });
  assert.deepEqual(result.deviceScope, { cameraModel: 'T8600', cameraFirmware: { main: '3.5.0', secondary: null },
    homeBaseModel: 'T8030', homeBaseFirmware: { main: null, secondary: '1.2.3' }, channel: 7 });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

for (const peerCount of [0]) test(`remaining peer observation with ${peerCount} peers stays unverified without choosing one`, async () => {
  const { runtime, events } = remainingRuntime(peerCount);
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: success });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.peerObservation, { status: 'unverified', reason: peerCount ? 'ambiguous_peer' : 'no_eligible_peer',
    limitation: 'not a playback-isolation proof', channel: null, observations: [] });
  assert.ok(events.every(([, channel]) => channel === 7));
});

test('multiple independently bound peers deterministically select the lowest channel regardless of inventory order', async () => {
  const { runtime } = remainingRuntime(3);
  runtime.inventory.devices.reverse();
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true });
  assert.equal(result.status, 'completed'); assert.equal(result.peerObservation.channel, 8);
  assert.equal(result.peerObservation.status, 'unverified');
  assert.equal(result.peerObservation.limitation, 'not a playback-isolation proof');
  assert.deepEqual(result.peerObservation.observations.map(row => [row.speed, row.phase, row.status]),
    [[16, 'before', 'responded'], [16, 'after', 'responded']]);
  assert.equal(runtime.calls.queries.some(row => row.channel === 9 || row.channel === 10), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

for (const ambiguity of ['channel', 'serial']) test(`ambiguous peer ${ambiguity} bindings are excluded before selecting the next independent channel`, async () => {
  const { runtime } = remainingRuntime(3);
  if (ambiguity === 'channel') runtime.inventory.devices[3].device_channel = 8;
  else runtime.inventory.devices[3].device_sn = runtime.inventory.devices[2].device_sn;
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true, probe: success });
  assert.equal(result.status, 'completed'); assert.equal(result.peerObservation.channel, 10);
  assert.equal(runtime.calls.queries.some(row => row.channel === 8 || row.channel === 9), false);
});

test('all peers with the same ambiguous channel remain unverified without choosing any', async () => {
  const { runtime } = remainingRuntime(2);
  runtime.inventory.devices[3].device_channel = 8;
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed16: true, probe: success });
  assert.equal(result.status, 'completed');
  assert.equal(result.peerObservation.reason, 'ambiguous_peer');
  assert.equal(result.peerObservation.channel, null); assert.deepEqual(result.peerObservation.observations, []);
});

test('unique peer gets one read-only independent query before and after each candidate', async () => {
  const { runtime, events, connections } = remainingRuntime(1);
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.peerObservation.status, 'unverified');
  assert.equal(result.peerObservation.limitation, 'not a playback-isolation proof');
  assert.equal(result.peerObservation.channel, 8);
  assert.deepEqual(result.peerObservation.observations.map(row => [row.speed, row.phase, row.status, row.queryMatched]),
    [4, 8, 16].flatMap(speed => [[speed, 'before', 'responded', 1], [speed, 'after', 'responded', 1]]));
  assert.deepEqual(events, [['connect', 7], ['close', 7], ...[4, 8, 16].flatMap(speed => [
    ['connect', 8], ['close', 8], ['connect', 7], ['start', speed], ['stop', 7], ['close', 7], ['connect', 8], ['close', 8]])]);
  assert.equal(connections.length, 10);
  assert.equal(runtime.calls.queries.filter(row => row.channel === 8).length, 6);
  assert.equal(result.peerObservation.observations.every(row => row.queryRejected === 1), true);
});

test('a peer query failure is unverified, closes its owner and does not stop speed observations', async () => {
  const { runtime, connections } = remainingRuntime(1), create = runtime.createService;
  runtime.createService = session => {
    const service = create(session), query = service.station.p2pSession.queryContinuousRecordings;
    service.station.p2pSession.queryContinuousRecordings = (...args) => {
      if (args[1] === 8) throw new Error('token-private account-private');
      return query(...args);
    };
    return service;
  };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true });
  assert.equal(result.status, 'completed');
  assert.ok(result.peerObservation.observations.every(row => row.status === 'unverified' && row.error.code === 'HOST_QUERY_FAILED'));
  assert.deepEqual(result.speedObservations.map(row => row.requestedSpeed), [4, 8, 16]);
  assert.ok(connections.every(p2p => !p2p.isConnected()));
  assert.equal(JSON.stringify(result).includes('private'), false);
});

for (const change of [{ device_sn: '' }, { device_sn: undefined }, { device_channel: 7 }, { device_channel: '8' }, { device_type: undefined }, { device_model: 'T9999' }]) {
  test(`remaining peer eligibility rejects ${Object.keys(change)[0]}=${Object.values(change)[0]}`, async () => {
    const { runtime, connections } = remainingRuntime(1);
    Object.assign(runtime.inventory.devices[2], change);
    const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: success });
    assert.equal(result.status, 'completed');
    assert.equal(result.peerObservation.reason, 'no_eligible_peer');
    assert.equal(connections.length, 4);
  });
}

test('peer runtime channel mismatch cannot query and remains unverified without affecting target candidates', async () => {
  const { runtime } = remainingRuntime(1), create = runtime.createService;
  runtime.createService = session => {
    const service = create(session), connect = service.connect;
    service.connect = async serial => { await connect(serial); if (serial.startsWith('peer-')) service.camera.getChannel = () => 9; };
    return service;
  };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: success });
  assert.equal(result.status, 'completed');
  assert.ok(result.peerObservation.observations.every(row => row.queryMatched === 0 && row.error.code === 'HOST_TARGET_CHANGED'));
  assert.equal(runtime.calls.queries.some(row => row.channel !== 7), false);
});

test('unconfirmed peer close prevents any target candidate or replacement owner', async () => {
  const { runtime, connections } = remainingRuntime(1), create = runtime.createService;
  runtime.createService = session => {
    const service = create(session), connect = service.connect;
    service.connect = async serial => { await connect(serial); if (serial.startsWith('peer-')) service.station.p2pSession.close = async () => {}; };
    return service;
  };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeRemaining: true, probe: () => assert.fail('No target probe') });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HOST_CLOSE_FAILED');
  assert.deepEqual(result.speedObservations, []); assert.equal(result.closed, false);
  assert.equal(connections.length, 2);
});

test('resume-speed-2 dry-run executes only one candidate with fresh media and confirmed stop', () => {
  const child = spawnSync(process.execPath, [require.resolve('./playback-controls-host.cjs'), '--dry-run', '--resume-speed-2'], {
    encoding: 'utf8', env: { ...process.env, EUFY_SESSION_PATH: 'must-not-read-private-session', ISSUE9_PROBE_EVIDENCE_PATH: 'must-not-write' }, timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.scope, 'speed_2_only');
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.probe, undefined);
  assert.equal(result.closed, true);
  assert.deepEqual(result.speedObservations.map(item => item.requestedSpeed), [2]);
  const observation = result.speedObservations[0];
  assert.equal(observation.status, 'completed');
  assert.equal(observation.verificationStatus, 'unverified');
  assert.equal(observation.allowedSpeeds, null);
  assert.deepEqual(observation.operations.map(item => [item.operation, item.returnCode]), [['start', 0], ['stop', 0]]);
  assert.equal(observation.startup.mediaBudgetMs, 15000);
  assert.ok(observation.startup.firstVideoAtMs >= observation.startup.startedAtMs);
  assert.ok(observation.frames.length >= 2);
  for (const secret of ['fake-camera-private', 'fake-base-private', 'fake-account-private', 'fake-path-private', 'must-not-'])
    assert.equal(child.stdout.includes(secret), false);
});

test('resume-speed-2 creates a new service and P2P, restores once, queries two 12h windows and sends only q0 speed 2', async () => {
  const runtime = createDryRunRuntime(), previousService = runtime.createService();
  const previousP2P = previousService.station.p2pSession;
  await previousService.close();
  let restores = 0, creations = 0;
  runtime.session.restore = async () => { restores++; };
  const createService = runtime.createService, sent = [];
  runtime.createService = session => {
    assert.equal(session, runtime.session);
    creations++;
    const service = createService();
    assert.notEqual(service, previousService);
    const p2p = service.station.p2pSession;
    assert.notEqual(p2p, previousP2P);
    const send = p2p.sendCommandWithStringPayload;
    p2p.sendCommandWithStringPayload = (command, marker) => { sent.push({ command, marker }); return send(command, marker); };
    return service;
  };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed2: true });
  assert.equal(result.status, 'completed');
  assert.equal(restores, 1); assert.equal(creations, 1);
  assert.equal(result.probe, undefined);
  assert.deepEqual(runtime.calls.queries.map(({ begin, end }) => [begin, end]), [[now - 86400, now - 43200], [now - 43200, now], [now - 120, now - 60]]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].marker);
  assert.equal(sent[0].command.channel, 7);
  assert.deepEqual(JSON.parse(sent[0].command.value), { commandType: 6001, data: {
    session_id: 125, cmd: 0, begin_time: now - 120, play_speed: 2, play_type: 0,
    device_sn: 'fake-camera-private', account_id: 'fake-account-private', index: 0, file_path: 'fake-path-private',
  } });
  assert.deepEqual(result.speedObservations[0].operations.map(item => item.operation), ['start', 'stop']);
  assert.equal(runtime.service.station.p2pSession.streamTimeouts.streamDataWait, 5000);
  assert.equal(runtime.service.station.p2pSession.isConnected(), false);
});

for (const code of ['CONTROL_REJECTED', 'CONTROL_STARTUP_TIMEOUT']) {
  test(`resume-speed-2 ends after ${code} without another candidate or connection`, async () => {
    const runtime = createDryRunRuntime(), candidates = [];
    const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed2: true, probe: async input => {
      candidates.push(input.candidateSpeed);
      return { status: 'failed', requestedSpeed: input.candidateSpeed, error: { code, stage: 'start' } };
    } });
    assert.equal(result.status, 'failed');
    assert.deepEqual(candidates, [2]);
    assert.equal(runtime.calls.connect, 1); assert.equal(runtime.calls.close, 1);
    assert.equal(result.closed, true);
  });
}

test('executable dry-run uses only built-in fakes, runs probe and candidates, and closes', () => {
  const child = spawnSync(process.execPath, [require.resolve('./playback-controls-host.cjs'), '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, EUFY_SESSION_PATH: 'must-not-read-private-session', ISSUE9_PROBE_EVIDENCE_PATH: 'must-not-write' },
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.status, 'completed');
  assert.equal(result.closed, true);
  assert.equal(result.probe.status, 'completed');
  assert.deepEqual(result.speedObservations.map(item => item.requestedSpeed), [1, 2, 4, 8, 16]);
  assert.ok(result.speedObservations.every(item => item.status === 'completed' && item.verificationStatus === 'unverified'));
  assert.equal(result.binding.singleTarget, true);
  assert.equal(result.channelIsolation.status, 'unverified');
  for (const secret of ['fake-camera-private', 'fake-base-private', 'fake-account-private', 'fake-path-private', 'must-not-'])
    assert.equal(child.stdout.includes(secret), false);
});

test('host queries two contiguous 12h windows and reuses the unique dynamic binding for the latest complete 60s', async () => {
  const runtime = createDryRunRuntime();
  const probes = [];
  const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: async input => { probes.push(input); return success(); } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(runtime.calls.queries.map(({ begin, end }) => [begin, end]), [[now - 86400, now - 43200], [now - 43200, now]]);
  assert.equal(probes.length, 6);
  for (const input of probes) {
    assert.equal(input.serial, 'fake-camera-private');
    assert.equal(input.accountId, 'fake-account-private');
    assert.equal(input.channel, 7);
    assert.equal(input.begin, now - 120);
    assert.equal(input.end, now - 60);
    assert.equal(input.p2p, runtime.service.station.p2pSession);
  }
  assert.equal(runtime.calls.connect, 1);
  assert.equal(runtime.calls.close, 1);
  assert.equal(result.channelChecks.queryMatched, 2);
  assert.equal(result.channelChecks.queryRejected, 2);
});

for (const resumeSpeed2 of [false, true]) for (const problem of ['ambiguous', 'wrong_model', 'wrong_parent', 'wrong_runtime_channel']) {
  test(`host refuses ${problem} without any playback query (resume=${resumeSpeed2})`, async () => {
    const runtime = createDryRunRuntime();
    if (problem === 'ambiguous') runtime.inventory.devices.push({ ...runtime.inventory.devices[1], device_sn: 'second-private' });
    if (problem === 'wrong_model') runtime.inventory.devices[1].device_model = 'T9999';
    if (problem === 'wrong_parent') runtime.inventory.devices[0].device_model = 'T9999';
    if (problem === 'wrong_runtime_channel') runtime.service.camera.getChannel = () => 8;
    const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: success, resumeSpeed2 });
    assert.equal(result.status, 'failed');
    assert.match(result.error.code, /^HOST_TARGET_/);
    assert.equal(runtime.calls.queries.length, 0);
    assert.equal(runtime.calls.close, problem === 'wrong_runtime_channel' ? 1 : 0);
  });
}

test('host rejects inventory ranges with less than 60 seconds and closes after a query failure', async () => {
  const runtime = createDryRunRuntime();
  runtime.service.station.p2pSession.queryContinuousRecordings = (_serial, channel, begin, end) => {
    runtime.service.station.p2pSession.emit('continuous recording ranges', channel, {
      begin_time: begin, end_time: end, videos: [{ start_time: end - 59, stop_time: end }],
    });
  };
  const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: () => assert.fail('No complete minute') });
  assert.deepEqual(result.error, { code: 'HOST_RECORDING_UNAVAILABLE', stage: 'select' });
  assert.equal(runtime.calls.close, 1);
});

test('host closes on arbitrary errors and emits no details from the input or error', async () => {
  const runtime = createDryRunRuntime();
  const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: () => { throw new Error('fake-account-private 192.0.2.1 token-private'); } });
  assert.deepEqual(result.error, { code: 'HOST_OPERATION_FAILED', stage: 'probe' });
  assert.equal(result.closed, true);
  assert.equal(runtime.calls.close, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('host stops after a failed candidate and awaits close without a later candidate or a second P2P close', async () => {
  const runtime = createDryRunRuntime();
  const candidates = [];
  const p2p = runtime.service.station.p2pSession;
  const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: async input => {
    if (input.candidateSpeed) {
      candidates.push(input.candidateSpeed);
      await p2p.close();
      return { status: 'failed', error: { code: 'CONTROL_TIMEOUT', stage: 'start' }, connectionTerminated: true };
    }
    return success();
  } });
  assert.equal(result.status, 'failed');
  assert.deepEqual(candidates, [1]);
  assert.equal(runtime.calls.p2pClose, 1);
  assert.equal(runtime.calls.close, 1);
});

test('candidate runs wait for the previous observation before starting the next', async () => {
  const runtime = createDryRunRuntime();
  let release;
  const calls = [];
  const pending = runPlaybackControlsHost({ runtime, now: () => now, probe: async input => {
    calls.push(input.candidateSpeed ?? 'controls');
    if (input.candidateSpeed === 1) await new Promise(resolve => { release = resolve; });
    return success();
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['controls', 1]);
  release();
  assert.equal((await pending).status, 'completed');
  assert.deepEqual(calls, ['controls', 1, 2, 4, 8, 16]);
});

for (const rejectedStage of ['start', 'stop']) {
  test(`confirmed candidate ${rejectedStage} rejection closes its owner then reconnects for every remaining candidate`, async () => {
    const runtime = createDryRunRuntime();
    const observed = [], connections = [];
    const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: async input => {
      if (input.candidateSpeed) {
        observed.push(input.candidateSpeed); connections.push(input.p2p);
        if (input.candidateSpeed === 2) return { status: 'failed', requestedSpeed: 2,
          error: { code: 'CONTROL_REJECTED', stage: rejectedStage } };
        if (input.candidateSpeed > 2) assert.equal(connections[0].isConnected(), false, 'Previous owner is closed');
      }
      return { ...await success(), requestedSpeed: input.candidateSpeed };
    } });
    assert.equal(result.status, 'completed');
    assert.deepEqual(observed, [1, 2, 4, 8, 16]);
    assert.equal(runtime.calls.connect, 2);
    assert.equal(runtime.calls.close, 2);
    assert.equal(runtime.calls.p2pClose, 2);
    assert.notEqual(connections[1], connections[2]);
    assert.equal(result.speedObservations[1].error.code, 'CONTROL_REJECTED');
  });
}

test('a close that leaves the owner connected cannot admit any later candidate or replacement owner', async () => {
  const runtime = createDryRunRuntime();
  const p2p = runtime.service.station.p2pSession;
  p2p.close = async () => {};
  const candidates = [];
  const result = await runPlaybackControlsHost({ runtime, now: () => now, probe: async input => {
    if (!input.candidateSpeed) return success();
    candidates.push(input.candidateSpeed);
    return { status: 'failed', error: { code: 'CONTROL_REJECTED', stage: 'start' } };
  } });
  assert.equal(result.status, 'failed');
  assert.deepEqual(candidates, [1]);
  assert.equal(runtime.calls.connect, 1);
  assert.equal(result.closed, false);
});

test('host awaits connection termination before service cleanup and return', async () => {
  const runtime = createDryRunRuntime();
  const p2p = runtime.service.station.p2pSession, close = p2p.close;
  let release, settled = false;
  p2p.close = async () => { await new Promise(resolve => { release = resolve; }); await close(); };
  const pending = runPlaybackControlsHost({ runtime, now: () => now, probe: success }).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(runtime.calls.close, 0);
  release();
  assert.equal((await pending).closed, true);
  assert.equal(runtime.calls.close, 1);
});

for (const entry of ['--run', '--resume-speed-2', '--resume-speeds-4-8-16', '--resume-speed-16']) for (const env of [{}, { EUFY_SESSION_PATH: 'private' }, { ISSUE9_PROBE_EVIDENCE_PATH: 'private' }]) {
  test(`missing required ${entry} paths fails before any runtime, file or hardware side effect (${Object.keys(env).join(',')})`, async () => {
    const result = await main({ argv: [entry], env, createRuntime: () => assert.fail('No runtime'),
      preflight: () => assert.fail('No filesystem'), writeEvidence: () => assert.fail('No output write') });
    assert.deepEqual(result.error, { code: 'HOST_ENV_REQUIRED', stage: 'preflight' });
  });
}

for (const entry of ['--run', '--resume-speed-2', '--resume-speeds-4-8-16', '--resume-speed-16']) test(`path preflight failure and extra target arguments fail before session restore (${entry})`, async () => {
  const options = { env: { EUFY_SESSION_PATH: 'private', ISSUE9_PROBE_EVIDENCE_PATH: 'private2' },
    createRuntime: () => assert.fail('No runtime'), writeEvidence: () => assert.fail('No output write') };
  const result = await main({ ...options, argv: [entry], preflight: () => { throw new Error('private-path'); } });
  assert.deepEqual(result.error, { code: 'HOST_PATH_INVALID', stage: 'preflight' });
  const invalid = await main({ ...options, argv: [entry, '--channel', '1'] });
  assert.equal(invalid.error.code, 'HOST_ARGUMENTS_INVALID');
});

test('resume-speed-2 entry uses preflight and the same restored session and writes only sanitized observations', async () => {
  const env = { EUFY_SESSION_PATH: 'session-private', ISSUE9_PROBE_EVIDENCE_PATH: 'output-private' }, events = [];
  const runtime = createDryRunRuntime();
  const result = await main({ argv: ['--resume-speed-2'], env,
    preflight: (session, output) => { assert.equal(session, env.EUFY_SESSION_PATH); assert.equal(output, env.ISSUE9_PROBE_EVIDENCE_PATH); events.push('preflight'); },
    createRuntime: (mode, session) => { assert.equal(mode, 'run'); assert.equal(session, env.EUFY_SESSION_PATH); events.push('runtime'); return runtime; },
    writeEvidence: (output, observation) => {
      assert.equal(output, env.ISSUE9_PROBE_EVIDENCE_PATH); events.push('write');
      assert.equal(observation.closed, true); assert.equal(JSON.stringify(observation).includes('private'), false);
    } });
  assert.deepEqual(events, ['preflight', 'runtime', 'write']);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.speedObservations.map(item => item.requestedSpeed), [2]);
});

test('resume-speed-2 accepts no extra mode, repeated flag or user selected candidate', async () => {
  for (const argv of [['--resume-speed-2', '--resume-speed-2'], ['--run', '--resume-speed-2'], ['--resume-speed-2', '4'], ['--dry-run', '--resume-speed-2', '--speed', '2'],
    ['--resume-speeds-4-8-16', '--resume-speeds-4-8-16'], ['--run', '--resume-speeds-4-8-16'], ['--resume-speeds-4-8-16', '8'], ['--dry-run', '--resume-speeds-4-8-16', '--channel', '1'],
    ['--resume-speed-16', '--resume-speed-16'], ['--run', '--resume-speed-16'], ['--resume-speed-16', '8'], ['--dry-run', '--resume-speed-16', '--channel', '1']]) {
    const result = await main({ argv, createRuntime: () => assert.fail('No runtime') });
    assert.equal(result.error.code, 'HOST_ARGUMENTS_INVALID');
  }
});

for (const resumeSpeed2 of [false, true]) test(`restored session must be authenticated and connected before creating a service (resume=${resumeSpeed2})`, async () => {
  const runtime = createDryRunRuntime();
  runtime.session.restore = async () => { runtime.session.state.phase = 'login_required'; };
  runtime.createService = () => assert.fail('No P2P service');
  const result = await runPlaybackControlsHost({ runtime, now: () => now, resumeSpeed2 });
  assert.deepEqual(result.error, { code: 'HOST_SESSION_UNAVAILABLE', stage: 'restore' });
});
