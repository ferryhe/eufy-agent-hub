# Resident playback sessions

`POST /api/v1/playback-sessions` creates a resident historical playback owner on
one dedicated P2P connection. It is a control/status API: received media is drained,
with actual video position retained in memory; it does not produce an MP4 or a
browser media URL. Use the existing export API for a playable recording artifact.
No CLI, UI or Agent playback command is added.

The create body uses `serial`, `day`, `start`, `end`, optional `timezone`/`endDay`
from the existing recording window contract and optional numeric `speed` (default
1). The current limit is an interval of 1–60 whole seconds covered by one current
record. The response is `{ playback: ... }`, after a matching successful start
return and a valid video timestamp from this start. Start never borrows an older
record or substitutes the requested begin time for media position.

The random `sessionId` is the only identity used by subsequent
`GET /api/v1/playback-sessions/:sessionId` and `POST` actions `/pause`, `/resume`,
`/close`. Action bodies must be `{}`; target/channel/account/path overrides fail
validation. The service retains the actual camera/HomeBase/channel, cloud API
identity, current record path and P2P owner. Each control rechecks current inventory
and persisted authorization. Changing any scope component invalidates the owner.
The most recent closed/failed session remains queryable until another is created;
IDs do not survive process restart.

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

Start waits at most 15 seconds from send for its reply and initial valid media.
Only during that startup wait is the adapter's media timeout extended from its
original five seconds. The first valid video restores it immediately; cleanup
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

An uncertain command result closes the connection; it cannot be followed by a
resume/stop on that owner. GET retains operation return codes/wall times, current
media position and query/command/media channel match/reject counts. Scope contains
device identities as in the existing device API; neither account nor media path
is exposed. `channelIsolation` remains `unverified`: target command/media binding
is observable, but Node's projected channel and a peer's read-only range response
are not independent playback-isolation proof.

## Pending formal delivery check

This wrapper has offline tests; it has not been run against hardware. Earlier
internal observations for ordinary pause/resume and 1/2/4/16 are retained; 8 remains
unconfirmed. They do not replace testing this resident endpoint. After fresh
review, the hardware owner must use the same restored resident session and exact
reviewed scope record for one authorized retained 60-second interval:

1. Check authenticated/connected/idle and exact capability scope/details; create
   speed 1 through the public endpoint and retain its opaque ID and initial media
   position. Confirm the returned start code and matched channel counts.
2. Pause with `{}`; wait more than 5 seconds (for example 6) and less than the
   advertised lease. GET must still show paused without media advancement.
3. Resume with `{}`; require a successful return and actual video position advance.
4. Close in a `finally` path; retain confirmed stop and local cleanup result, then
   check session busy is false. Save only sanitized operation/timing/channel facts.

Do not extend observations into unmeasured permanent-pause, UI-rate or independent
channel-isolation claims. Actual rejected/disconnected-device semantics not yet
observed remain a hardware acceptance limitation.
