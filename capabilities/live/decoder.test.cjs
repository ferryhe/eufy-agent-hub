const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { createDecoder } = require('./decoder.cjs');

function childFixture() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [] });
  child.kill = signal => { child.kills.push(signal || 'SIGTERM'); return true; };
  return child;
}
test('decoder parses split JPEG frames, discards stderr and awaits child close', async () => {
  const child = childFixture(), video = new PassThrough(), frames = [], errors = [];
  const decoder = createDecoder({ video, metadata: { videoCodec: 0 }, onFrame: frame => frames.push(frame),
    onError: error => errors.push(error), spawnProcess: (_path, args, options) => {
      assert.equal(args.includes('h264'), true); assert.equal(options.windowsHide, true); return child;
    } });
  child.stderr.write('private-decoder-stderr');
  child.stdout.write(Buffer.from([255])); child.stdout.write(Buffer.from([216, 1, 255])); child.stdout.write(Buffer.from([217]));
  assert.equal(frames.length, 1); assert.deepEqual([...frames[0]], [255,216,1,255,217]);
  let finished = false; const closed = decoder.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  child.emit('close', 0); await closed; assert.equal(finished, true); assert.deepEqual(errors, []);
  assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(video.listenerCount('data'), 0);
});

for (const mode of ['missing', 'invalid', 'exit']) test(`decoder ${mode} returns only a structured safe error`, async () => {
  const child = childFixture(), errors = [];
  const decoder = createDecoder({ video: new PassThrough(), metadata: { videoCodec: 0 }, onFrame: () => assert.fail(),
    onError: error => errors.push(error), spawnProcess: () => child });
  if (mode === 'missing') child.emit('error', Object.assign(new Error('private-path'), { code: 'ENOENT' }));
  if (mode === 'invalid') child.stdout.write(Buffer.from([0,255,217]));
  child.emit('close', 1); await decoder.close();
  assert.equal(errors.length, 1); assert.equal(errors[0].code, mode === 'missing' ? 'LIVE_RUNTIME_UNAVAILABLE' : 'LIVE_DECODER_FAILED');
  assert.equal(errors[0].message.includes('private'), false);
});

test('configured FFmpeg decodes actual synthetic H264 to multiple JPEG frames without media files',
  { skip: !process.env.EUFY_FFMPEG }, async t => {
    const video = new PassThrough(), frames = []; let resolveFrames, rejectFrames;
    const ready = new Promise((resolve, reject) => { resolveFrames = resolve; rejectFrames = reject; });
    const timeout = setTimeout(() => rejectFrames(new Error('synthetic decode timeout')), 15000);
    const decoder = createDecoder({ video, metadata: { videoCodec: 0 }, onFrame: frame => {
      frames.push(Buffer.from(frame)); if (frames.length >= 3) resolveFrames();
    }, onError: rejectFrames });
    const producer = spawn(process.env.EUFY_FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-tune', 'zerolatency', '-g', '15', '-f', 'h264', 'pipe:1'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    producer.stderr.resume(); producer.on('error', rejectFrames); producer.stdout.pipe(video);
    const producerClosed = new Promise(resolve => producer.once('close', resolve));
    t.after(async () => { clearTimeout(timeout); producer.stdout.unpipe(video); producer.kill(); await producerClosed; video.destroy(); await decoder.close(); });
    await ready; assert.ok(frames.every(frame => frame.length > 100));
    const sample = frames.slice();
    const proof = await require('./sample.cjs').decodeSample(sample);
    assert.deepEqual(proof, { passed: true, decodedFrames: sample.length, exitCode: 0, childClosed: true });
  });
