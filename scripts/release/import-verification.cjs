const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { DeviceVerificationRepository, withVerificationLock } = require('../../capabilities/devices/verification-store.cjs');
const { scopeKey } = require('../../capabilities/devices/capabilities.cjs');

function importVerification(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) throw new Error('Source and destination must be different files.');
  const incoming = new DeviceVerificationRepository(source).read();
  const key = record => JSON.stringify([scopeKey(record.scope), record.capability]);
  return withVerificationLock(destination, () => {
    const repository = new DeviceVerificationRepository(destination);
    const current = repository.read();
    const existing = new Map(current.records.map(record => [key(record), record]));
    let imported = 0, skipped = 0;
    for (const record of incoming.records) {
      const previous = existing.get(key(record));
      if (previous) {
        if (!isDeepStrictEqual(previous, record))
          throw new Error(`Existing verification differs for ${record.scope.serial}/${record.capability}; nothing was imported.`);
        skipped++; continue;
      }
      existing.set(key(record), record); imported++;
    }
    if (imported) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ ...current, records: [...existing.values()] }));
        new DeviceVerificationRepository(temporary).read();
        fs.renameSync(temporary, destination);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    return { imported, skipped };
  });
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) throw new Error('Usage: Import-Verification.cmd <legacy-verification.json>');
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA is unavailable.');
  const result = importVerification(source, path.join(local, 'EufyAgentHub', 'devices', 'verification.json'));
  console.log(`Imported ${result.imported}; already identical ${result.skipped}.`);
}

module.exports = { importVerification };
