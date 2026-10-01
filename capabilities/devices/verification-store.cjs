const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Ajv = require('ajv');
const { recordCapability } = require('./capabilities.cjs');
const { store } = require('./schemas.cjs');

const DEFAULT_RECORDS_PATH = path.resolve(__dirname, '../../output/devices/verification.json');
const ajv = new Ajv({ strict: false });
const validate = ajv.compile(store);
function validateSnapshot(snapshot) {
  if (!validate(snapshot)) throw new Error(`Invalid device verification store: ${ajv.errorsText(validate.errors)}`);
  for (const record of snapshot.records) recordCapability([], record);
  for (const observation of snapshot.reachability || []) {
    if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error('Reachability requires a valid observation date.');
  }
}

function withVerificationLock(filename, action) {
  const lock = `${path.resolve(filename)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const busy = new Error(`Device verification store is busy: ${path.resolve(filename)}`);
    busy.code = 'VERIFICATION_STORE_BUSY';
    throw busy;
  }
  try { return action(); }
  finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

// One resident owner; synchronous read/modify/replace also lets its local writers reopen the same file.
class DeviceVerificationRepository {
  constructor(filename = DEFAULT_RECORDS_PATH) {
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('Device verification path must be nonempty.');
    this.path = path.resolve(filename);
  }

  read() {
    let source;
    try { source = fs.readFileSync(this.path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: [], reachability: [] };
      throw error;
    }
    const snapshot = JSON.parse(source);
    validateSnapshot(snapshot);
    return { ...snapshot, reachability: snapshot.reachability || [] };
  }

  record(observation) {
    return withVerificationLock(this.path, () => {
      const snapshot = this.read();
      snapshot.records = recordCapability(snapshot.records, observation);
      return this.#save(snapshot);
    });
  }

  observeReachability(observation) {
    return withVerificationLock(this.path, () => {
      const snapshot = this.read();
      snapshot.reachability = [...snapshot.reachability.filter(item => item.serial !== observation.serial), structuredClone(observation)];
      return this.#save(snapshot);
    });
  }

  #save(snapshot) {
    validateSnapshot(snapshot);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { flag: 'wx', flush: true });
      fs.renameSync(temporary, this.path);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return structuredClone(snapshot);
  }
}

module.exports = { DeviceVerificationRepository, DEFAULT_RECORDS_PATH, withVerificationLock };
