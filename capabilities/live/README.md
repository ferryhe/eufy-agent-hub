# Live video and connection lifecycle

The v1 resident exposes a bounded video session for the existing T8600 camera / T8030 HomeBase LAN path. `liveVideo` is the existing capability catalog key (the live video capability); its `protocol_hint` status permits a bounded attempt, never a claim of hardware verification. Explicit `unsupported` and `unknown` states refuse execution. Observations stay associated with the exact camera, HomeBase, channel and firmware. Talkback and RTSP default to `unknown` and require their own evidence. This implementation provides video only.

On 2026-09-12, root accepted one inventory-bound T8600 / T8030 camera, HomeBase, channel and firmware scope: all 29 sampled video frames fully decoded, the matching stop was confirmed, all protocol/media/decoder resources closed, and a same-HomeBase export returned `SERVICE_BUSY` without preemption. The reviewed proof was then recorded as `liveVideo: verified` for that exact scope. This does not verify other devices or firmware, talkback or RTSP.

Automated protocol tests, synthetic FFmpeg tests and the host's `--run` phase do not change the device verification repository. The separate `--record-proof` step below records only independently accepted hardware evidence for its exact scope.

## Public use

All clients use the same [v1 API](../../api/v1.md), including CLI HTTP callers, Agent integrations and the interface. No client constructs a protocol connection.

1. `POST /api/v1/live-sessions` with `{"requestId":"unique-client-request","serial":"<inventory serial>","maxDurationMs":60000}`. `maxDurationMs` defaults to 60000 and accepts 1000–60000 ms.
2. Wait for `201 {live,reused:false}`. It requires the matching start-command response and a decoded JPEG frame. Repeating the exact request returns `200` with the same session; changing the serial or duration for that request ID returns `LIVE_REQUEST_CONFLICT`. Closed request IDs remain bound until the resident restarts; use a new ID for a new session.
3. `GET /api/v1/live-sessions/:sessionId` returns state, stable ownership, capability scope, safe error, command observations, decoded-frame count and resource state.
4. `GET /api/v1/live-sessions/:sessionId/media` streams `multipart/x-mixed-replace; boundary=frame` JPEG frames. A browser can use this URL as an image source. The preview is video only, scaled to 960 pixels wide at up to five frames per second. Only one media consumer is admitted; a duplicate gets `LIVE_CLIENT_CONFLICT`. Slow consumers drop subsequent preview frames while their bounded HTTP buffer drains.
5. `POST /api/v1/live-sessions/:sessionId/stop` with `{}` waits for cleanup and returns the final state. Repeated stop is idempotent. `stopConfirmed` means a matching stop-command response, not merely a locally emitted stream-stop event.

States are `opening`, `streaming`, `stopping`, `stopped` and `failed`. POST-response disconnect while a fresh start is pending cancels that start. Closing the media response stops its session. A caller that never opens the media URL is stopped after ten seconds. The requested maximum duration also stops the session. Token expiry is checked every second. Missing decoded media times out after five seconds once frames begin; initial media may take fifteen seconds. Connection establishment has a fifty-second controller deadline and uses the existing optional cancellable LAN connect path. Inventory and command waits are also bounded. Stop-command timeout is five seconds.

Cleanup destroys input video/audio streams, awaits the decoder child close, awaits P2P close, destroys the camera, clears station reconnect timers and closes the disposable UDP socket without triggering the vendor's socket recreation callback. It also clears local timers and listeners. A cleanup failure remains `LIVE_CLEANUP_FAILED` and holds admission: the service never declares a potentially active owner free. Status reports `resources.protocolClosed`, `connectionClosed`, `decoderClosed`, `streamsClosed` and `cleanupComplete` separately.

## Shared media ordering

The existing v1 `pending`/active guards and `JobService` HomeBase FIFO remain the only resident media admission mechanism. Live sessions participate in those guards, just like playback sessions. While live is opening, streaming or cleaning up, new exports/retries, playback sessions, recording-range queries and legacy recording work are rejected with `SERVICE_BUSY`. Login, verification and refresh also wait. An already known export request ID may still retrieve its job. Logout closes live before clearing the shared login. Shutdown closes live before waiting for streaming HTTP responses to drain.

Live start is rejected while accepted export work is queued/running or another resident media operation owns admission. Exports retain their existing per-HomeBase FIFO behavior among themselves. Live is conservatively exclusive across the one-account resident, even for another HomeBase. No silent preemption, queue insertion for live or separate lock is introduced. Multiple resident processes concurrently using the same account/HomeBase remain unsupported.

## Stable failures

