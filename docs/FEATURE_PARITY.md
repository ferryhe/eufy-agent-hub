# React migration parity and cutover checklist

The final `/` cutover belongs to M5/#40. M1–M4 and M6 are accepted on `main`. Fresh exact-scope React Live hardware evidence on 2026-09-29 supports the M5 cutover in PR #46: `/` serves React and `/legacy/` remains the old page. Final-head independent review, required CI and remote feedback remain merge gates; PR #46 records their current status.

| Milestone | Status | Evidence / boundary |
| --- | --- | --- |
| M1 / #35 Shell and resident authentication | **Accepted** | Merged PR [#41](https://github.com/ferryhe/eufy-agent-hub/pull/41); GitHub Actions Build and test run 81 passed. Preserves resident authentication, asynchronous login/challenge feedback, EN/zh-CN and theme preferences, route guards, and the legacy entry. |
| M2 / #36 Recordings | **Accepted** | Merged PR [#42](https://github.com/ferryhe/eufy-agent-hub/pull/42); Actions run 86 passed; recorded validation: `npm test` 537/537, Chromium 17/17 at 390/1440. The sanitized L2 export was partial with explicit gaps; it did not establish browser playback or complete footage coverage. |
| M3 / #37 Jobs | **Accepted** | Merged PR [#43](https://github.com/ferryhe/eufy-agent-hub/pull/43); Actions run 89 passed; recorded validation: `npm test` 543/543, Chromium 22/22. The resident remains authoritative for IDs, pagination, cancel/retry and cleanup. |
| M4 / #38 Agent/workspace | **Accepted** | Merged PR [#44](https://github.com/ferryhe/eufy-agent-hub/pull/44); Actions run 94 passed; recorded validation: `npm test` 543/543, Chromium 25/25 at 390/1440 with scripted resident model flows. |
| M6 / #39 Historical browser playback | **Accepted; #40 dependency satisfied** | Merged PR [#45](https://github.com/ferryhe/eufy-agent-hub/pull/45) at `02dc7a94d46ffb88da1e79ae7c201e58928f70cc`; Actions run 97 passed; recorded validation: 576/576 and Chromium 36/36. Exact-scope T8600/T8030 browser hardware acceptance passed for first frame/source time, pause/resume, bounded seek, close, stop confirmation and cleanup. Other devices, playback speeds, Safari and unlisted protocol features are not inferred. |
| M5 / #40 Live page integration | **Local L1/L2 passed; PR gate tracked on #46** | PR [#46](https://github.com/ferryhe/eufy-agent-hub/pull/46). With FFmpeg 9.0.2 and Python/PyAV, local `npm test` passed 580/580; Chromium passed 40/40, including real FFmpeg playback at 390/1440. React `/app/live` started a real T8600/T8030/channel 2 preview in the in-app browser on 2026-09-29. Chromium decoded a 960×540 frame. Explicit Stop showed cleanup confirmed. A second bounded session decoded 153 frames and ended with stop confirmed and protocol, connection, decoder and streams closed. A manual restart after expiry decoded a new frame and explicit Stop confirmed cleanup. Camera firmware was 1.0.5.0/18137 and HomeBase firmware 3.8.7.4/1.4.0.8. Exact serial binding is in ignored local `output/live/react-browser-acceptance-2026-09-29.json` (camera SHA-256 prefix `BB10CF092557`). This is one exact path; other hardware, talkback and RTSP remain unverified. |
| M5 / #40 parity checklist and default route | **Implemented in PR #46; merge pending** | M1–M4 and M6 are accepted above. `/` serves React, `/app/*` deep links remain, and `/legacy/` serves the old page for one transition release. Session, job, Agent, preference and media stores and IDs remain resident-owned and unchanged. Final-head independent review, required CI and remote feedback gate merge and closure; see PR #46 for current results. |

## M5 acceptance items

- [x] All six migration features are mapped above; M6's required historical browser playback gate passed in PR #45.
- [x] Live uses the existing resident API and existing media admission guards; it does not add a frontend lock or advertise talkback/RTSP.
- [x] Unknown/unsupported capability or an ineligible model/channel path refuses launch; a protocol hint is described as unverified.
- [x] React default exists at `/`; `/legacy/` retains the old page. API, CLI, deep-link and media routes remain intact.
- [x] README and module documentation describe current entry points, installation, rollback, media prerequisites and evidence limits.
- [x] `npm run build`, `npm test` (580/580 with FFmpeg/PyAV), and Chromium browser tests (40/40 with FFmpeg) passed locally; a resident restart restored authentication. `/`, `/legacy/`, `/app/live`, `/app/jobs`, CLI auth and v1 routes responded on the same origin.
- [x] Manual restart after confirmed expiry and decoder-close timeout retry have runnable regressions. Final-head review, CI and open-thread status are checked on PR #46 before merge.
- [x] Fresh authorized T8030/T8600 Live browser start/decoded-frame/stop/cleanup acceptance passed for the exact scope recorded above.
- [x] `/` serves React and `/legacy/` is retained for one transition release.

Merge protocol remains one scoped PR per issue, fresh independent review, fix and re-review of findings, all required CI green, no unresolved threads, then the repository's remote feedback window and cleanup. Hardware claims remain limited to the observed device and firmware scope.
