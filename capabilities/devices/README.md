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

## Current limitations

- Summaries do not include online status, firmware, parent HomeBase, or channel.
- There is no capability matrix verified by model and firmware. Agents cannot assume arbitrary models support playback, talkback, or settings control.
- Inventory retrieval is not paginated. Responses containing at least 100 entries produce a warning that the list may be incomplete.
- Device settings, arming, pan/tilt, lights, and door lock controls are not implemented in this directory.

See the [issue drafts](../../docs/issues/auth-devices.md) for planned work.