| Condition | Code |
| --- | --- |
| Unknown session/device | `LIVE_SESSION_NOT_FOUND` / `DEVICE_NOT_FOUND` |
| Unsupported path or capability / unknown capability | `LIVE_UNSUPPORTED` / `LIVE_CAPABILITY_UNKNOWN` |
| Explicit offline/unavailable inventory observation | `LIVE_DEVICE_OFFLINE` |
| Login expired/replaced | `UNAUTHENTICATED` |
| Changed owner, channel or firmware scope | `LIVE_SCOPE_CHANGED` |
| Connection setup / active connection loss | `LIVE_CONNECTION_FAILED` / `LIVE_CONNECTION_LOST` |
| Command rejected / command timeout | `LIVE_COMMAND_REJECTED` / `LIVE_COMMAND_TIMEOUT` |
| Missing decoded video | `LIVE_MEDIA_TIMEOUT` |
| Missing FFmpeg / decode failure | `LIVE_RUNTIME_UNAVAILABLE` / `LIVE_DECODER_FAILED` |
| Cleanup failure / closed media access | `LIVE_CLEANUP_FAILED` / `LIVE_INACTIVE` |

FFmpeg uses `EUFY_FFMPEG` or `ffmpeg` on PATH. Source media, JPEGs, account payloads and FFmpeg stderr are never persisted by the session or included in JSON errors.

## Root-only hardware handoff

Run `node capabilities/live/host.cjs --dry-run` first. This uses synthetic inventory, connection and decoder fixtures through an ephemeral v1 server. It never reads the real session, accesses hardware, changes capability records or writes an evidence file. Its proof explicitly says `mediaSource: "protocol_and_decoder_fixture"`, `hardwareVerified:false` and `sample.fullDecode.fixture:true`.

For a real run, root must first drain and stop the existing resident listener and its media owner. The host does not stop, replace, restart or contact that listener. Set these environment variables in root's private execution context:

| Variable | Required value |
| --- | --- |
| `EUFY_SESSION_PATH` | Absolute path to the existing completed private login session |
| `EUFY_LIVE_EVIDENCE_PATH` | New absolute private evidence filename outside the checkout |
| `EUFY_LIVE_DEVICE_SERIAL` | Exact current camera serial from root's inventory |
| `EUFY_LIVE_HOMEBASE_SERIAL` | Exact current owning HomeBase serial |
| `EUFY_LIVE_CHANNEL` | Nonnegative integer channel from that same inventory |
| `EUFY_LIVE_RESIDENT_STOPPED` | `1`, root's explicit declaration that the former resident owner is stopped |
| `EUFY_FFMPEG` | Existing FFmpeg executable path |

Then run `node capabilities/live/host.cjs --run`. There are no login, retry, refresh or alternative-target arguments. The host restores the existing session once, refuses missing/ambiguous camera, HomeBase or channel bindings, and uses one temporary loopback v1 listener on a dynamically assigned port. Failed restore does not delete the existing session file. Root remains responsible for restoring the former resident after this process exits.

The session consumes five seconds of video, explicitly stops, repeats stop, and checks that a same-HomeBase export request was rejected by the real shared v1 guard. The complete bounded JPEG sample (at most 32 MiB) is then fully decoded with FFmpeg in memory; its proof requires exit code zero and a decoded-frame count exactly matching the sample. It never saves private media. The full-decode subprocess has a fifteen-second deadline and awaited close. A 120-second host watchdog cancels the controller; owned connection/child cleanup is awaited, including cancellation of pending connection setup. An empty temporary job-store directory under ignored `output/` is used only to exercise the normal export guard and is removed after shutdown.

Success requires `status:"completed"`, `sample.fullDecode.passed:true`, `sample.fullDecode.childClosed:true`, positive media counts, `stopConfirmed:true`, both idempotence checks, the `SERVICE_BUSY` conflict result, every resource-closure flag and `cleanupComplete:true`. Stdout contains hashed device/HomeBase identifiers and firmware/channel association. The private evidence file additionally contains `privateBinding` with the exact serials and channel. Keep that file private; use the redacted stdout proof for review. `hardwareVerified:false` and `capabilityUpdated:false` remain explicit until root independently accepts the real evidence.

After root reviews a completed real proof, set `EUFY_LIVE_PROOF_ACCEPTED=1`, retain its private `EUFY_LIVE_EVIDENCE_PATH`, and set `EUFY_CAPABILITY_RECORDS_PATH` to the intended existing private verification store (an absolute path outside this checkout). Run `node capabilities/live/host.cjs --record-proof`. This step contacts no service or hardware. It validates the full real proof and exact known camera/HomeBase firmware scope, then records `liveVideo: verified` through `DeviceVerificationRepository`. Dry-run, fixture, partial, missing-frame, unconfirmed-stop, failed-cleanup and unknown-firmware proofs are refused. Its redacted result reports `hardwareVerified:true` and `capabilityUpdated:true`. Other capabilities and firmware scopes remain unchanged. `--help` describes both handoff phases without reading any private input.

## Offline evidence

`node --test capabilities/live/*.test.cjs api/v1-routes.test.cjs capabilities/recordings/events.test.cjs` covers command construction using the vendored Station implementation, session identity/cleanup, optional shared connect cancellation, real UDP handle retirement, errors, v1 media and schema, shared guards, request disconnects, shutdown, host preflight and target ambiguity. Set `EUFY_FFMPEG` to enable the real synthetic H264 → JPEG → complete-sample decode test. These tests provide no real-device verification.
