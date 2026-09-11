const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContinuousExportService, OUTPUT } = require('./continuous-export.cjs');

test('configured PyAV/FFmpeg: synthetic complete, gapped and interrupted raw captures retain truthful outcomes',
  { skip: !process.env.EUFY_PYTHON || !process.env.EUFY_FFMPEG }, async t => {
    fs.mkdirSync(OUTPUT, { recursive: true });
    const directory = fs.mkdtempSync(path.join(OUTPUT, 'media-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const run = (executable, args) => {
      const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    };
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', 'color=black:s=128x72:r=20:d=60', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-x264-params', 'bframes=0:keyint=20:repeat-headers=1', '-f', 'h264', path.join(directory, 'synthetic.h264')]);
    run(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=mono', '-t', '60', '-c:a', 'aac', '-f', 'adts', path.join(directory, 'synthetic.aac')]);
    run(process.env.EUFY_PYTHON, [path.join(__dirname, 'fixtures/synthetic-continuous.py'), directory]);
    for (const mode of ['complete', 'gapped', 'interrupted']) {
      const exporter = new ContinuousExportService({ outputRoot: path.join(directory, mode), createCapture: () => ({
        close() {},
        async captureRange(_serial, _begin, _end, destination) {
          fs.mkdirSync(destination);
          fs.copyFileSync(path.join(directory, 'frames.bin'), path.join(destination, 'frames.bin'));
          const capture = JSON.parse(fs.readFileSync(path.join(directory, 'frames.json')));
          if (mode === 'gapped') capture.frames.splice(capture.frames.findIndex(frame => frame.kind === 'video' && frame.timestamp === 1787862602500), 1);
          if (mode === 'interrupted') {
            capture.reachedEnd = false; capture.segments[0].reachedEnd = false;
            capture.frames = capture.frames.filter(frame => frame.timestamp < 1787862630000);
            capture.diagnostics.push({ stage: 'capture', message: 'Synthetic disconnect halfway through capture' });
          }
          fs.writeFileSync(path.join(destination, 'frames.json'), JSON.stringify(capture));
          return capture;
        },
      }) });
      const accepted = exporter.submit({ requestId: mode, homeBaseId: 'synthetic-homebase', serial: 'synthetic-camera',
        day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto' });
      await exporter.whenIdle();
      const job = exporter.get(accepted.jobId);
      assert.equal(job.result.outcome, mode === 'complete' ? 'complete' : 'partial', JSON.stringify(job.error));
      assert.equal(job.state, mode === 'complete' ? 'succeeded' : 'failed');
      assert.equal(job.result.validation.passed, true);
      assert.equal(job.result.validation.timingPreserved, true);
      assert.equal(job.result.media.playable, true);
      assert.equal(job.result.validation.decode.videoFrames, mode === 'gapped' ? 1199 : mode === 'interrupted' ? 600 : 1200);
      if (mode === 'gapped') assert.ok(job.result.completeness.reasons.includes('video_timestamp_gap'));
      if (mode === 'interrupted') assert.ok(job.result.completeness.reasons.includes('end_not_reached'));
    }
  });
