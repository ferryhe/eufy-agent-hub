const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageRoot = process.argv[2] || path.resolve(__dirname, '../..');
const { createServer } = require(path.join(packageRoot, 'interface/server.cjs'));

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-package-http-'));
  const session = { authenticated: false, state: { phase: 'login_required', devices: [], diagnostics: [] },
    isAuthenticated: () => false, restore() {}, close() {} };
  const server = createServer({ port: 0, dataRoot, session, recordings: { close() {} } });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.start(resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const app = await fetch(origin + '/app/'), html = await app.text();
    if (app.status !== 200 || !html.includes('id="root"')) throw new Error('Packaged React UI did not start.');
    const api = await fetch(origin + '/api/v1/session'), body = await api.json();
    if (api.status !== 200 || typeof body.authenticated !== 'boolean') throw new Error('Resident session endpoint is invalid.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.shutdown();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
