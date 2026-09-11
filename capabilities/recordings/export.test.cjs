const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { runFfmpeg } = require('./export.cjs');

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
