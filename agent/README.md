# Recording Agent

One ordinary OpenAI Agents SDK `Agent` runs in the caller's Node 24 process. Deterministic tools use resident HTTP directly. The resident owns authentication, time normalization, capture, jobs and artifacts. No shell CLI, hosted compute, separate protocol client, monitoring, video understanding or public cancellation/retry tool is involved.

## Run

Install/build with `npm ci`, `npm run setup`, `npm run build`. Start the resident separately with `npm start`, then complete its normal login page at `/`. Keep passwords and challenge answers on that page. Configure `OPENAI_API_KEY` in the process environment or an ignored env file. `EUFY_AGENT_MODEL` selects a tool-capable OpenAI model; default `gpt-4.1-mini`.

```sh
node --env-file=.env.local agent/main.cjs --url http://127.0.0.1:3187
```

Enter `Export Drive Way on 2026-08-27 from 16:30 to 16:50, America/Toronto.` Follow-up lines share conversation and export identity. `/exit` exits the observer. `--message "..."` sends one turn and exits. Output is JSON containing model text and known request/job IDs.

The normal entry stores history, normalization receipts and request identities at ignored `output/agent/session.json`. `--state FILE` or `EUFY_AGENT_STATE` selects another conversation. Retain the same state when resuming after network/model failure. A file belongs to one resident origin and **one owning process**; do not open it concurrently in separate processes. It contains private device/conversation data; model tools never expose resident passwords or challenge values.

`createRecordingAgent({baseUrl, statePath, model})` in `runtime.cjs` is the reusable entry for later interface work. `turn(text)` keeps local history and rejects concurrent turns. Without `statePath`, retain the object for follow-ups. Calls use Responses with tracing and response storage disabled, no transport retries, at most 8 model turns, 1200 output tokens per call and a 120-second run deadline. `EUFY_AGENT_MAX_TURNS` (1–16) and `EUFY_AGENT_MAX_TOKENS` (1–4000) override these limits. HTTP timeout defaults to 10 seconds. User input is limited to 16000 characters per turn.

## Tools and semantics

Tools: `session_status`, `devices_list`, `device_resolve`, `device_capability`, `recording_ranges`, `recording_export`, `job_get`, `job_artifacts`. Responses are checked against the resident's `/api/v1/contract`. Authority: [v1 API](../api/v1.md).

Names match exactly ignoring case/surrounding whitespace. Unknown/repeated names require clarification. The runtime checks that the caller named the selected device/serial, or that the service uniquely resolved its ID from a caller-supplied name. That saved selection can pass to later tools and resumed turns; listing candidates or an ambiguous lookup never grants a selection. The model cannot silently pick an ambiguous candidate. Eligibility (`recordingExport.supported`) is separate from firmware-specific verification. Unknown Live is not an export blocker.

`recording_ranges` passes local day/start/end/timezone to the service and retains original input, normalized UTC and effective timezone. Omitted timezone uses the service default, which the Agent must disclose. Missing/ambiguous dates require clarification; invalid zones, DST gaps/repeated hours and unsupported cross-midnight windows preserve service errors. No Agent timezone engine exists. No footage returns `NO_RECORDING` without a receipt.

`recording_export` accepts only a saved range receipt ID. Its unique serial and normalized UTC interval identify this session's request. A fixed request ID and original body are saved **before** HTTP submission. Concurrent/repeated tools and later turns reuse that identity, including after a lost response. Failed/cancelled jobs do not automatically create another export. Existing receipts, jobs and artifacts can be read after logout.

`complete:true` requires service `state:succeeded`, `outcome:complete`, `coverageVerified:true` and `validation.passed:true`. Playable partial remains `status:partial` even though its service job state is `failed`. Results preserve the whole job, coverage, validation, diagnostics and errors. `videos` lists only registered playable, validated artifacts; the full artifact list retains other diagnostics.

Long observation uses HTTP without model calls:

```sh
node agent/main.cjs --url http://127.0.0.1:3187 --wait JOB_ID --wait-ms 30000
```

Or use `client.wait({jobId, timeoutMs, signal, onProgress})`. Each wait is bounded to one hour. Timeout or observer abort leaves resident work running; query it later. Model timeout also retains previously submitted jobs.

## Validation

The [2026-09-12 real validation record](VALIDATION.md) documents one new model → tools → resident → hardware job → registered video run. It produced a playable **partial** video: validation passed, coverage was not verified, and complete remained false. The configured offline suite passed 226 tests with zero skips.

`npm test` includes isolated actual-resident fixtures with synthetic capture/media adapters and the installed SDK's public `ScriptedModel`. Cases cover uniqueness, eligibility, service normalization/errors, login isolation, no footage/offline, durable replay, complete/partial/failed results, observer exit and SDK tool execution across turns. Synthetic adapter success is not real hardware/full-decode evidence; existing configured repository media tests cover real PyAV/FFmpeg.

```sh
node agent/validate.cjs --evidence-dir ABSOLUTE_PRIVATE_DIRECTORY
```

This runs bounded real model → tools → isolated resident → synthetic partial job → registered artifact. It never connects to an existing resident in default mode. Its summary separates `synthetic-http`, model access and hardware not run. Model authentication, paid generation and hardware capture are separate gates.

Hardware validation requires fresh independent review and coordinator/user normal login. The runner never starts a service or signs in. After authorization, start an independent resident and run:

```sh
node --env-file=.env.local agent/validate.cjs --hardware --url http://127.0.0.1:3190 --evidence-dir ABSOLUTE_PRIVATE_DIRECTORY
```

The runner permits only Drive Way T8600 linked to T8030, **2026-08-27 16:30–16:50 America/Toronto**, one export identity. It rejects port 3187, changed windows/devices and a second identity. Unretained footage is reported without expanding the window. Observation is bounded to 40 minutes and download to 3 minutes. Reuse the same evidence directory after a lost response. The sanitized summary excludes account, serial, IP, key and video content. `private-agent-state.json`, `private-tools.json`, `private-result.json` and `private-video.mp4` are private evidence; do not publish them. Results remain honestly complete/partial/failed. The recorded real run and retained private evidence are summarized in [VALIDATION.md](VALIDATION.md); complete coverage was not achieved.

Sources checked: [SDK guide](https://developers.openai.com/api/docs/guides/agents/sdk), [JS quickstart](https://openai.github.io/openai-agents-js/guides/quickstart/), installed SDK 0.18.0 declarations/public testing exports and [model reference](https://developers.openai.com/api/docs/models/gpt-4.1-mini).
