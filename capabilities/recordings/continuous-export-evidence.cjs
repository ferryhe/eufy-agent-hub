// Private acceptance runner, not the public CLI/API. One normal login, one fixed window.
const path = require('node:path');
const { LocalEufySession } = require('../auth/session.cjs');
const { createServer } = require('../../interface/server.cjs');
const { ContinuousExportService, OUTPUT } = require('./continuous-export.cjs');

function startExportEvidence(requestId, { port = 3188, session = new LocalEufySession(),
  service = new ContinuousExportService({ session }), onReady = () => {}, onSubmitted = () => {} } = {}) {
  if (Number(port) === 3187) throw new Error('Port 3187 is reserved for the existing service');
  if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('A unique requestId is required');
  const server = createServer({ port, session, outputRoot: path.join(OUTPUT, 'validation-login') });
  let timer, running = false, stopped = false, rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    rejectCompletion = reject;
    server.once('error', reject);
    server.start(() => {
      onReady(`http://127.0.0.1:${server.address().port}`);
      timer = setInterval(async () => {
        if (running || stopped || !session.authenticated || session.state.phase !== 'connected') return;
        try {
          const status = await fetch(`http://127.0.0.1:${server.address().port}/status`).then(response => response.json());
          if (running || stopped || status.busy) return;
          running = true; clearInterval(timer); server.close();
          const inventory = await session.api.getDevsListDecrypted();
          if (stopped) throw new Error('Validation cancelled before submission');
          const cameras = inventory.devices.filter(device => device.device_name === 'Drive Way' && device.device_model === 'T8600');
          if (cameras.length !== 1) throw new Error('Expected exactly one Drive Way T8600');
          const camera = cameras[0];
          const base = inventory.devices.find(device => device.device_sn === camera.parent_sn);
          if (base?.device_model !== 'T8030') throw new Error('Expected Drive Way on T8030 HomeBase 3');
          const accepted = service.submit({ requestId, serial: camera.device_sn, homeBaseId: base.device_sn,
            day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'America/Toronto' });
          onSubmitted(accepted);
          await service.whenIdle();
          resolve(service.get(accepted.jobId));
        } catch (error) { reject(error); }
      }, 250);
    });
  });
  completion.finally(() => { clearInterval(timer); if (server.listening) server.close(); }).catch(() => {});
  return { server, completion, stop: async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    if (server.listening) server.close();
    await service.shutdown();
    if (!running) rejectCompletion(new Error('Validation cancelled before login'));
  } };
}

if (require.main === module) {
  try {
    const runner = startExportEvidence(process.argv[2], { port: Number(process.env.EUFY_VALIDATION_PORT || 3188),
      onReady: url => console.log(`Sign in normally at ${url}; only Drive Way, August 27 16:30–16:50 America/Toronto will be submitted.`),
      onSubmitted: job => console.log(`Job ${job.jobId}; durable status: ${job.metadataPath}`) });
    const stop = () => runner.stop().catch(error => console.error(error.message));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    runner.completion.then(job => {
      console.log(`Job state: ${job.state}; media outcome: ${job.result?.outcome}; hardware acceptance requires evidence review.`);
      process.exit(job.result?.outcome === 'complete' ? 0 : job.result?.outcome === 'partial' ? 2 : 1);
    }, error => { console.error(error.message); process.exit(1); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { startExportEvidence };
