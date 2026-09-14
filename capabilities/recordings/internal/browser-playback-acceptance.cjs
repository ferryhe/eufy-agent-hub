#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const REQUIRED_ACK = 'manager-authorized-single-owner';
const root = path.resolve(__dirname, '../../..');

function windowFrom(env, prefix = '') {
  const value = { day: env[`EUFY_BROWSER_ACCEPTANCE_${prefix}DAY`], start: env[`EUFY_BROWSER_ACCEPTANCE_${prefix}START`],
    end: env[`EUFY_BROWSER_ACCEPTANCE_${prefix}END`], timezone: 'America/Toronto' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.day || '') || !/^\d{2}:\d{2}$/.test(value.start || '') || !/^\d{2}:\d{2}$/.test(value.end || ''))
    throw new Error('ACCEPTANCE_WINDOW_REQUIRED');
  const minutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const duration = minutes(value.end) - minutes(value.start);
  if (duration < 1 || duration > 60) throw new Error('ACCEPTANCE_WINDOW_BOUNDS');
  return value;
}

function configuration(env = process.env) {
  if (env.EUFY_BROWSER_ACCEPTANCE_ACK !== REQUIRED_ACK) throw new Error('ACCEPTANCE_ACK_REQUIRED');
  const url = new URL(env.EUFY_BROWSER_ACCEPTANCE_ORIGIN || '');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash)
    throw new Error('ACCEPTANCE_LOOPBACK_ORIGIN_REQUIRED');
  const evidencePath = path.resolve(env.EUFY_BROWSER_ACCEPTANCE_EVIDENCE || '');
  if (!path.isAbsolute(env.EUFY_BROWSER_ACCEPTANCE_EVIDENCE || '') || path.extname(evidencePath).toLowerCase() !== '.json')
    throw new Error('ACCEPTANCE_EVIDENCE_PATH_REQUIRED');
  const relative = path.relative(root, evidencePath);
  if (!relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ACCEPTANCE_EVIDENCE_MUST_BE_PRIVATE');
  if (fs.existsSync(evidencePath)) throw new Error('ACCEPTANCE_EVIDENCE_EXISTS');
  const serial = env.EUFY_BROWSER_ACCEPTANCE_SERIAL;
  if (!serial) throw new Error('ACCEPTANCE_SERIAL_REQUIRED');
  return { origin: url.origin, evidencePath, serial, initial: windowFrom(env), seek: windowFrom(env, 'SEEK_') };
}

async function json(origin, route) {
  const response = await fetch(origin + route, { headers: { Origin: origin } });
  if (!response.ok) throw new Error('ACCEPTANCE_PREFLIGHT_FAILED');
  return response.json();
}

function writeEvidence(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
}

function hasVisiblePixel(data) {
  for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return true;
  return false;
}

function replacementReady(value, oldSessionId, requestId) {
  return typeof value?.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId !== oldSessionId
    && typeof requestId === 'string' && requestId.length > 0 && value.requestId === requestId
    && Number.isSafeInteger(value.mediaEpoch) && value.mediaEpoch > 0
    && Number.isSafeInteger(value.frameSequence) && value.frameSequence > 0
    && Number.isSafeInteger(value.sourceReceivedPositionMs) && value.sourceReceivedPositionMs >= 0
    && value.pixelPresent === true;
}

function residentIdle(session, recordings) {
  return session?.authenticated === true && session.phase === 'connected' && session.busy === false && recordings?.busy === false;
}

