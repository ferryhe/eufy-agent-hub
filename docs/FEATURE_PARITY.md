# M5 feature-parity checklist

This checklist is owned by the final default-UI cutover (M5). A checked item means its scoped implementation evidence exists; it does not change the default `/` route until all M1–M6 gates are accepted.

| Milestone | Status | Evidence / boundary |
| --- | --- | --- |
| M1 / #35 React shell and resident authentication | Implemented; L1 browser passed | CI Chromium run 34759526195 at `da5a0b693d0382255b478b54561581efaa184cb8`; opt-in `/app/`, resident v1 mutations plus `/status` compatibility diagnostics; legacy `/` remains default. |
| M2 Recordings | Pending | Business screen migration is outside #35. |
| M3 Jobs | Pending | Business screen migration is outside #35. |
| M4 Agent/workspace | Pending | No model key is needed to browse the M1 shell. |
| M6 Historical browser playback | Pending | Required before M5 default cutover. |
| M5 default route cutover | Blocked | Requires all above parity and acceptance evidence. |
