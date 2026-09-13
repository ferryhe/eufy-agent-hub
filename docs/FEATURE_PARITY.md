# M5 feature-parity checklist

This checklist is owned by the final default-UI cutover (M5). A checked item means its scoped implementation evidence exists; it does not change the default `/` route until all M1–M6 gates are accepted.

| Milestone | Status | Evidence / boundary |
| --- | --- | --- |
| M1 / #35 React shell and resident authentication | Implemented; L1 browser passed | CI Chromium run 34761278093 at `3a34472e2115419ba45634232d9c284d28e2db81`; this final successor changes only this evidence row. Opt-in `/app/`, resident v1 mutations plus `/status` compatibility diagnostics; legacy `/` remains default. |
| M2 / #36 Recordings | Implemented; local L1 browser passed; review/CI pending | Exact resident device/window, separate legacy event and v1 continuous flows, durable intent/known-job recovery, partial/complete semantics and 390/1440 evidence. Sanitized L2 evidence is available: the single-resident export returned a playable partial result with explicit gaps; browser playback start/`currentTime` remains unverified. See [`interface/react/VALIDATION.md`](../interface/react/VALIDATION.md). |
| M3 Jobs | Pending | Business screen migration is outside #35. |
| M4 Agent/workspace | Pending | No model key is needed to browse the M1 shell. |
| M6 Historical browser playback | Pending | Required before M5 default cutover. |
| M5 default route cutover | Blocked | Requires all above parity and acceptance evidence. |
