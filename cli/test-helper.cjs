const path = require('node:path');
const { spawn } = require('node:child_process');

function cli(args, input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'eufy.cjs'), ...args], {
      env: { ...process.env, EUFY_URL: 'http://127.0.0.1:1', ...env }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout) : null }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

module.exports = { cli };
