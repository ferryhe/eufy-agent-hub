# Device inventory completeness — Issue #5

## Protocol evidence

Reviewed on 2026-09-12 against hub baseline
`bf8ce107ce74f8a765efaf7f6dd22705e3050410`:

- The retained [Mega source](../../vendor/eufy-security-client/src/http/megaApi.ts),
  `MegaHTTPApi.getDevsListDecrypted()`, sends one encrypted POST to
  `/app/house/get_devs_list` with `{ device_sn: "", num: 100, orderby: "" }`.
  It decrypts an untyped response. There is no verified continuation request,
  cursor, total-count contract, or terminal-page indicator in this implementation
  or `megaInterfaces.ts`. `100` is the requested size, not a proven server hard cap.
- [Snapshot provenance](../../vendor/eufy-security-client/PROVENANCE.md) records
  bropat base commit `8ca2545a45460ccf6bca66901ee90ef58b07934d` and the snapshot's
  local modifications. This retained implementation is evidence of the current
  client request shape; it is not an official Mega pagination specification.
- The separate legacy [HTTPApi.getDeviceList()](../../vendor/eufy-security-client/src/http/api.ts)
  sends `page: 0` and `num: 1000` to `v2/house/device_list`. Different endpoint and
  transport: those fields do not establish Mega continuation semantics.
- The [pinned upstream migration notice](https://github.com/bropat/eufy-security-client/blob/8ca2545a45460ccf6bca66901ee90ef58b07934d/README.md)
  describes legacy API retirement and new Mega integration work. It does not
  document a device-list continuation protocol.

No usable authorized account continuation trace or official pagination contract
was available for this change. The authorized real-device precheck failed with
Mega code 26084 (kicked out); it proves neither pagination support nor absence.
No new account request or hardware acceptance was performed by this implementation
work. The conclusion is **pagination unverified**, not “Mega has no pagination.”

## Production boundary and local collection model

`readDeviceInventory(api)` in [discovery.cjs](discovery.cjs) is used by both
`LocalEufySession.refresh()` and the v1 routes' inventory helper. It invokes
`getDevsListDecrypted()` exactly once without new parameters. It does not interpret
arbitrary `page`, `next_cursor`, `has_more`, `total`, or `completeness` fields.
Every successful response, including empty, short and 100-entry responses, has
`completeness: "unknown"` and `pagination: "unverified"`.

`collectDevicePages(pages)` consumes a caller-owned iterable of decrypted page
objects. This is a local merge/error model: **production currently supplies one
page**, while offline fixtures supply multiple pages. It validates each full page,
merges by `device_sn` with the last occurrence winning, retains unknown/missing
models, and retains earlier valid pages when a later read or validation fails.
Ending this iterator does not establish complete account discovery. No test
fixture is evidence that Mega accepts a next-page request.

The [collection tests](discovery.test.cjs) cover overlapping pages, unknown models,
a failed second page after 100 entries, malformed later pages and a fresh retry.
The [Mega request test](../../vendor/eufy-security-client/src/http/__test__/megaApi.test.tsx)
uses mocked transport with encrypted fixture bodies to pin the existing request
shape, a single call at 100 entries and error propagation. It is an offline wire
shape check, not a server protocol or hardware verification.

## Structured discovery state

Session state (`/status`), `getDevices`/`refreshDevices`, and v1 device list,
single-device and capability responses include `discovery`:

```json
{
  "status": "succeeded",
  "completeness": "unknown",
  "pagination": "unverified",
  "pagesRead": 1,
  "receivedCount": 100,
  "uniqueCount": 99,
  "limitReached": true,
  "failedPage": null,
  "retryable": false,
  "stale": false,
  "reasons": ["pagination_unverified", "request_limit_reached"]
}
```

- `status`: `not_requested` before discovery/after logout or known expiry;
  `succeeded` when the supplied reads and projection succeeded; `failed` on error.
  A successful request is not a complete account list.
- `completeness`: `unknown` without a verified end condition; `incomplete` when
  discovery could not finish. `complete` is not an allowed value.
- `pagesRead`, `receivedCount`, `uniqueCount` describe validated pages of the
  **latest attempt**, before and after serial deduplication. Invalid pages are
  rejected as a whole. `limitReached` records any validated page with at least
  100 entries, even when deduplication reduces the number or a later stage fails.
- `failedPage` is the one-based page that could not be fetched/validated. It is
  null for a successful read or a later capability-record/projection failure.
- `retryable: true` permits a fresh discovery attempt after failure. It is not a
  guarantee of recovery and does not create a cursor or resume operation. Known
  lost/expired authentication still requires login through the existing guards.
- `stale: true` means the session retained its previous device cache after an
  attempt with no valid page. Attempt counts then do not describe that old cache.
  After a later-page failure the local model instead retains the current attempt's
  valid pages. Successful retry replaces devices and resets failure/stale fields.
- `reasons` always contains `pagination_unverified`, optionally
  `request_limit_reached`, plus `inventory_request_failed`, `invalid_inventory`, or
  `capability_records_unavailable` when that stage fails.

v1 read/validation errors are HTTP 503 `DEVICE_UNAVAILABLE` with `discovery`.
A later verification-record/projection failure remains HTTP 503
`CAPABILITY_RECORDS_UNAVAILABLE`; it adds failed/incomplete/retryable state while
preserving the counts and limit evidence from the successful raw read. v1 does
not serve a cached device list on either failure. A missing serial remains HTTP
404 `DEVICE_NOT_FOUND`, now with the retrieved inventory's `discovery`; absence
from this unverified subset does not prove absence from the account.

## Call-path scope

The shared helper covers session refresh (including login and strict restore),
the device capability entry points, `/status`, and v1 list/single/capability
reads. v1 range/export/retry admissions use the same inventory helper and preserve
its structured discovery failures and missing-device metadata.

The separate `recordings/events.cjs` connection method (also inherited by
`recordings/continuous.cjs`) and `recordings/continuous-export-evidence.cjs` read
raw inventory to locate a requested camera and its HomeBase. They do not return an account device list or assert discovery
completeness, so their acquisition and media protocols are unchanged by #5.
`describeDevices`, `queryDevice`, and `continuousDevices` are pure projections
over caller-supplied arrays and make no discovery/completeness claim.
The CLI device commands and Agent `RecordingTools.devices()` forward the v1
response, including its discovery state, without another device request path.
