# Dynamic workspace

The main workspace renders registered shared device lists, recording timelines, players and job cards. It stays mounted in fixed browsing and Agent mode, so both modes use the same operations and playing videos. Existing fixed event search uses the same timeline/player components with its event-download operation.

## Presentation contract v1

The installed root Agents SDK runtime exposes `workspace_present`. Its input is a version and ordered references:

```json
{
  "version": 1,
  "views": [
    {"type":"device-list","deviceIds":["CAMERA001"],"receiptId":null,"jobId":null,"artifactId":null},
    {"type":"timeline","deviceIds":null,"receiptId":"receipt-from-recording_ranges","jobId":null,"artifactId":null},
    {"type":"player","deviceIds":null,"receiptId":null,"jobId":"existing-job","artifactId":"registered-video"},
    {"type":"job-card","deviceIds":null,"receiptId":null,"jobId":"existing-job","artifactId":null}
  ]
}
```

All tool fields are required; unused fields are null. `deviceIds:null` follows current inventory; an explicit list selects serials. Timeline IDs come from `recording_ranges`. Job/artifact IDs come from actual tool results. `workspace_present` stores only relevant references and returns the normalized presentation. It never starts exports, accepts media URLs, changes service windows, or executes model page code. The resident returns it in `GET /interface/agent/state`. Without a presentation, the workspace shows inventory and known receipts/jobs. Unknown types, missing required IDs and unsupported contract versions display a localized fallback while valid siblings keep rendering. Repeated identical descriptors share one view.

## Pinning, ordering and current data

Pin/unpin and Move up/down controls work in both modes. Browser storage `eufy-agent-hub.workspace` contains `{version:1,views:[...]}` for pinned references in their selected relative order. No labels, device snapshots, time windows, media URLs or job status are persisted in the browser. Unpinned order lasts for the current page; pinned results restore first after refresh, followed by the current Agent composition. Pinning is independent of later Agent presentations. Storage is optional and scoped to the resident origin; it does not synchronize accounts or browsers.

Every status poll reloads the current device API and resident receipts. Repeated `jobId` query parameters on `/interface/agent/state` let pinned job/player views reload durable v1 jobs even when conversation history is absent. Model calls are never made during refresh/poll. Missing device, receipt, job or playable artifact shows an explanatory message and retries automatically. A service failure is visible above retained results; recovery refreshes them. Restart normally requires login for current inventory; durable jobs/artifacts remain readable after logout. A lost receipt cannot be reconstructed from labels: ask the Agent to query again.

Timeline **Export this requested window** calls `POST /interface/agent/export` with only `{receiptId}`. Both modes use this registered handler and the existing `RecordingTools.submit` request identity, including concurrent/repeated clicks. It exports the acknowledged whole requested window, not an inferred subrange. Both SDK and UI submissions append an accepted job reference before returning, so a later model failure or timeout cannot hide newly accepted work. A later successful presentation can deliberately change unpinned views. New exports appear as job cards; a failed/partial durable job retains its existing identity and honest status. Player controls and download links use only registered playable/validated artifacts returned by the job API.

Nodes are keyed by normalized references. Poll, pin, language and mode changes preserve video elements. Chrome's state-preserving DOM move keeps playback alive during reorder; browsers without `moveBefore` retain element identity but may pause media during a move. Labels follow the shared EN/zh-CN preference, retaining original user/device text and service-normalized recording windows.

See [validation](VALIDATION.md) for synthetic SDK/Chrome acceptance evidence and limits.
