// Offline transport fixture only; the product v1 API belongs to Issue #2.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { JobService } = require('../service.cjs');
let finish;
const clientExited = new Promise(resolve => { finish = resolve; });
const jobs = new JobService({
  outputRoot: process.argv[2],
  worker: async ({ artifactsDir, registerArtifact, updateProgress }) => {
    updateProgress('receiving', 0.5);
    await clientExited;
    fs.writeFileSync(path.join(artifactsDir, 'finished.txt'), 'finished after client exit');
    registerArtifact('artifacts/finished.txt', { kind: 'test-output' });
    return { outcome: 'complete', coverageVerified: true, validation: { passed: true } };
  },
});
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url === '/jobs') {
    const job = jobs.submit({ requestId: 'client-request', homeBaseId: 'fixture-home' });
    res.end(JSON.stringify(job));
  } else {
    res.end(JSON.stringify(jobs.get(req.url.split('/').pop())));
  }
});
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
process.on('message', async message => {
  if (message.type === 'client-exited') {
    finish();
    await jobs.whenIdle();
    process.send({ type: 'completed', job: jobs.list()[0] });
  }
  if (message.type === 'shutdown') server.close(() => process.disconnect());
});
