# Background Jobs — durable execution and operator controls

`service.cjs` provides the durable job contract used by the resident continuous recording worker. It is an internal CommonJS module; public cancellation and retry controls are documented in [API v1](../api/v1.md). The legacy page and CLI command set are unchanged.

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

`get(jobId)` returns a detached snapshot or `null`. `list()` returns detached snapshots in acceptance order. Callers cannot mutate durable state through these objects. `whenIdle()` waits for work submitted to the current instance, safely recovered queued work, and cancellation cleanup, and surfaces storage faults; it is useful for tests or a graceful drain, not required for submitting a job.

## State and scheduling

Allowed transitions are:

- `queued` → `running` or `cancelled`
- `running` → `succeeded`, `failed`, or `cancelled`
- Terminal states never transition again.

Snapshots include `jobId`, `requestId`, `homeBaseId`, `input`, `sequence`, `state`, `stage`, `progress`, timestamps, directory paths, `artifacts`, `result`, and `error`. New snapshots also include `retryOfJobId` (null for an original submission), `attempt` (1 for an original submission), and `cancellationRequestedAt` (null until requested). Progress is a finite number in `[0, 1]`, defined by the worker across the operation. `stage` is a nonempty worker-defined name, such as `receiving`, `converting`, or `validating`. Failure, cancellation and interruption preserve the last reported stage/progress; success sets `stage: 'completed'` and `progress: 1`.

All jobs on one HomeBase are conservatively treated as conflicting media work. They start in acceptance order, one at a time, without preemption. A failed or cancelled worker releases its slot only after its promise settles. Other HomeBases can progress while one worker waits. Workers must await all media activity before settling their promise; detached device work would violate this contract.

`cancelQueued(jobId)` retains its existing queued-only behavior. `cancel(jobId)` also accepts a running job: it first persists `cancellationRequestedAt` and an actionable `CANCELLED` reason, then aborts that worker's signal. The returned snapshot remains `running` until the worker finishes all owned cleanup. It then becomes `cancelled`, even if the worker returned a late complete result. Repeated cancellation is idempotent while stopping and after cancellation; other terminal states reject it. Cancellation freezes stage/progress while still allowing evidence registration. A worker that has stopped its own work may also return `outcome: 'cancelled'`.

`retry(jobId, { requestId })` explicitly creates a new execution for a failed (including interrupted) or cancelled job. It copies the original HomeBase and input, allocates a fresh job ID and output directories, records `retryOfJobId` and the previous attempt plus one, and joins the normal FIFO at acceptance time. It never changes the original snapshot or files. Successful or unfinished jobs cannot be retried. A reused request ID returns its original job across both `submit` and `retry`, including after restart; retry callers must use a new ID to create new work. Failed jobs never retry automatically.

## Worker context and output ownership

The worker receives `{ job, signal, artifactsDir, partialDir, updateProgress, registerArtifact }`:

- `job` is its initial running snapshot, including the submitted input.
- `signal` is the job's cancellation signal. Workers must check it before starting more work, stop receiving media on abort, and await every owned process/connection before returning. Cancellation is cooperative; an uncooperative injected worker keeps its slot until it settles.
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

## Restart and recovery boundary

Reopen only after the previous resident owner and its owned media processes have stopped. Opening another instance against a live owner remains unsupported. Reopening restores snapshots and request identity, then handles unfinished work before scheduling:

- `queued` work is safe to execute because the scheduler durably records `running` before invoking the worker. Recovered queued jobs retain their IDs, inputs and original FIFO order ahead of new submissions.
- `running` work has no resumable media checkpoint. It becomes `failed` with `error.code: 'JOB_INTERRUPTED'`, an explicit reason and a direction to inspect evidence and request a new retry. This is the interruption terminal outcome within the existing state contract. It is never silently replayed and cannot become successful on restart.
- A running job with persisted cancellation intent becomes `cancelled` on reopen. No further worker is started for it.
- All terminal snapshots remain unchanged. The last stage/progress, registered artifacts, partial files and saved result diagnostics survive interruption. New work on that HomeBase may proceed after recovery classification.

The continuous export adapter checks cancellation before and after Python/FFmpeg runtime checks, capture, mux, conversion, decode and timeline validation. Media subprocess cancellation waits for process `close`; capture cleanup is awaited. The API initializes recovery after session restoration when the server starts listening, and recovered work participates in the normal session/media ownership guards. A recovered job without a valid login fails explicitly with `LOGIN_REQUIRED`; it requires login and an explicit retry. Shutdown retains its existing behavior of stopping active exports and cancelling queued work.

`service.test.cjs` covers durable reopen, identity, cancellation intent and cleanup, explicit retry, queued recovery, interruption evidence, FIFO and independent HomeBases, output ownership, and negative validation. Its offline fixtures start a real resident process and a separate HTTP submitting client; the worker is allowed to finish only **after the client has exited**, and its completed metadata is then read after the resident exits. The continuous export tests also kill an isolated fixture resident during capture and reopen its store. These tests do not assert hardware acceptance, power-loss recovery, or resumption of an interrupted media process. Run `node --test jobs/service.test.cjs` or the repository's `npm test`.
