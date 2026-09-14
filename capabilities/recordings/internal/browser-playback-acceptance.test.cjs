'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { REQUIRED_ACK, configuration, windowFrom, hasVisiblePixel, replacementReady, waitForReplacement,
  residentIdle, waitForResidentIdle, waitForPlaybackAdmission, cleanupProof } = require('./browser-playback-acceptance.cjs');

test('browser playback hardware entry accepts only explicit loopback/private bounded configuration', () => {
  const evidence = path.join(os.tmpdir(), `eufy-browser-acceptance-${process.pid}-${Date.now()}.json`);
  const env = { EUFY_BROWSER_ACCEPTANCE_ACK: REQUIRED_ACK, EUFY_BROWSER_ACCEPTANCE_ORIGIN: 'http://127.0.0.1:3187',
    EUFY_BROWSER_ACCEPTANCE_EVIDENCE: evidence, EUFY_BROWSER_ACCEPTANCE_SERIAL: 'private-camera',
    EUFY_BROWSER_ACCEPTANCE_DAY: '2026-09-13', EUFY_BROWSER_ACCEPTANCE_START: '12:00', EUFY_BROWSER_ACCEPTANCE_END: '12:01',
    EUFY_BROWSER_ACCEPTANCE_SEEK_DAY: '2026-09-13', EUFY_BROWSER_ACCEPTANCE_SEEK_START: '12:01', EUFY_BROWSER_ACCEPTANCE_SEEK_END: '12:02' };
  const value = configuration(env);
  assert.equal(value.origin, 'http://127.0.0.1:3187');
  assert.equal(value.initial.end, '12:01');
  assert.throws(() => configuration({ ...env, EUFY_BROWSER_ACCEPTANCE_ORIGIN: 'https://example.com' }), /LOOPBACK/);
  assert.throws(() => configuration({ ...env, EUFY_BROWSER_ACCEPTANCE_ACK: '' }), /ACK/);
  assert.throws(() => windowFrom({ EUFY_BROWSER_ACCEPTANCE_DAY: '2026-09-13', EUFY_BROWSER_ACCEPTANCE_START: '12:00', EUFY_BROWSER_ACCEPTANCE_END: '13:01' }), /BOUNDS/);
});

test('hardware seek waits for a matching painted replacement before exposing a session id', async () => {
  const valid = { sessionId: 'new-session', requestId: 'seek-request', mediaEpoch: 1, frameSequence: 1,
    sourceReceivedPositionMs: 1000, pixelPresent: true };
  assert.equal(hasVisiblePixel(new Uint8ClampedArray(8)), false);
  assert.equal(hasVisiblePixel(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1])), true);
  for (const value of [undefined, {}, { ...valid, sessionId: '' }, { ...valid, sessionId: 'old-session' },
    { ...valid, requestId: '' }, { ...valid, requestId: 'other' }, { ...valid, mediaEpoch: 0 },
    { ...valid, frameSequence: 0 }, { ...valid, sourceReceivedPositionMs: NaN }, { ...valid, pixelPresent: false }])
    assert.equal(replacementReady(value, 'old-session', 'seek-request'), false);
  assert.equal(replacementReady(valid, 'old-session', 'seek-request'), true);
  const observations = [{}, { sessionId: undefined }, { ...valid, pixelPresent: false }, valid], queried = [];
  const replacement = await waitForReplacement(async () => observations.shift(), 'old-session', 'seek-request', { attempts: 4, delayMs: 0 });
  queried.push(replacement.sessionId);
  assert.deepEqual(queried, ['new-session']);
});

test('hardware range check waits for both resident status views to become idle', async () => {
  const connected = { authenticated: true, phase: 'connected', busy: false }, idle = { busy: false };
  assert.equal(residentIdle(connected, idle), true);
  for (const state of [[{ ...connected, authenticated: false }, idle], [{ ...connected, phase: 'connecting' }, idle],
    [{ ...connected, busy: true }, idle], [connected, { busy: true }]]) assert.equal(residentIdle(...state), false);
  const observations = [[connected, idle], [{ ...connected, busy: true }, idle], [connected, idle], [connected, idle]];
  let reads = 0;
  assert.deepEqual(await waitForResidentIdle(async () => { reads++; return observations.shift(); },
    { attempts: 4, delayMs: 0, stableSamples: 2 }), [connected, idle]);
  assert.equal(reads, 4);
  await assert.rejects(waitForResidentIdle(async () => [{ ...connected, busy: true }, idle], { attempts: 2, delayMs: 0 }),
    /ACCEPTANCE_RESIDENT_IDLE_TIMEOUT/);
});

test('hardware playback admission waits for range readiness before its second idle fence', async () => {
  const order = [], connected = { authenticated: true, phase: 'connected', busy: false }, idle = { busy: false };
  const observations = [[{ ...connected, busy: true }, idle], [connected, idle]];
  let resolveRange, idleReads = 0;
  const rangeReady = new Promise(resolve => { resolveRange = resolve; });
  const pending = waitForPlaybackAdmission(() => { order.push('range-wait'); return rangeReady; }, async () => {
    idleReads++; order.push('idle-read'); return observations.shift();
  }, { attempts: 2, delayMs: 0, stableSamples: 1 });
  await Promise.resolve();
  assert.equal(idleReads, 0); assert.deepEqual(order, ['range-wait']);
  resolveRange();
  await pending;
  assert.equal(idleReads, 2); assert.deepEqual(order, ['range-wait', 'idle-read', 'idle-read']);
});

test('hardware success requires confirmed stops for both playback owners', () => {
  const resources = { protocolClosed: true, connectionClosed: true, decoderClosed: true, streamsClosed: true };
  const session = stopConfirmed => ({ stopConfirmed, cleanupComplete: true, resources });
  for (const [old, final] of [[false, true], [true, false], [undefined, true], [true, undefined]]) {
    const proof = cleanupProof(session(old), session(final), { busy: false });
    assert.equal(proof.valid, false); assert.equal(proof.oldSession.stopConfirmed, old === true); assert.equal(proof.finalSession.stopConfirmed, final === true);
  }
  assert.equal(cleanupProof(session(true), session(true), { busy: true }).valid, false);
  const proof = cleanupProof(session(true), session(true), { busy: false });
  assert.equal(proof.valid, true);
  assert.deepEqual(proof, { valid: true,
    oldSession: { stopConfirmed: true, cleanupComplete: true, resourcesClosed: true },
    finalSession: { stopConfirmed: true, cleanupComplete: true, resourcesClosed: true }, residentIdle: true });
});
