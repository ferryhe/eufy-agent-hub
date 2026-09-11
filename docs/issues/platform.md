# Platform capability issue drafts

## [api] Build a persistent service and structured v1 API

Existing: In-memory sessions and legacy login, event-query and download routes.
Gap: The current interface serves a single-page prototype and has no stable Agent/CLI contract.
Scope: Reuse capabilities to expose sessions, devices, capabilities, recording ranges, export jobs and artifacts, keeping interface and business logic separate.
Acceptance: Provide request/response definitions that can be validated; distinguish login-required, unsupported, offline and no-recording outcomes; use stable error codes; immediately return a `jobId` for long jobs; preserve working login flows; cover session status through jobs and file access with integration tests.
Dependencies: The basic jobs contract. API development can proceed through a job adapter without waiting for the UI or Agent.

## [jobs] Persist export jobs, queue operations, support cancellation and explicit retries

Existing: A legacy busy flag and capture functions whose callers wait for completion; no shared job implementation.
Scope: Job storage, state transitions, progress and media scheduling for each HomeBase within the persistent service.
Acceptance: A repeated `requestId` returns the original job; CLI/Agent exit does not stop jobs; cancellation stops reception and conversion and records the resulting state; restart recovers recoverable state or explicitly marks interruption; failed stages and partial artifacts are diagnosable; failed validation never reports completion. Automated tests cover state transitions, repeated submissions, restart, cancellation and queuing of conflicting operations.
Dependencies: Define a minimal job contract first; recording workers can be connected afterward.

## [cli] Provide a command-line client for the shared API

Existing: CommonJS capability calls and a local page; no installed CLI commands.
Scope: `auth`, `devices`, `recordings`, `jobs` and `artifacts` commands that call the same persistent service.
Acceptance: Help documents only supported commands; `--json` is machine-readable, with progress on stderr; failures have meaningful exit codes; login challenges can be completed interactively; exports return `jobId` and support waiting; service unavailability produces a clear message; CLI and HTTP validation use the same device and job results.
Dependencies: The v1 API and jobs.

## [agent] Integrate capability tools and complete natural-language recording exports

Existing: Capabilities and a planned tool inventory; no running Agent.
Scope: Wrap session, device, capability, recording-range, export-job and artifact tools, and integrate one selected Agent runtime. Video-content understanding and continuous monitoring are outside this issue.
Acceptance: Given a device, date and interval, the Agent completes a real export using a unique device ID and service-normalized time; progress can be queried and video returned; unknown devices, duplicate names, missing login, absent recordings and failed jobs are handled correctly; it neither duplicates the same job nor treats return code 0 as a completed file; provide offline tool tests and one real end-to-end validation record.
Dependencies: The v1 API, device capabilities, jobs and the complete continuous-export path.

## [live] Wrap and verify live-video capabilities

Existing: The vendor library includes `startLivestream`/`stopLivestream` and talkback protocol implementations, but the hub has no stable capability module.
Scope: Prioritize live-video start/stop, media output and lifecycle for the current cameras; expose talkback/RTSP according to verified support.
Acceptance: Available devices produce decodable media and stop normally; unsupported/offline outcomes are explicit; conflicts between live and historical operations are predictable and do not preempt another job; record device models, firmware and validation results; add stream-failure and cleanup tests.
Dependencies: The device-capability contract and media-connection management.
