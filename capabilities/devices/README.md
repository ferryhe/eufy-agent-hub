# Device discovery

The existing device discovery implementation is `LocalEufySession.refresh()`, which reads the Mega device inventory endpoint. This directory provides a thin entry point without duplicating login or protocol logic.

```js
const { getDevices, refreshDevices } = require('./capabilities/devices/index.cjs');

const cached = getDevices(session);
const refreshed = await refreshDevices(session);
```

Both methods return `{ devices, diagnostics, message }`. Devices contain `serial`, `name`, `model`, and `capabilities.eventRecordings`; entries are deduplicated by serial number, and unknown models are retained. Results are copies, so changing a returned list does not change the session.

The recording selector only offers entries with `capabilities.eventRecordings === true`. This requires a camera device type recognized by the protocol library, a declared download command, and a T8030 parent in the inventory. The recording backend repeats the same check against fresh inventory before constructing a camera or connecting. Unknown or missing device types remain visible in discovery but cannot be selected for recording extraction. This eligibility flag is not a guarantee of hardware acceptance for every model or firmware.

`getDevices` returns cached data without making a request. `refreshDevices` requires a logged-in session; if discovery fails, it returns the previous list and failure diagnostics. Interfaces and agents must check `diagnostics` rather than treating cached data as a successful refresh.

## Maturity and validation

Device discovery was validated with a CA account in the original project. Unknown models returned by the protocol can be listed, but that does not mean they can be connected to or controlled. Existing authentication and discovery behavior is covered by the [session tests](../auth/session.test.cjs).

## Device capability query

`describeDevices(inventory, options)` and `queryDevice(inventory, serial, options)`
consume an already-read raw inventory. They make no network calls. `queryDevice`
returns null when the serial is absent. The module also exports
`queryCapability(device, capability)` and `recordCapability(records, observation)`.
The v1 device list, single-device and capability endpoints consume this projection
from the same authenticated raw inventory. Existing `getDevices`/`refreshDevices`
session summaries retain their event-recording boolean compatibility; raw metadata
is not added to the auth cache. Future CLI/Agent callers can use
`GET /api/v1/devices/:serial/capabilities/:capability` without a separate login owner.

```js
const { queryDevice, queryCapability, recordCapability } = require('./capabilities/devices/index.cjs');
// inventory is the raw devices array already returned by the adapter.
const device = queryDevice(inventory, serial);
const query = queryCapability(device, 'continuousRecordingQuery');
// Call only after an actual authorized test; do not use model names as evidence.
const updated = recordCapability(records, {
  scope: device.verificationScope,
  capability: 'continuousRecordingQuery', status: 'verified',
  reason: 'Requested retained range was returned',
  evidence: [{ source: 'reference-to-sanitized-test-report', observedAt: '2026-09-11', outcome: 'requested_range_returned' }],
});
const verified = queryDevice(inventory, serial, { records: updated });
```

The stable device projection contains `serial`, `name`, nullable `model`,
nullable `homeBaseId`/`channel`, `firmware: { main, secondary }`, `availability`,
`state: { inventoryStatus, reason, observedAt }`, `recordingExport`,
`verificationScope`, `verificationHistory`, and `capabilities`.
The six capability keys are `continuousRecordingQuery`, `continuousRecordingExport`,
`eventRecordings`, `liveVideo`, `talkback`, and `rtsp`. Every entry has
`{ status, reason, evidence }`. An unknown capability query returns this same shape
with `status: 'unknown'` and `reason: 'capability_not_catalogued'`.

| Status | Meaning |
| --- | --- |
| `verified` | Dated evidence applies to this exact device and firmware scope; inspect its outcome and limitations |
| `unsupported` | Explicit negative evidence applies to this exact scope |
| `unknown` | No applicable verification or protocol hint; not a claim that hardware is unsupported |
| `protocol_hint` | A library command or historical model path exists; the device/firmware has not been verified |

`recordingExport.supported` remains the existing **execution eligibility** flag,
so untested live/talkback/RTSP functions do not block the historical recording
path. In the new projection, its `status` comes from `continuousRecordingExport`.
An eligible T8600/T8030 pair starts with `protocol_hint`, not device-wide verified
status. These two fields answer different questions. The old `continuousDevices`
helper is retained for internal recording eligibility compatibility; public v1
responses use the device-specific status described here.

Records are ordinary caller-owned JSON arrays. `recordCapability` returns an
independent copy with just the requested capability/scope replaced. It rejects unknown capability/status,
missing explicit scope/reason, and verified/unsupported updates without dated
evidence. Missing firmware does not become a wildcard. The historical record is
not an automatic runtime default. Read [verification scope and evidence](VERIFICATION.md)
for the actual camera/HomeBase history and partial-export limitations.

Optional `reachability` observations use
`{ serial, status: 'online' | 'offline', reason, observedAt }`. Caller-supplied
observations are separate from numeric inventory status; callers own their
freshness. Without an observation, the module does not claim the device is online.

## Persistent verification records

`DeviceVerificationRepository` stores version-1 JSON records in ignored
`output/devices/verification.json` by default. Configure the service with
`EUFY_CAPABILITY_RECORDS_PATH` or `createServer({ capabilityRecordsPath })`; an
explicit `createServer({ deviceRepository })` overrides the file repository.
Injected repositories implement synchronous `read()` returning `{ records, reachability }`.

```js
const { DeviceVerificationRepository } = require('./capabilities/devices/index.cjs');
const repository = new DeviceVerificationRepository(); // Or the configured absolute path.
// observation is a dated result from an authorized test, with the exact verificationScope.
repository.record(observation);
repository.observeReachability({ serial, status: 'offline', reason: 'observed_connection_failure', observedAt });
const snapshot = repository.read();
```

`record()` returns the saved snapshot and replaces only the observation's exact
capability/scope. `observeReachability()` replaces only that device's last supplied
reachability observation. Both preserve all other records. Writers validate the
shared schema and dated evidence, flush a temporary file, then rename it over the
previous snapshot. Failed validation leaves the previous bytes intact. Missing
files start empty; invalid JSON/schema/evidence and unusable paths fail explicitly,
never silently reset history. An empty file is invalid JSON, not empty history.

There is one resident writer owner; multiprocess concurrent writers are not
supported. Reads reopen the file, so writes made through another repository
instance in the same local owner are visible on the next API query. No restart is
needed. This repository contains no auth data; logout blocks device reads but
retains long-lived evidence. API results filter history by device serial. No public
HTTP evidence-write endpoint is provided, and historical aliases are never loaded
or associated by model automatically. See the [API contract](../../api/v1.md).

## Current limitations

- Legacy session summaries do not yet include the richer projection above.
- Existing real-device evidence lacks firmware values, so current firmware cannot inherit its verified status. Agents cannot assume arbitrary models support playback, talkback, or settings control.
- Inventory retrieval is not paginated. Responses containing at least 100 entries produce a warning that the list may be incomplete.
- Device settings, arming, pan/tilt, lights, and door lock controls are not implemented in this directory.

See the [issue drafts](../../docs/issues/auth-devices.md) for planned work.
