# Resident HTTP CLI

The `eufy` command uses the same running [v1 service](../api/v1.md) as the local page. It never starts a service, creates an independent account session, or calls the protocol library. Node.js 24 or later is required.

## Run and install

From the repository root, install/build the service as described in the root README, then run `npm start` in a separate terminal. Run the CLI directly, or install its command locally:

```sh
node cli/eufy.cjs help
npm install --global .
eufy help
```

The default resident address is `http://127.0.0.1:3187`. Use `--url http://127.0.0.1:3188` or `EUFY_URL` for a different service. `EUFY_PORT` configures the server only. Every command uses the selected resident session and store.

## Commands

```text
auth status
auth login [--email EMAIL --password PASSWORD --country CA]
auth verify [--code CODE]
auth refresh
auth logout
devices list
devices get SERIAL
devices capabilities SERIAL CAPABILITY
recordings ranges SERIAL --day DAY --start HH:mm --end HH:mm [--timezone IANA] [--end-day DAY]
recordings export --request-id ID [--serial SERIAL --day DAY --start HH:mm --end HH:mm --timezone IANA --end-day DAY]
jobs get JOB_ID
jobs wait JOB_ID
artifacts list JOB_ID
artifacts get JOB_ID ARTIFACT_ID --output FILE
```

Global options may appear before or after the command: `--json`, `--url`, `--timeout MS`, `--poll-interval MS`, `--interactive`, `--no-interactive`, `--help`. Timeout defaults to 300000 milliseconds, with each HTTP request limited to at most 30000 milliseconds. Polling defaults to 1000 milliseconds. There is no public cancellation, retry, evidence-writing, live-video or event-recording command in this version.

## Shared authentication

```sh
eufy auth login
eufy --json auth status
eufy auth verify --code 123456
eufy auth refresh
eufy auth logout
```

`auth login` prompts for email, password and country in a terminal. Input is not echoed. It polls the service after asynchronous HTTP 202 acceptance and follows image and email challenges. During an image challenge it writes the current image to a temporary file and prints its path on stderr; open that image and type the answer. The temporary image remains available for inspection and can be deleted after use. The same challenge is also visible on the resident login page.

If a challenge is already pending, `auth login` continues it without replacing the session. `auth verify` submits an answer to that same session. Wrong answers can prompt again. `--no-interactive` or ordinary piped execution returns the pending session unchanged with exit 4; continue later with `auth verify --code CODE`. `--interactive` explicitly enables prompts for scripted stdin. Prompts and progress always use stderr, including with `--json`.

HTTP acceptance alone never establishes successful authentication. `auth status` returns exit 4 when the resident session is unauthenticated; `auth logout` returns 0 after the accepted logout settles. Known expiry requires a new login for cloud operations. Existing local jobs and artifacts remain readable after logout or expiry.

A confirmed logout returns immediately even if an already-owned recording keeps the service busy; that capture continues. An existing authenticated session also satisfies `auth login` (or `auth verify` without submitting a code) without waiting for recording work or replacing the session. Newly accepted login, verification and refresh requests still follow their authentication work to completion.

## Continuous recording workflow

```sh
eufy --json devices list
eufy --json devices capabilities CAMERA_SERIAL continuousRecordingExport
eufy --json recordings ranges CAMERA_SERIAL --day 2026-08-27 --start 16:30 --end 16:31 --timezone America/Toronto
eufy --json recordings export --request-id driveway-20260827-1630 --serial CAMERA_SERIAL --day 2026-08-27 --start 16:30 --end 16:31 --timezone America/Toronto
eufy --json jobs get JOB_ID
eufy --json jobs wait JOB_ID
eufy --json artifacts list JOB_ID
eufy --json artifacts get JOB_ID ARTIFACT_ID --output recording.mp4
```

Export prints the accepted response containing `job.jobId` as soon as the service durably queues it. It does not wait for capture or conversion. The submitting process exits while work continues in the resident service; use the separate `jobs wait` command to follow it. A wait timeout ends only the CLI wait. It returns `WAIT_TIMEOUT` and `lastResult`, which preserves the last observed HTTP body.

The request ID is required and case-sensitive. For a new export, provide serial, day, start and end; the service validates them. To retrieve an existing submission, `recordings export --request-id ID` may omit all other fields. It returns the original job, including after logout, and never starts a retry. Use a new ID for new work.

`artifacts get` first reads the registered artifact list and follows the returned URL. It streams the file to the explicit `--output` path (replacing an existing file), then returns `{jobId, artifact, output}`. It never writes file bytes to stdout. A successful download has exit 0 even for a partial or diagnostic artifact: inspect the unchanged artifact's `outcome`, `playable` and `validated` fields. A file downloaded from a partial job remains partial.

The CLI sends time strings unchanged and returns the service's normalized window unchanged. The service owns IANA timezone defaults, UTC conversion, DST rejection, same-day limits, device eligibility and recording completeness. Missing timezone uses the server's `EUFY_RECORDING_TIMEZONE` or `America/Toronto`. Range `coverage:null` does not prove complete footage. Device `protocol_hint`, `unknown`, raw inventory status, firmware and dated evidence are never promoted to verified/online by the CLI.

## Output and exit contract

With `--json`, stdout contains exactly one JSON result and a newline. Ordinary HTTP results and errors retain the response body unchanged; `jobs get`, `jobs wait` and request-ID reuse inspect nested job errors even under HTTP 200. Without `--json`, results are pretty-printed JSON; help is plain text. Progress, prompts, paths and hints use stderr.

| Exit | Meaning |
| --- | --- |
| 0 | Successful HTTP operation, accepted export, completed job or saved artifact |
| 2 | Invalid CLI command/options (`CLI_USAGE`) |
| 3 | Resident service connection/request unavailable (`SERVICE_UNAVAILABLE`) |
| 4 | Unauthenticated, pending/failed login, or job `LOGIN_REQUIRED` |
| 5 | Missing device, job or artifact |
| 6 | Range result `NO_RECORDING` |
| 7 | Terminal `PARTIAL_RECORDING` |
| 8 | Failed/cancelled export, including `EXPORT_FAILED` / `JOB_CANCELLED` |
| 9 | Other HTTP error, including invalid windows, busy/unsupported/unavailable devices |
| 10 | Client file/stream error (`CLIENT_IO_ERROR`) or invalid JSON response (`INVALID_RESPONSE`) |
| 11 | Auth/job polling deadline (`WAIT_TIMEOUT`); resident work is unaffected |

A service connection failure differs from a reachable service returning `DEVICE_UNAVAILABLE`: the former is exit 3, the latter preserves the HTTP error with exit 9. Original server codes and messages are retained. Partial/failed jobs retain their complete pipeline diagnostics and artifacts.

## Validation boundary

CLI tests execute real child processes against both isolated HTTP fixtures and the injected actual resident server. They cover shared auth/challenges, exact device/time/job results, durable submission, post-logout reads and partial/failed outcomes. Configured tests run a synthetic 60-second video through real PyAV/FFmpeg, full decode and CLI artifact download. This is offline evidence, not new account or HomeBase hardware acceptance.
