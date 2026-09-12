// Offline-only resident fixture; production Agent code never imports this module.
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../interface/server.cjs');
const { LocalEufySession } = require('../capabilities/auth/session.cjs');
const { DeviceType } = require('../adapters/eufy');
const window = { device: 'Synthetic camera', day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto', endDay: null };
const begin = 1787862600, end = begin + 60;

async function fixture(options = {}) {
  const root = path.join(__dirname, '..', 'output');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'eufy-agent-'));
  let valid = true;
  const cameras = options.devices || [{ device_sn: 'camera', device_name: 'Synthetic camera' }];
  const raw = [{ device_sn: 'base', device_model: 'T8030', device_type: DeviceType.HB3, device_name: 'Synthetic base', local_ip: '192.0.2.1' },
    ...cameras.map(d => ({ device_model: 'T8600', device_type: DeviceType.PROFESSIONAL_247,
      parent_sn: 'base', device_channel: 0, status: 0, ...d }))];
  const calls = { capture: 0, ranges: 0 };
  const session = new LocalEufySession(() => ({ init: async () => {}, estimateDomain: async () => {},
    hasValidSession: () => valid, login: async () => ({ code: 0 }), getDevsListDecrypted: async () => ({ devices: raw }) }));
  await session.login({ email: 'fixture@example.test', password: 'offline-only', country: 'CA' });
  const server = createServer({ port: 0, session, recordings: { close() {} }, outputRoot: directory,
    capabilityRecordsPath: path.join(directory, 'verification.json'),
    createRanges: () => ({ close() {}, listRange: async () => {
      calls.ranges++;
      if (options.offline) throw new Error('Synthetic device offline');
      return { videos: options.empty ? [] : [{ start_time: begin, stop_time: end }] };
    } }),
    exports: { outputRoot: path.join(directory, 'jobs'),
      execute: async (_executable, args, { stage, directory: jobDirectory }) => {
        fs.writeFileSync(path.join(jobDirectory, `${stage}.stdout.log`), stage === 'decode' ? `frame=${options.partial ? 20 : 1200}\nprogress=end\n` : '');
        fs.writeFileSync(path.join(jobDirectory, `${stage}.stderr.log`), '');
        if (options.failed) throw new Error('Synthetic conversion failure');
        if (stage === 'mux') fs.writeFileSync(path.join(args[1], 'timed.ts'), 'ts');
        if (stage === 'convert') fs.writeFileSync(args.at(-1), 'synthetic-media-bytes');
        if (stage === 'timeline') fs.writeFileSync(path.join(args[1], 'media-timeline.json'), JSON.stringify({ muxStartMs: 0,
          streams: { video: { count: options.partial ? 20 : 1200, firstTimestampMs: 0, lastTimestampMs: options.partial ? 950 : 59950, lastDurationMs: 50 } } }));
      },
      createCapture: () => ({ close() {}, captureRange: async (_serial, _begin, _end, destination) => {
        calls.capture++;
        if (options.gate) await options.gate;
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'frames.bin'), Buffer.alloc(1200));
        const capture = { begin, end, reachedEnd: true, ranges: [{ start_time: begin, stop_time: end }],
          segments: [{ begin, end, reachedEnd: true, boundaryTimestampMs: end * 1000 }], diagnostics: [],
          frames: Array.from({ length: 1200 }, (_, i) => ({ kind: 'video', timestamp: begin * 1000 + i * 50,
            keyFrame: i % 20 === 0, length: 1, offset: i, streamType: 1 })) };
        fs.writeFileSync(path.join(destination, 'frames.json'), JSON.stringify(capture));
        return capture;
      } }),
    },
  });
  await new Promise(resolve => server.start(resolve));
  return { directory, calls, session, url: `http://127.0.0.1:${server.address().port}`, expire: () => { valid = false; },
    async close() { await new Promise(resolve => server.close(resolve)); await server.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
module.exports = { fixture, window };
