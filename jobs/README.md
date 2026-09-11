# Background Jobs — Phase A

`service.cjs` provides the minimum durable job contract for a resident service and the future recording worker in [Issue #7](https://github.com/ferryhe/eufy-agent-hub/issues/7). It is an internal CommonJS module, not an HTTP endpoint or CLI. The legacy page is unchanged. The v1 service adapter belongs to [Issue #2](https://github.com/ferryhe/eufy-agent-hub/issues/2).

## Ownership and submission

Create **one `JobService` instance per output root in the resident service process**. Clients submit through that service's transport; they must not instantiate their own worker. The caller can exit once submission returns. The resident process, its protocol session, and its worker continue independently. This is a single-owner local store; multiple writers or multiple resident services sharing an output root are unsupported.

```js
const { JobService } = require('./jobs/service.cjs');

// exportWorker is supplied by the resident service integration (Issue #7).
const jobs = new JobService({ worker: exportWorker });
const accepted = jobs.submit({
  requestId: 'caller-generated-request-id',
  homeBaseId: 'homebase-serial',
  input: { deviceId: 'camera-serial', start: '...', end: '...' },
});
// Respond with accepted.jobId; do not await the export in the request handler.
const snapshot = jobs.get(accepted.jobId);
```

`submit` synchronously persists the queued snapshot before returning. `requestId` and `homeBaseId` must be nonempty strings. Input must be JSON-serializable. Request identity is the **exact, case-sensitive `requestId`, global within this output root**. Whitespace is not normalized. Reusing that ID returns the original job and original input, even when the new HomeBase or input differs. It never retries, re-executes, or allocates new output directories, including after failure or cancellation. A caller that intends a separate operation must supply a new ID. Future adapters must handle their own caller/tenant namespace if needed.

`get(jobId)` returns a detached snapshot or `null`. `list()` returns detached snapshots in acceptance order. Callers cannot mutate durable state through these objects. `whenIdle()` waits for work submitted to the current instance and surfaces storage faults; it is useful for tests or a graceful drain, not required for submitting a job.

## State and scheduling

Allowed transitions are:

- `queued` → `running` or `cancelled`
- `running` → `succeeded`, `failed`, or `cancelled`
- Terminal states never transition again.

Snapshots include `jobId`, `requestId`, `homeBaseId`, `input`, `sequence`, `state`, `stage`, `progress`, timestamps, directory paths, `artifacts`, `result`, and `error`. Progress is a finite number in `[0, 1]`, defined by the worker across the operation. `stage` is a nonempty worker-defined name, such as `receiving`, `converting`, or `validating`. Failure preserves the last reported stage/progress; success sets `stage: 'completed'` and `progress: 1`.

All jobs on one HomeBase are conservatively treated as conflicting media work. They start in acceptance order, one at a time, without preemption. A failed or cancelled worker releases its slot only after its promise settles. Other HomeBases can progress while one worker waits. Workers must await all media activity before settling their promise; detached device work would violate this contract.

`cancelQueued(jobId)` cancels work that has not started. It is idempotent for a cancelled job, and rejects a running or other terminal job. A worker that has already stopped its own work can return `outcome: 'cancelled'`. There is no running-job stop signal or operator cancellation endpoint in Phase A.

## Worker context and output ownership

The worker receives `{ job, artifactsDir, partialDir, updateProgress, registerArtifact }`:

- `job` is its initial running snapshot, including the submitted input.
- `updateProgress(stage, progress)` persists the current stage and progress synchronously.
- `artifactsDir` holds outputs; `partialDir` holds raw captures, incomplete outputs, and diagnostics. These directories are created before submission returns and belong only to this job.
- `registerArtifact(relativePath, metadata = {})` records an existing file under `artifacts/` or `partial/`, relative to the job directory. It returns `{ path, metadata }`. Re-registering the same path updates that file's metadata. Registration never certifies completeness or validation. Register diagnostics as they become available, before any later operation can fail.

Use these assigned directories for every output; never write captures to shared fixed filenames. A future worker may include requested/actual ranges, first/last frame times, gap evidence, and decode details in the artifact metadata or result `details`. There is no recording pipeline in this module.

By default the store is `<repository>/output/jobs`, independent of the process working directory. Set constructor `outputRoot` to a different local directory when needed. Each UUID job directory contains `artifacts/`, `partial/`, and `metadata.json`. Metadata is the authoritative snapshot. Writes flush a temporary file before atomically replacing the snapshot; no mutable central request index is needed. Unregistered partial files are retained on failure, and duplicate submission does not change metadata or existing files. Use the same root location when reopening; moving an existing store is unsupported because snapshots contain absolute paths. This does not claim power-loss recovery or shared/network-filesystem coordination.

## Results and validation

A worker must return a JSON-serializable result object. The minimum consumption contract is:

| Worker result | Durable state | `result.outcome` |
|---|---|---|
| `{ outcome: 'complete', coverageVerified: true, validation: { passed: true }, details?: ... }` | `succeeded` | `complete` |
| `{ outcome: 'partial', details?: ..., validation?: ... }` | `failed` | `partial` |
| `{ outcome: 'failed', error?: { code, message }, details?: ... }` | `failed` | `failed` |
| `{ outcome: 'cancelled', error?: { code, message } }` after worker activity stops | `cancelled` | `cancelled` |
| Missing result, missing affirmative checks, or failed validation on a claimed complete result | `failed` | `failed` |
| Worker throws/rejects | `failed` | `failed` |

Consumers must inspect both `state` and `result.outcome`: a partial output is available for diagnostics or explicitly labelled partial consumption, but is **never a successful complete export**. A failed job retains the result's available evidence and a top-level `error` (`code`, `message`); thrown workers receive `WORKER_FAILED`. Missing completeness or validation receives `VALIDATION_FAILED`. Partial results receive `PARTIAL_RESULT` unless the worker supplies its own error.

Only the exact boolean `true` for **both** `coverageVerified` and `validation.passed`, together with `outcome: 'complete'`, can produce `succeeded`. A process exit code, end frame, file existence, or successful decode without verified coverage is insufficient. The recording worker is responsible for performing those checks truthfully; the scheduler does not itself inspect video.

## Persistence boundary and remaining work

Reopening the same output root restores snapshots and request identity. **It never resumes or retries old jobs.** Previously queued/running snapshots retain their state for inspection and their HomeBase blocks new submissions, with an explicit unfinished-job error. Duplicate requests still return their original snapshot. Other HomeBases remain available. `whenIdle()` excludes these historical unfinished jobs. Do not open a second instance against a live owner's root; reopen only after that owner stops.

[Issue #1](https://github.com/ferryhe/eufy-agent-hub/issues/1) remains open for Phase B: interruption/restart handling, safe recovery, running-job cancellation, explicit retry controls, and deeper operational diagnostics. Phase A does not claim crash resume, hardware acceptance, or full long-recording validation.

`service.test.cjs` covers durable reopen, identity, state transitions, FIFO/failure release, independent HomeBases, output ownership, and negative validation. Its offline fixtures start a real resident process and a separate HTTP submitting client; the worker is allowed to finish only **after the client has exited**, and its completed metadata is then read after the resident exits. These fixtures are not a parallel public API. Run `node --test jobs/service.test.cjs` or the repository's `npm test`.
