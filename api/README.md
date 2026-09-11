# Local HTTP API

`legacy-recording-routes.cjs` migrates the original page protocol. These routes serve the fixed page and **are not a stable v1 Agent API**. Start the local-only service with `node interface/server.cjs`.

| Method | Path | Purpose / request |
| --- | --- | --- |
| GET | `/` | Fixed login and recording page |
| GET | `/status` | Login state, device list, and `busy` |
| POST | `/login` | `{email,password,country}`, for example region `CA` |
| POST | `/verify` | `{code}`, an email verification code or CAPTCHA answer |
| POST | `/refresh` | `{}`, refresh devices |
| GET | `/recordings/status` | Query state, event clips, and saved files |
| POST | `/recordings/query` | `{serial,day,start,end,timezone?}`, date `YYYY-MM-DD`, time `HH:mm`, IANA timezone |
| POST | `/recordings/download` | `{recordId}`, selected from the latest query |
| GET / HEAD | `/recordings/media/:id` | Saved MP4 with HTTP Range support; `?download` requests an attachment |

POST requests require `Content-Type: application/json` and an `Origin` matching the actual local port. Host must also match. Recording queries and downloads require login. Query timezone defaults to `EUFY_RECORDING_TIMEZONE` or `America/Toronto`; an explicit IANA `timezone` overrides it. Nonexistent or ambiguous times are rejected, and start/end must fall on the same caller-local day. See the [shared time-window contract](../docs/recording-time-window.md) for the persisted representation and its distinction from actual footage coverage.

Asynchronous operations return `202 {ok:true}` to indicate acceptance; recording operations also include `timezone`, `window` and `coverage:null`. Callers must continue polling status to determine completion. `busy` is an in-process mutual exclusion flag, and conflicts return 409. Invalid parameters return 400; unauthenticated recording operations return 401. The current protocol has no independent job IDs, persistent queue, cancellation, or automatic retries. Restarting does not restore in-progress jobs.

Exports are written to `output/` at the repository root. At startup, event export manifests in that directory are read to restore the list of playable files. Only registered exported files are accessible through the media route. This migration does not copy private recordings, accounts, or sessions from the original repository.

`createServer({port, session, recordings, outputRoot})` supports dependency injection for tests; `port:0` uses an available port assigned by the operating system. Tests require neither an account nor a HomeBase.

Continuous recording support belongs to `capabilities/recordings/continuous.cjs` and is not yet exposed through these HTTP routes. The future v1 API needs shared capability descriptions, structured errors, job IDs, and progress contracts for both the CLI and Agent.

For localized interfaces, status payloads may include `messageI18n: {key, params}`, error responses may include `errorI18n`, and `diagnosticsI18n` entries align with `diagnostics`. These additive fields preserve the original `message`/`error` strings and data values. Unknown upstream errors have no translation metadata. See the [localization contract](../interface/i18n/README.md).
