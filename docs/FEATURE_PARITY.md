# React migration parity and cutover checklist

The final `/` cutover belongs to M5/#40. A check in the first five rows means the scoped feature is present on `main` with the recorded evidence; it does not make `/` switch automatically. M5 remains blocked until its Live browser and exact-scope hardware gates pass. The legacy page is available at both `/` (current default) and `/legacy/` (transition fallback).

| Milestone | Status | Evidence / boundary |
| --- | --- | --- |
| M1 / #35 Shell and resident authentication | **Accepted** | Merged PR [#41](https://github.com/ferryhe/eufy-agent-hub/pull/41); GitHub Actions Build and test run 81 passed. Preserves resident authentication, asynchronous login/challenge feedback, EN/zh-CN and theme preferences, route guards, and the legacy entry. |
| M2 / #36 Recordings | **Accepted** | Merged PR [#42](https://github.com/ferryhe/eufy-agent-hub/pull/42); Actions run 86 passed; recorded validation: `npm test` 537/537, Chromium 17/17 at 390/1440. The sanitized L2 export was partial with explicit gaps; it did not establish browser playback or complete footage coverage. |
| M3 / #37 Jobs | **Accepted** | Merged PR [#43](https://github.com/ferryhe/eufy-agent-hub/pull/43); Actions run 89 passed; recorded validation: `npm test` 543/543, Chromium 22/22. The resident remains authoritative for IDs, pagination, cancel/retry and cleanup. |
| M4 / #38 Agent/workspace | **Accepted** | Merged PR [#44](https://github.com/ferryhe/eufy-agent-hub/pull/44); Actions run 94 passed; recorded validation: `npm test` 543/543, Chromium 25/25 at 390/1440 with scripted resident model flows. |
| M6 / #39 Historical browser playback | **Accepted; #40 dependency satisfied** | Merged PR [#45](https://github.com/ferryhe/eufy-agent-hub/pull/45) at `02dc7a94d46ffb88da1e79ae7c201e58928f70cc`; Actions run 97 passed; recorded validation: 576/576 and Chromium 36/36. Exact-scope T8600/T8030 browser hardware acceptance passed for first frame/source time, pause/resume, bounded seek, close, stop confirmation and cleanup. Other devices, playback speeds, Safari and unlisted protocol features are not inferred. |
| M5 / #40 Live page integration | **Implemented; L1 browser CI pending, L2 hardware NOT_RUN/pending** | Adds `/app/live` over resident start/status/MJPEG/stop. No start on mount, no auto-renew, one stable browser media consumer, explicit 1–60 second bound, server-authoritative resident-wide exclusivity, capability eligibility and stop confirmation on route departure. An incomplete owner returned with a startup error remains visible and can be stopped again without releasing admission early. The local runner has no authorized fresh Live hardware acceptance context. Synthetic tests do not change capability evidence. |
| M5 / #40 parity checklist and default route | **Blocked; `/` remains legacy** | M1–M4 and M6 are accepted above. The fresh Live hardware acceptance remains NOT_RUN/pending, so final default cutover and production readiness are not claimed. `/legacy/` serves the old page as a documented transition fallback. Session, job, Agent, preference and media stores and IDs remain resident-owned and unchanged. |

## M5 acceptance items

- [x] All six migration features are mapped above; M6's required historical browser playback gate passed in PR #45.
- [x] Live uses the existing resident API and existing media admission guards; it does not add a frontend lock or advertise talkback/RTSP.
- [x] Unknown/unsupported capability or an ineligible model/channel path refuses launch; a protocol hint is described as unverified.
- [x] Legacy fallback exists at `/legacy/`; old root, API, CLI, deep-link and media routes remain intact while cutover is blocked.
- [x] README and module documentation describe current entry points, installation, rollback, media prerequisites and evidence limits.
- [ ] Current-head Chromium browser tests, independent review and required CI all pass with zero open findings/threads.
- [ ] Fresh authorized T8030/T8600 Live hardware start/decoded-frame/stop/cleanup acceptance passes. If unavailable, keep this row NOT_RUN and the default cutover blocked.
- [ ] Only after all rows above pass: switch `/` to React and retain `/legacy/` for one transition release.

Merge protocol remains one scoped PR per issue, fresh independent review, fix and re-review of findings, all required CI green, no unresolved threads, then the repository's remote feedback window and cleanup. A pending hardware gate cannot be waived by fixture or Chromium-only evidence.
