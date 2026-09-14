# Resident playback sessions

`POST /api/v1/playback-sessions` creates a resident historical playback owner on
one dedicated P2P connection. The existing request remains a control/status API
when `media` is omitted or false. `media:true` additively enables a direct browser
preview on that same owner; it never creates an MP4, second P2P connection or disk
media. The M2 recording workbench is the browser caller. No CLI or Agent playback
command is added.

The create body uses `serial`, `day`, `start`, `end`, optional `timezone`/`endDay`
from the existing recording window contract and optional numeric `speed` (default
1). The current limit is an interval of 1–60 whole seconds covered by one current
record. A media create additionally requires `requestId`, the current
`residentEpoch` from `GET /api/v1/session`, and speed 1. The response is
`{ playback, reused }`, after a matching successful start and the first decoded
JPEG. Start never borrows an older record or substitutes the requested begin time
for media position.

The random `sessionId` remains the only identity used by legacy subsequent
`GET /api/v1/playback-sessions/:sessionId` and `POST` actions `/pause`, `/resume`,
`/close`. Action bodies must be `{}`; target/channel/account/path overrides fail
validation. The service retains the actual camera/HomeBase/channel, cloud API
identity, current record path and P2P owner. Each control rechecks current inventory
and persisted authorization. Changing any scope component invalidates the owner.
Closed and failed session views remain queryable for the life of this process;
IDs do not survive process restart. Media create/seek identity is registered before
asynchronous work and remains immutable in memory. Repeat the exact media request
ID to recover the same pending/result; changed input returns
`PLAYBACK_REQUEST_CONFLICT`. `GET /api/v1/playback-requests/:requestId` with the
matching `residentEpoch` only reads that result and never starts protocol work.
An epoch from an earlier resident returns `PLAYBACK_REQUEST_EXPIRED`. Browser
storage keeps only this intent; refresh recovery never automatically replays a
camera.

An opening or early-failed session is still schema-valid and queryable. Before
inventory resolution its scope contains only the requested serial; model,
firmware, HomeBase and channel remain explicitly unknown, and its controls are
unverified and empty. This is request identity, not verification evidence. A media
session continues to expose its request/window/resource status, but omits the
optional `media` block until a real decoder epoch and lease have both been
established; no expiry or first-frame observation is invented.

## Browser media transport

`GET /api/v1/playback-sessions/:sessionId/media` is a single-consumer,
`Cache-Control: no-store` MJPEG response with content type
`multipart/x-mixed-replace; boundary=frame`. A second consumer receives
`PLAYBACK_CLIENT_CONFLICT`. Every JPEG part carries immutable bounded ASCII fields:

```text
Content-Type: image/jpeg
Content-Length: <bytes>
X-Playback-Session-Id: <sessionId>
X-Playback-Request-Id: <requestId>
X-Playback-Media-Epoch: <integer>
X-Playback-Frame-Sequence: <integer>
X-Playback-Source-Received-Ms: <device source timestamp observed when output arrived>
```

The decoder is the existing in-memory FFmpeg H.264/HEVC to JPEG path: video-only,
no audio, at most 5 fps and 960 px wide. It accepts raw video only for the bound
owner and channel, only while `begin <= timestamp < end`, and only beginning with
the first keyframe inside that window. Ordinary SDK video/audio streams are still
drained, so bytes from before the requested begin cannot enter this decoder.
There is no fallback to an earlier keyframe.

`sourceReceivedPositionMs` and `timestampSemantics:"source-received-position"`
describe a source-receive observation captured with a JPEG. They are not the
JPEG's exact PTS, do not map raw packets one-for-one to output JPEGs, and do not
promise frame-accurate seeking. `frameSequence` proves successful preview output;
the browser updates its label only after `createImageBitmap` has decoded and the
canvas has drawn that part. The workbench measures submit-to-first-canvas-draw
latency rather than substituting the server raw-frame time. Media status separately
reports `firstFrameLatencyMs`, measured from accepted server intent to its first
decoded JPEG; it is not the browser metric.

The browser parser caps part headers at 4 KiB and JPEG/body buffering at 1 MiB.
It permits one active bitmap decode plus one latest pending part; older pending
preview frames are overwritten. Every asynchronous completion rechecks local
generation, session, request and media epoch before drawing.