async function waitForResidentIdle(read, { attempts = 240, delayMs = 250, stableSamples = 7 } = {}) {
  let idleSamples = 0; // Seven 250ms samples span the page's 1.2s polling cadence.
  for (let count = 0; count < attempts; count++) {
    const value = await read();
    if (residentIdle(...value)) { if (++idleSamples >= stableSamples) return value; }
    else idleSamples = 0;
    if (count + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('ACCEPTANCE_RESIDENT_IDLE_TIMEOUT');
}

async function waitForPlaybackAdmission(waitForRange, read, options) {
  await waitForRange();
  return waitForResidentIdle(read, options);
}

function cleanupProof(oldPlayback, finalPlayback, resident) {
  const session = playback => ({ stopConfirmed: playback?.stopConfirmed === true, cleanupComplete: playback?.cleanupComplete === true,
    resourcesClosed: Boolean(playback?.resources) && Object.values(playback.resources).every(value => value === true) });
  const oldSession = session(oldPlayback), finalSession = session(finalPlayback), residentIdle = resident?.busy === false;
  return { valid: oldSession.stopConfirmed && oldSession.cleanupComplete && oldSession.resourcesClosed
      && finalSession.stopConfirmed && finalSession.cleanupComplete && finalSession.resourcesClosed && residentIdle,
    oldSession, finalSession, residentIdle };
}

async function waitForReplacement(read, oldSessionId, requestId, { attempts = 120, delayMs = 250 } = {}) {
  for (let count = 0; count < attempts; count++) {
    const value = await read();
    if (replacementReady(value, oldSessionId, requestId)) return value;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('ACCEPTANCE_SEEK_FRAME_TIMEOUT');
}

async function canvasObservation(canvas) {
  return canvas.evaluate(element => { const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    let pixelPresent = false; for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) { pixelPresent = true; break; }
    return { sessionId: element.dataset.sessionId, requestId: element.dataset.requestId,
      mediaEpoch: Number(element.dataset.mediaEpoch), frameSequence: Number(element.dataset.frameSequence),
      sourceReceivedPositionMs: Number(element.dataset.sourceReceivedPositionMs), firstFrameLatencyMs: Number(element.dataset.firstFrameLatencyMs),
      pixelPresent, privatePixelSignature: element.toDataURL('image/png') }; });
}

async function run(env = process.env) {
  const config = configuration(env), startedAt = new Date().toISOString();
  const session = await json(config.origin, '/api/v1/session');
  const legacy = await json(config.origin, '/recordings/status');
  if (!residentIdle(session, legacy)) throw new Error('ACCEPTANCE_RESIDENT_NOT_IDLE');
  const inventory = await json(config.origin, '/api/v1/devices');
  const device = inventory.devices?.find(item => item.serial === config.serial);
  const controls = device?.capabilities?.continuousPlaybackControls;
  if (device?.verificationScope?.model !== 'T8600' || device.verificationScope.homeBase?.model !== 'T8030'
    || controls?.status !== 'verified' || !controls.controls?.verifiedStartSpeeds?.includes(1) || !controls.controls?.pauseResumeAtSpeed1)
    throw new Error('ACCEPTANCE_SCOPE_NOT_VERIFIED');

  let browser, page, active = false;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en' });
    await context.addInitScript(() => localStorage.setItem('eufy-agent-hub.language', 'en'));
    page = await context.newPage();
    await page.goto(`${config.origin}/app/recordings`);
    await page.getByRole('heading', { name: 'Recording workbench' }).waitFor();
    await page.getByLabel('Exact camera').selectOption(config.serial);
    for (const [label, value] of [['Date', config.initial.day], ['Start time', config.initial.start], ['End time', config.initial.end]])
      await page.getByLabel(label).fill(value);
    await waitForResidentIdle(() => Promise.all([
      json(config.origin, '/api/v1/session'), json(config.origin, '/recordings/status')
    ]));
    await page.getByRole('button', { name: 'Check continuous availability' }).click();
    const play = page.getByRole('button', { name: 'Play selected timestamp' });
    await waitForPlaybackAdmission(
      () => page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Play selected timestamp')?.disabled),
      () => Promise.all([json(config.origin, '/api/v1/session'), json(config.origin, '/recordings/status')])
    );
    const playFocused = await play.focus().then(() => page.evaluate(() => document.activeElement?.textContent === 'Play selected timestamp'));
    await play.click(); active = true;
    const canvas = page.locator('.historical-player canvas');
    await page.waitForFunction(() => Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs), undefined, { timeout: 30000 });
    const first = await canvasObservation(canvas), firstSession = await json(config.origin, `/api/v1/playback-sessions/${encodeURIComponent(first.sessionId)}`);
    if (!first.pixelPresent || !Number.isFinite(first.firstFrameLatencyMs)) throw new Error('ACCEPTANCE_FIRST_FRAME_FAILED');

    await page.getByRole('button', { name: 'Pause preview' }).click();
    await page.getByRole('button', { name: 'Resume preview' }).waitFor();
    const paused = await canvasObservation(canvas), pauseStartedAt = Date.now();
    await page.waitForTimeout(6000);
    const frozen = await canvasObservation(canvas), pauseWallMs = Date.now() - pauseStartedAt;
    if (frozen.privatePixelSignature !== paused.privatePixelSignature || frozen.sourceReceivedPositionMs !== paused.sourceReceivedPositionMs
      || frozen.frameSequence !== paused.frameSequence) throw new Error('ACCEPTANCE_PAUSE_NOT_FROZEN');

    await page.getByRole('button', { name: 'Resume preview' }).click();
    await page.waitForFunction(previous => { const canvas = document.querySelector('.historical-player canvas');
      return Number(canvas?.dataset.mediaEpoch) > previous.mediaEpoch && Number(canvas?.dataset.sourceReceivedPositionMs) > previous.sourceReceivedPositionMs; }, paused, { timeout: 30000 });
    const resumed = await canvasObservation(canvas);

    for (const [label, value] of [['Date', config.seek.day], ['Start time', config.seek.start], ['End time', config.seek.end]])
      await page.getByLabel(label).fill(value);
    await page.getByRole('button', { name: 'Seek to selected timestamp' }).click();
    await page.waitForFunction(() => { try { const value = JSON.parse(localStorage.getItem('eufy-agent-hub.playback-intent'));
      return value?.operation === 'seek' && typeof value.requestId === 'string' && value.requestId.length > 0; } catch { return false; } }, undefined, { timeout: 30000 });
    const seekRequestId = await page.evaluate(() => JSON.parse(localStorage.getItem('eufy-agent-hub.playback-intent')).requestId);
    const sought = await waitForReplacement(() => canvasObservation(canvas), first.sessionId, seekRequestId);
    const oldSession = await json(config.origin, `/api/v1/playback-sessions/${encodeURIComponent(first.sessionId)}`);
    const soughtSession = await json(config.origin, `/api/v1/playback-sessions/${encodeURIComponent(sought.sessionId)}`);
    const soughtStart = Date.parse(soughtSession.playback.window.normalized.start), soughtEnd = Date.parse(soughtSession.playback.window.normalized.end);
    if (sought.sourceReceivedPositionMs < soughtStart || sought.sourceReceivedPositionMs >= soughtEnd) throw new Error('ACCEPTANCE_SEEK_SOURCE_OUTSIDE_WINDOW');

    await page.getByRole('button', { name: 'Close preview' }).click();
    await page.getByRole('button', { name: 'Play selected timestamp' }).waitFor();
    await waitForResidentIdle(() => Promise.all([
      json(config.origin, '/api/v1/session'), json(config.origin, '/recordings/status')
    ]));
    const closed = await json(config.origin, `/api/v1/playback-sessions/${encodeURIComponent(sought.sessionId)}`), finalSession = await json(config.origin, '/api/v1/session');
    const cleanup = cleanupProof(oldSession.playback, closed.playback, finalSession);
    if (!cleanup.valid) throw new Error('ACCEPTANCE_CONFIRMED_CLEANUP_FAILED');
    active = false;

    const omitPixel = ({ privatePixelSignature, ...value }) => value;
    writeEvidence(config.evidencePath, { schema: 'eufy-agent-hub/browser-playback-acceptance/v1', private: true,
      warning: 'Contains private device identity. Never commit, attach to a public Issue/PR, or paste into logs.',
      startedAt, completedAt: new Date().toISOString(), result: 'PASS', browser: { name: 'Chromium', version: browser.version(), viewport: { width: 1440, height: 900 }, language: 'en' },
      scope: device.verificationScope, windows: { initial: config.initial, seek: config.seek },
      observations: { keyboardFocus: playFocused, firstFrame: { ...omitPixel(first), serverFirstJpegLatencyMs: firstSession.playback.media.firstFrameLatencyMs }, pause: { wallMs: pauseWallMs, canvasAndLabelFrozen: true, observation: omitPixel(frozen) },
        resume: { freshDecoderEpoch: resumed.mediaEpoch > paused.mediaEpoch, sourceAdvanced: resumed.sourceReceivedPositionMs > paused.sourceReceivedPositionMs, observation: omitPixel(resumed) },
        seek: { ...cleanup.oldSession, observation: omitPixel(sought) }, close: { ...cleanup.finalSession, residentIdle: cleanup.residentIdle } },
      safari: { status: 'NOT_RUN', userWaived: true, mergeBlocker: false } });
    await context.close();
  } catch (error) {
    if (active && page) await page.getByRole('button', { name: 'Close preview' }).click({ timeout: 5000 }).catch(() => {});
    throw error;
  } finally { await browser?.close(); }
}

if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-hardware') { process.stderr.write('Use --run-hardware after the documented manager preflight.\n'); process.exitCode = 2; }
  else run().then(() => process.stdout.write('Browser playback hardware acceptance: PASS (private evidence written).\n'), () => {
    process.stderr.write('Browser playback hardware acceptance: FAIL. Inspect the private environment and resident without pasting device data into logs.\n'); process.exitCode = 1;
  });
}

module.exports = { REQUIRED_ACK, configuration, windowFrom, hasVisiblePixel, replacementReady, waitForReplacement,
  residentIdle, waitForResidentIdle, waitForPlaybackAdmission, cleanupProof };
