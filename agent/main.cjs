#!/usr/bin/env node
const path = require('node:path');
const readline = require('node:readline/promises');
const { createRecordingAgent } = require('./runtime.cjs');
const { RecordingTools } = require('./tools.cjs');

async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      console.log('Usage: node agent/main.cjs [--url ORIGIN] [--state FILE] [--message TEXT]\n       node agent/main.cjs --wait JOB_ID [--wait-ms 30000] [--url ORIGIN]\nWithout --message, reads conversation lines. /exit closes the observer. Complete normal login on the resident page.');
      return;
    }
    const names = { '--url': 'baseUrl', '--state': 'statePath', '--message': 'message', '--wait': 'jobId', '--wait-ms': 'waitMs' };
    if (!names[args[i]] || !args[i + 1]) throw new Error('Unknown or missing option. Use --help.');
    options[names[args[i]]] = args[++i];
  }
  options.statePath ||= process.env.EUFY_AGENT_STATE || path.join(__dirname, '..', 'output', 'agent', 'session.json');
  if (options.jobId) {
    const client = new RecordingTools(options);
    console.log(JSON.stringify(await client.wait({ jobId: options.jobId, timeoutMs: Number(options.waitMs ?? 30000) }), null, 2));
    return;
  }
  const runtime = createRecordingAgent(options);
  if (options.message) { console.log(JSON.stringify(await runtime.turn(options.message), null, 2)); return; }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Recording assistant. Use the resident page for login. /exit closes this observer.');
  try {
    for await (const text of terminal) {
      if (text.trim() === '/exit') break;
      if (!text.trim()) continue;
      try { console.log(JSON.stringify(await runtime.turn(text), null, 2)); }
      catch (error) { console.error(JSON.stringify({ error: 'AGENT_RUN_FAILED', code: error.code ?? error.name,
        message: 'Agent turn failed. Existing resident jobs and saved request identities remain available.' })); }
    }
  } finally { terminal.close(); }
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ error: 'AGENT_RUN_FAILED', code: error.code ?? error.name,
    message: 'Agent could not complete. Check model access, resident service and local state configuration; existing jobs are retained.' }));
  process.exitCode = 1;
});
module.exports = { main };