## Bounded seek and replacement

`POST /api/v1/playback-sessions/:sessionId/seek` accepts
`{requestId,residentEpoch,day,start,end,timezone?,endDay?}`. It inherits serial,
speed 1, media opt-in and exact authorization scope from the named current session.
Within the existing resident admission, it confirms stop and complete cleanup of
the old session before querying and opening the new 1–60 second same-day/single-
record window. Live, export, range, login replacement and another playback cannot
enter the close/open interval. Cleanup failure prevents the new owner. A stale URL
session returns `PLAYBACK_STALE_SESSION`; repeating an accepted seek returns its
original result and never closes the replacement.

The workbench invalidates old status/decode generations immediately and coalesces
rapid UI seek input to the newest not-yet-sent target. A sent request with a lost
response is recovered by its same ID before a later target is issued. Missing
recording, gap and unsupported/out-of-bounds windows remain explicit errors; old
footage is never displayed as the requested target.

## Media bounds and cleanup

These limits apply only to `media:true`; legacy control-only sessions never create
a decoder and have no attach/media lease:

- first decoded JPEG uses the existing 15-second start-media bound; the first HTTP
  consumer must attach within 10 seconds after it is ready;
- playing fails after 5 seconds without another decoded JPEG/source advance;
- the existing pause lease is 30 seconds; pause revokes output, clears buffers and
  awaits decoder close while keeping the same P2P owner;
- resume starts a new decoder epoch strictly after the paused source position and
  waits at most 15 seconds for its first new JPEG;
- the ready media session lease is at most 120 seconds;
- one JPEG/queued multipart part is at most 1 MiB, visible decoder input buffering
  is at most 8 MiB, and a response unable to flush for 5 seconds fails as a slow
  consumer;
- login is checked at most every second and exact inventory scope every five
  seconds without overlapping each check; disconnect closes rather than reconnects;
- cleanup ends the response, removes timers/listeners, destroys streams/buffers,
  waits for FFmpeg then P2P/connection close, and only then sets
  `cleanupComplete`. A failed/uncertain cleanup keeps resident admission busy.

## Authorization and scope

Query `/api/v1/devices/:serial/capabilities/continuousPlaybackControls` first. It
returns the device's exact `verificationScope`, four-state capability and `controls`:

```json
{ "pauseResumeAtSpeed1": false, "verifiedStartSpeeds": [] }
```

Only a persisted `continuousPlaybackControls` record with `status: "verified"`,
dated evidence and explicit typed `controls` can enable operations. The complete
scope must exactly match serial/model, main and secondary firmware of camera and
HomeBase, and channel. All firmware strings must be known. A `protocol_hint`, a
bare `verified` entry, free-text evidence, partial-export history or a different
scope cannot authorize playback. Existing records are never promoted by this API.
The existing `DeviceVerificationRepository.record()` is the local evidence writer;
there is no new public evidence-write route.

The implementation accepts only explicit verified start values among **1, 2, 4,
16**; 8 and all other numeric values return `CONTROL_NOT_VERIFIED`. This ceiling
comes from authorized internal command/media observations on the tested scope.
It is not a support claim for other devices/firmware or a measurement of playback
presentation ratio. The scope's record may authorize a smaller list.

Pause/resume requires `pauseResumeAtSpeed1: true` and a session started with 1.
Sessions started with 2, 4 or 16 support close, with no in-stream speed change or
fixed-speed-1 resume. `allowedOperations` in a session response reflects its state.
`verifiedStartSpeeds` is that session's admitted scope record, not a new observation.

## State and timing

Device lookup, connect, record lookup and media startup share a 60-second overall
bound; no individual lookup, connect, command reply or initial-media stage gets
more than 15 seconds. During the raw-media startup wait the adapter timeout is
extended. The first valid control-only video restores its original value;
media-enabled playback switches to the documented bounded media guard. Cleanup
restores settings and listeners on every path.

