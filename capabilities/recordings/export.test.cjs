const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { runFfmpeg } = require('./export.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('export uses persisted request timezone and writes it to the media and sidecar', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-export-time-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const originalTimezone = process.env.EUFY_RECORDING_TIMEZONE;
  process.env.EUFY_RECORDING_TIMEZONE = 'Europe/London';
  t.after(() => { if (originalTimezone === undefined) delete process.env.EUFY_RECORDING_TIMEZONE; else process.env.EUFY_RECORDING_TIMEZONE = originalTimezone; });
  const prefix = path.join(directory, '1'), destination = path.join(directory, 'event.mp4');
  const window = {version:1, input:{day:'2026-08-27', start:'16:30', end:'16:50', timezone:'Asia/Shanghai'},
    normalized:{start:'2026-08-27T08:30:00.000Z', end:'2026-08-27T08:50:00.000Z', timezone:'Asia/Shanghai'}};
  fs.writeFileSync(prefix + '.json', JSON.stringify({complete:true, window, metadata:{videoCodec:0,videoFPS:15},
    record:{record_id:1,start_time:'2026-08-27T08:31:00.000Z',end_time:'2026-08-27T08:32:00.000Z'}}));
  fs.writeFileSync(prefix + '.audio', '');
  const calls = [];
  t.mock.method(require('node:child_process'), 'spawn', (_program, args) => {
    calls.push(args);
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
    fs.writeFileSync(destination, 'fake mp4');
    process.nextTick(() => child.emit('close', 0));
    return child;
  });
  delete require.cache[require.resolve('./export.cjs')];
  t.after(() => { delete require.cache[require.resolve('./export.cjs')]; });
  const { exportRecording } = require('./export.cjs');
  const clip = await exportRecording(prefix, destination);
  assert.equal(clip.timezone, 'Asia/Shanghai');
  assert.deepEqual(clip.window, window);
  assert.equal(clip.coverage, null);
  assert.ok(calls[0].includes('recording_timezone=Asia/Shanghai'));
  assert.deepEqual(JSON.parse(fs.readFileSync(destination + '.json')), clip);
  const legacy = JSON.parse(fs.readFileSync(prefix + '.json'));
  delete legacy.window;
  fs.writeFileSync(prefix + '.json',JSON.stringify(legacy));
  const oldClip = await exportRecording(prefix,destination);
  assert.equal(oldClip.timezone,'America/Toronto','old raw context must not be reinterpreted using a changed default');
  assert.equal(oldClip.window,null);
  assert.equal(JSON.parse(fs.readFileSync(destination + '.json')).timezone,'America/Toronto');
});

test('missing configured FFmpeg produces an actionable error', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-ffmpeg-'));
  const original = process.env.EUFY_FFMPEG;
  t.after(() => {
    if (original === undefined) delete process.env.EUFY_FFMPEG;
    else process.env.EUFY_FFMPEG = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.EUFY_FFMPEG = path.join(directory, 'missing-ffmpeg');
  await assert.rejects(runFfmpeg(['-version']), error => {
    assert.match(error.message, /EUFY_FFMPEG.*PATH/);
    assert.equal(error.i18n.key, 'service.recordings.ffmpegMissing');
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});
