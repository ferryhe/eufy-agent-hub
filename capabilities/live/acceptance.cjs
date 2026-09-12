// Opt-in operator procedure; never loaded by the resident service or test suite.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

async function main() {
  if (process.env.EUFY_LIVE_HARDWARE_ACCEPTANCE !== '1' || !process.env.EUFY_LIVE_CAMERA_SERIAL)
    throw new Error('Opt in with EUFY_LIVE_HARDWARE_ACCEPTANCE=1 and EUFY_LIVE_CAMERA_SERIAL. Use an already authenticated resident on the authorized HomeBase LAN.');
  const origin = process.env.EUFY_LIVE_ORIGIN || 'http://127.0.0.1:3187';
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Use the loopback resident HTTP origin.');
  const directory = path.resolve(__dirname, '../../output/live-acceptance', randomUUID()); fs.mkdirSync(directory, { recursive: true });
  const report = { classification: 'operator-opted-in-hardware-attempt', observedAt: new Date().toISOString(), passed: false };
  const json = async (route, body) => {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  let started, receiving;
  try {
    report.device = await json(`/api/v1/devices/${encodeURIComponent(process.env.EUFY_LIVE_CAMERA_SERIAL)}`);
    started = await json('/api/v1/live-sessions', { serial: process.env.EUFY_LIVE_CAMERA_SERIAL,
      requestId: `hardware-${randomUUID()}`, allowUnverified: true }); report.start = started;
    const response = await fetch(origin + started.live.mediaUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(await response.text());
    receiving = pipeline(Readable.fromWeb(response.body), fs.createWriteStream(path.join(directory, 'sample.mp4')));
    receiving.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10000));
    report.beforeStop = await json(`/api/v1/live-sessions/${started.live.sessionId}`);
    report.stop = await json(`/api/v1/live-sessions/${started.live.sessionId}/stop`, {});
    await receiving;
    const decode = spawnSync(process.env.EUFY_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i',
      path.join(directory, 'sample.mp4'), '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(directory, 'decode.stderr.log'), decode.stderr || String(decode.error || ''));
    report.decode = { exitCode: decode.status, signal: decode.signal, bytes: fs.statSync(path.join(directory, 'sample.mp4')).size };
    report.afterStop = await json(`/api/v1/live-sessions/${started.live.sessionId}`);
    const scope = started.live.verificationScope;
    report.passed = decode.status === 0 && report.decode.bytes > 0 && report.beforeStop.live.media.bytesReceived > 0
      && report.stop.live.stopConfirmed && report.afterStop.live.cleanupComplete && !report.afterStop.live.error
      && [scope.firmware.main, scope.firmware.secondary, scope.homeBase.firmware.main, scope.homeBase.firmware.secondary].every(Boolean);
    if (!report.passed) throw new Error('Acceptance incomplete; inspect exact firmware, media, stop and cleanup evidence. Do not promote capability status.');
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    if (started) {
      try { report.finalStop = await json(`/api/v1/live-sessions/${started.live.sessionId}/stop`, {}); }
      catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    }
    await receiving?.catch(() => {});
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify(report, null, 2));
    console.log(directory);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
