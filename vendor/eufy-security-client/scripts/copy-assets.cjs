const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function copyAssets(relative = '') {
  for (const entry of fs.readdirSync(path.join(root, 'src', relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) copyAssets(file);
    else if (entry.isFile() && /\.(proto|crt)$/.test(entry.name)) {
      const destination = path.join(root, 'build', file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, 'src', file), destination);
    }
  }
}
copyAssets();
