# Recording time-window contract (version 1)

This is the shared time representation for recording consumers, including the
future v1 API (#2), export pipeline (#7), CLI and Agent tools. Those integrations
are not implemented by this contract. Use `normalizeWindow` from
`capabilities/recordings/time-window.cjs` at the input boundary and persist its
result unchanged; do not reinterpret the original clock times after restart.

## Input and normalization

```javascript
const { normalizeWindow } = require('../capabilities/recordings/time-window.cjs');
const window = normalizeWindow({
  day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'Asia/Shanghai'
});
```

Input dates are valid Gregorian `YYYY-MM-DD` dates (years 0001–9999); clock times
are `HH:mm` in the named IANA timezone. `UTC` and IANA aliases accepted by Node's
Intl data are supported; numeric offsets such as `+08:00` are not timezone names.
Invalid dates, times and zones fail explicitly. Nonexistent local times and
repeated local times at an offset transition are rejected at either endpoint;
there is no automatic choice of the earlier/later occurrence. Explicit offset
disambiguation is not part of version 1.

Both endpoints must be on the same caller-local day, with end strictly after
start. A window such as `23:50`–`00:10`, equal endpoints, or an `endDay` different
from `day` is rejected. Cross-midnight support would need a versioned extension.
A valid window may cross a DST transition; its UTC duration follows elapsed
time, not clock subtraction. An interval is half-open: `[start, end)`.

Timezone precedence is the explicit request, `normalizeWindow`'s optional
`{defaultTimezone}` option, `EUFY_RECORDING_TIMEZONE`, then `America/Toronto`.
An explicitly invalid value is an error, not a request to use the default.
The effective validated identifier is retained, including an accepted alias.
`installRecordingRoutes` resolves its default once at installation, while direct
normalizer calls read the environment at call time.

```json
{
  "version": 1,
  "input": {
    "day": "2026-08-27",
    "start": "16:30",
    "end": "16:50",
    "timezone": "Asia/Shanghai"
  },
  "normalized": {
    "start": "2026-08-27T08:30:00.000Z",
    "end": "2026-08-27T08:50:00.000Z",
    "timezone": "Asia/Shanghai"
  }
}
```

`input` contains the original accepted clock values; `input.timezone` is `null`
when the caller omitted it. `normalized.start/end` are UTC ISO-8601 strings,
always with `Z` and milliseconds. No field uses an implicit host timezone or
mixes Unix seconds and milliseconds. Consumers must validate the supported
version before consuming a stored window and use `Date.parse` only when they
need numeric milliseconds (divide by 1000 explicitly for Unix seconds).

## Requested window versus observed footage

Responses carry the object above as `window`. Its bounds are the **request**,
not evidence of footage. The companion field `coverage: null` means actual media
coverage has not been measured. Do not replace it with the requested window,
index timestamps, an empty interval array, or a decode-success claim. #7 must
define measured coverage and gap evidence separately before populating it.

Current event response/export `start` and `end` are legacy event-index timestamps,
not measured frame coverage. Whole event clips can extend beyond the requested
window; export does not trim them. Index overlap is `record.start < window.end`
and `record.end > window.start`. Event results do not establish continuous
coverage. A successful download or full decode does not establish gap-free
coverage either.

The legacy HTTP query accepts `{serial,day,start,end,timezone?}`. `202` responses
include `timezone`, `window` and `coverage`; status includes the configured default
as top-level `timezone` and the accepted effective timezone at `query.timezone`.
`query.start/end` remain Unix milliseconds for compatibility. Individual event
and saved-clip responses expose their own effective timezone. The fixed page
continues displaying Toronto time and explicitly requests `America/Toronto`,
regardless of the API default.

Bundled pages download a selected event with `recordId` plus `expectedQuery`,
copied from that row's service echo: `query.serial` and all fields of
`query.window.input`. The resident compares those original caller fields,
including an explicit timezone versus `null`, with its current query before it
selects the record. Older external callers may omit `expectedQuery` and retain
the latest-query behavior.

## Device calendar and persistence

The protocol's date query formats Date **local calendar getters** as `YYYYMMDD`,
not UTC instants. Its response parser interprets station-local index timestamps
using the process timezone. The existing server pins that device/process
timezone to Toronto. `EUFY_RECORDING_TIMEZONE` changes caller input defaults;
it does not change the HomeBase timezone or the protocol parser.

`LocalRecordings.listWindow(serial, window)` converts normalized instants into
the protocol/process calendar, querying from the start's device day through the
day after the last included instant's device day, then filters index overlap in
UTC. This includes an adjacent device day when the caller's timezone requires it.
Direct `listDay(serial, day)` retains its legacy device-calendar meaning. Do not
pass UTC midnight Dates directly to `databaseQueryByDate`: host-local formatting
can change the day. Direct capability hosts must already have their process
timezone aligned with the station, as required by the existing adapter.
Resolving ambiguous timestamps emitted by station firmware, station timezone
discovery/configuration and hardware validation are not established here.

Pass the same `window` to `download(recordId, directory, window)`. It is saved in
the raw JSON alongside index metadata. `exportRecording` reads that persisted
context, emits `recording_timezone` in the MP4 metadata, and writes a matching
`<destination>.json` sidecar containing the returned clip, window and unknown
coverage. Export does not re-normalize with the current default. Legacy raw
downloads without a window retain Toronto semantics; a legacy persisted
`timezone` field is honored if present.

The route manifest stores context per clip. Its top-level `timezone` is a
convenience summary: the common clip timezone, or `null` for a mixed directory.
On restart, per-clip window/zone is authoritative, followed by an older manifest
timezone and finally Toronto for metadata from before this contract. Old files
without a stored window expose `window: null`; their caller input is unknown.

Tests cover Toronto summer/winter and both DST transitions, Shanghai, Kathmandu,
Auckland, Lord Howe's half-hour DST, explicit/configured defaults, invalid input,
protocol date payloads in multiple host zones, raw/export context, mixed-zone
manifests and restored saved responses. These are offline contract tests, not
new device acceptance evidence.
