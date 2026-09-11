const fs = require('node:fs');
const path = require('node:path');
const { ContinuousExportService } = require('../continuous-export.cjs');
const exporter = new ContinuousExportService({ outputRoot: process.argv[2], execute: async () => {}, createCapture: () => ({
  close() {},
  async captureRange(_serial, _begin, _end, directory) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'frames.bin'), 'retained interrupted bytes');
    process.send({ jobId: exporter.jobs.list()[0].jobId });
    await new Promise(() => { setInterval(() => {}, 1000); });
  },
}) });
exporter.submit({ requestId: 'one', homeBaseId: 'base', serial: 'camera',
  day: '2026-08-27', start: '16:30', end: '16:31', timezone: 'America/Toronto' });