After a successful pause return, the local media idle timer is held beyond a
**30-second pause lease**. `pauseExpiresAtMs` gives its deadline. A matching video
timestamp strictly advancing beyond the pre-pause position fails the session with
`PAUSE_MEDIA_ADVANCED` and closes the dedicated connection without resume or other
control. A quiet window is a bounded observation, not proof of indefinite device
pause. Lease expiration closes the owner; a concurrent inventory lookup cannot
extend it. Resume restores the original media timeout, uses this session's actual
position in seconds, waits for successful return and fresh video advancement.
For the current record's `file_path`, null/absent is omitted as Gson would do;
strings, including empty strings, are preserved. Other types fail context checks.

Every command has a new marker and matching target channel. Copied markers and
wrong-channel replies cannot complete an operation. Another control while one is
pending returns `SERVICE_BUSY`. A media end timestamp at or after the requested
end triggers confirmed stop/close. No synthetic frame tolerance or guessed EOF
is used. Unexpected stream termination closes the owner without an uncorrelated
automatic stop command.

Close waits for its matching stop return and P2P cleanup. `stopConfirmed` reports
whether that session ever received its stop acknowledgment; repeated close sends
no additional command and does not constitute another observation. A failed
cleanup retains admission ownership. Logout and shutdown wait for cleanup before
releasing cloud/session resources. Exports, range lookups, legacy recording work
and authentication replacement cannot acquire an active playback owner.

## Errors and observations

Errors retain the existing `{ error: { code, message } }` contract, with fixed
control messages and no account, path, payload or raw exception. Principal codes:

| HTTP | Codes |
| --- | --- |
| 401 / 404 | `UNAUTHENTICATED` / `PLAYBACK_SESSION_NOT_FOUND` |
| 409 | `SERVICE_BUSY`, `CONTROL_NOT_VERIFIED`, `CONTROL_SCOPE_CHANGED`, `CONTROL_INACTIVE`, `CONTROL_CONTEXT_UNAVAILABLE` |
| 502 | `CONTROL_REJECTED`, `CONTROL_RESPONSE_INVALID`, `CONTROL_SEND_FAILED`, `PAUSE_MEDIA_ADVANCED` |
| 503 | `CONTROL_CONNECTION_LOST`, `CONTROL_CLEANUP_FAILED`, `SERVICE_STOPPING` |
| 504 | `CONTROL_TIMEOUT`, `CONTROL_STARTUP_TIMEOUT`, `CONTROL_MEDIA_TIMEOUT` |

Media adds `PLAYBACK_REQUEST_NOT_FOUND`, `PLAYBACK_REQUEST_CONFLICT`,
`PLAYBACK_REQUEST_EXPIRED`, `PLAYBACK_STALE_SESSION`, `PLAYBACK_CLIENT_CONFLICT`,
`PLAYBACK_NO_RECORDING`, `PLAYBACK_MEDIA_UNAVAILABLE`,
`PLAYBACK_MEDIA_TIMEOUT`, `PLAYBACK_MEDIA_SLOW_CLIENT`,
`PLAYBACK_DECODER_FAILED` and `PLAYBACK_RUNTIME_UNAVAILABLE` with the same safe
error envelope. FFmpeg diagnostics, account IDs, record paths and media bytes are
never placed in JSON or logs.

An uncertain command result closes the connection; it cannot be followed by a
resume/stop on that owner. GET retains operation return codes/wall times, current
media position and query/command/media channel match/reject counts. Scope contains
device identities as in the existing device API; neither account nor media path
is exposed. `channelIsolation` remains `unverified`: target command/media binding
is observable, but Node's projected channel and a peer's read-only range response
are not independent playback-isolation proof.

## Hardware browser acceptance entry

Synthetic resident/FFmpeg/Chromium tests do not verify hardware. The
[maintainer-only T8600/T8030 entry](internal/BROWSER_PLAYBACK_ACCEPTANCE.md) drives
the normal workbench against one manager-authorized, already-running loopback
resident and writes a new private evidence document. It does not start or stop a
resident, log in or out, update capability records, take screenshots or persist
frames. Private device serials and pictures must never enter the repository or
logs. Earlier control observations do not substitute for this browser check.

Safari is **NOT_RUN (user-waived)** for Issue #39 and is not a merge blocker.
Chromium at 390 px is not Safari evidence.
