const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULT_OUTPUT_ROOT = path.resolve(__dirname, '../output/jobs');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const TRANSITIONS = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
};
const copy = value => JSON.parse(JSON.stringify(value));
function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
}

// Instantiate once in the resident service, never in the submitting client.
class JobService {
  #jobs = new Map();
  #requests = new Map();
  #pending = [];
  #active = new Map();
  #unfinishedHomes = new Set();
  #fatalError = null;
  #scheduled = false;

  constructor({ worker, outputRoot = DEFAULT_OUTPUT_ROOT }) {
    if (typeof worker !== 'function') throw new TypeError('worker must be a function');
    this.worker = worker;
    this.outputRoot = path.resolve(outputRoot);
    fs.mkdirSync(this.outputRoot, { recursive: true });
    for (const entry of fs.readdirSync(this.outputRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = path.join(this.outputRoot, entry.name, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue; // A submission may stop before its first durable snapshot.
      const job = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      this.#jobs.set(job.jobId, job);
      this.#requests.set(job.requestId, job.jobId);
      if (!TERMINAL.has(job.state)) this.#unfinishedHomes.add(job.homeBaseId);
    }
  }

  get(jobId) {
    const job = this.#jobs.get(jobId);
    return job ? copy(job) : null;
  }

  list() {
    return [...this.#jobs.values()].sort((a, b) => a.sequence - b.sequence).map(copy);
  }

  submit({ requestId, homeBaseId, input = {} }) {
    requireString(requestId, 'requestId');
    const existing = this.#requests.get(requestId);
    if (existing) return this.get(existing);
    if (this.#fatalError) throw this.#fatalError;
    requireString(homeBaseId, 'homeBaseId');
    if (this.#unfinishedHomes.has(homeBaseId)) {
      throw new Error(`HomeBase ${homeBaseId} has unfinished jobs from a previous service; recovery is not implemented`);
    }
    const savedInput = copy(input);
    const jobId = randomUUID();
    const directory = path.join(this.outputRoot, jobId);
    fs.mkdirSync(directory); // Never reuse another job's output directory.
    const artifactsDir = path.join(directory, 'artifacts');
    const partialDir = path.join(directory, 'partial');
    fs.mkdirSync(artifactsDir);
    fs.mkdirSync(partialDir);
    const now = new Date().toISOString();
    const job = {
      jobId, requestId, homeBaseId, input: savedInput,
      sequence: Math.max(0, ...[...this.#jobs.values()].map(item => item.sequence)) + 1,
      state: 'queued', stage: 'queued', progress: 0,
      createdAt: now, updatedAt: now,
      artifactsDir, partialDir, metadataPath: path.join(directory, 'metadata.json'),
      artifacts: [], result: null, error: null,
    };
    this.#save(job);
    this.#requests.set(requestId, jobId);
    this.#pending.push(jobId);
    this.#schedule();
    return this.get(jobId);
  }

  cancelQueued(jobId, error = { code: 'CANCELLED', message: 'Cancelled before execution' }) {
    const job = this.#requireJob(jobId);
    if (job.state === 'cancelled') return this.get(jobId);
    if (job.state !== 'queued') throw new Error('Only queued jobs can be cancelled by Phase A controls');
    this.#transition(jobId, 'cancelled', {
      result: { outcome: 'cancelled' },
      error,
    });
    return this.get(jobId);
  }

  // Waits for this instance's accepted work, not unfinished jobs loaded from disk.
  async whenIdle() {
    do {
      await Promise.resolve();
      await Promise.all(this.#active.values());
    } while (this.#scheduled || this.#active.size || (!this.#fatalError && this.#pending.length));
    if (this.#fatalError) throw this.#fatalError;
  }

  #requireJob(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  #save(job) {
    const snapshot = copy(job);
    const temporary = `${snapshot.metadataPath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flush: true });
    // Windows file readers can briefly deny replacement. Keep the old snapshot
    // intact; retry only this atomic step, never delete the destination first.
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temporary, snapshot.metadataPath); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt === 5) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 10);
      }
    }
    this.#jobs.set(snapshot.jobId, snapshot);
  }

  #update(jobId, patch) {
    this.#save({ ...this.#requireJob(jobId), ...patch, updatedAt: new Date().toISOString() });
  }

  #transition(jobId, state, patch = {}) {
    const current = this.#requireJob(jobId).state;
    if (!TRANSITIONS[current]?.has(state)) throw new Error(`Invalid job transition: ${current} -> ${state}`);
    this.#update(jobId, { ...patch, state });
  }

  #requireRunning(jobId) {
    if (this.#requireJob(jobId).state !== 'running') throw new Error('Worker updates require a running job');
  }

  #context(jobId) {
    const job = this.get(jobId);
    return {
      job,
      artifactsDir: job.artifactsDir,
      partialDir: job.partialDir,
      updateProgress: (stage, progress) => {
        this.#requireRunning(jobId);
        requireString(stage, 'stage');
        if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
          throw new TypeError('progress must be a number between 0 and 1');
        }
        this.#update(jobId, { stage, progress });
      },
      registerArtifact: (relativePath, metadata = {}) => {
        this.#requireRunning(jobId);
        requireString(relativePath, 'artifact path');
        const directory = path.dirname(job.metadataPath);
        const absolute = path.resolve(directory, relativePath);
        const owned = [job.artifactsDir, job.partialDir].some(root => {
          const relative = path.relative(root, absolute);
          return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        });
        if (!owned) throw new Error('Artifacts must be inside this job directories: artifacts/ or partial/');
        if (!fs.statSync(absolute).isFile()) throw new Error('Artifact must be an existing file');
        const artifact = { path: path.relative(directory, absolute).split(path.sep).join('/'), metadata: copy(metadata) };
        const artifacts = this.#requireJob(jobId).artifacts.filter(item => item.path !== artifact.path);
        this.#update(jobId, { artifacts: [...artifacts, artifact] });
        return copy(artifact);
      },
    };
  }

  #schedule() {
    if (this.#scheduled || this.#fatalError) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      for (const jobId of [...this.#pending]) {
        const job = this.#requireJob(jobId);
        if (TERMINAL.has(job.state)) {
          this.#pending.splice(this.#pending.indexOf(jobId), 1);
          continue;
        }
        if (this.#active.has(job.homeBaseId)) continue;
        this.#pending.splice(this.#pending.indexOf(jobId), 1);
        const execution = this.#execute(jobId).catch(error => {
          // A persistence failure is a service fault; do not launch more side effects.
          this.#fatalError = error;
        }).finally(() => {
          this.#active.delete(job.homeBaseId);
          this.#schedule();
        });
        this.#active.set(job.homeBaseId, execution);
      }
    });
  }

  async #execute(jobId) {
    this.#transition(jobId, 'running', { stage: 'starting' });
    let result;
    try {
      result = await this.worker(this.#context(jobId));
      result = result === undefined ? {} : copy(result);
      if (!result || typeof result !== 'object' || Array.isArray(result)) result = {};
    } catch (error) {
      this.#transition(jobId, 'failed', {
        result: { outcome: 'failed' },
        error: { code: 'WORKER_FAILED', message: error?.message || String(error) },
      });
      return;
    }
    if (result.outcome === 'complete' && result.coverageVerified === true && result.validation?.passed === true) {
      this.#transition(jobId, 'succeeded', { stage: 'completed', progress: 1, result });
    } else if (result.outcome === 'cancelled') {
      this.#transition(jobId, 'cancelled', { result, error: result.error || { code: 'CANCELLED', message: 'Worker stopped' } });
    } else {
      const partial = result.outcome === 'partial';
      this.#transition(jobId, 'failed', {
        result: { ...result, outcome: partial ? 'partial' : 'failed' },
        error: result.error || {
          code: partial ? 'PARTIAL_RESULT' : 'VALIDATION_FAILED',
          message: partial ? 'Only a partial result is available' : 'Complete coverage and successful validation were not affirmed',
        },
      });
    }
  }
}

module.exports = { JobService, DEFAULT_OUTPUT_ROOT };
