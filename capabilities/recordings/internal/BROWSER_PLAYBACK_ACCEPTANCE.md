# T8600/T8030 browser playback acceptance

This is the maintainer-only entry for the real-hardware check added with browser
historical playback. It drives the normal React workbench and public HTTP routes
against **one already-running loopback resident**. It never starts or stops a
resident, logs in or out, changes capability records, takes screenshots, or
persists decoded pictures. In particular, it must not stop the resident on port
3187 or create a second P2P owner.

The maintainer/controller must first coordinate an idle resident and a private
T8600/T8030 account. Choose two 1–60 second, same-day windows, each fully inside
one continuous-recording row. The second window is the seek target. Do not paste
the camera serial, frames, session file, or generated evidence into terminals,
Issue/PR text, or CI logs.

Set the following values in the manager's private environment, then run the one
entry command. `EUFY_BROWSER_ACCEPTANCE_ORIGIN` must be an existing loopback HTTP
origin. `EUFY_BROWSER_ACCEPTANCE_EVIDENCE` must be a fresh absolute `.json` path
outside this repository.

```powershell
$env:EUFY_BROWSER_ACCEPTANCE_ACK = 'manager-authorized-single-owner'
$env:EUFY_BROWSER_ACCEPTANCE_ORIGIN = 'http://127.0.0.1:<existing-port>'
$env:EUFY_BROWSER_ACCEPTANCE_EVIDENCE = '<private-absolute-path>.json'
$env:EUFY_BROWSER_ACCEPTANCE_SERIAL = '<private-T8600-serial>'
$env:EUFY_BROWSER_ACCEPTANCE_DAY = 'YYYY-MM-DD'
$env:EUFY_BROWSER_ACCEPTANCE_START = 'HH:mm'
$env:EUFY_BROWSER_ACCEPTANCE_END = 'HH:mm'
$env:EUFY_BROWSER_ACCEPTANCE_SEEK_DAY = 'YYYY-MM-DD'
$env:EUFY_BROWSER_ACCEPTANCE_SEEK_START = 'HH:mm'
$env:EUFY_BROWSER_ACCEPTANCE_SEEK_END = 'HH:mm'
node capabilities/recordings/internal/browser-playback-acceptance.cjs --run-hardware
```

Before opening Chromium, the entry requires authenticated/connected/idle v1 and
legacy status and an exact verified T8600 + T8030 firmware/channel scope with
speed-1 pause/resume. It then verifies a keyboard-started real canvas frame and
measured first-frame latency, a six-second pause with frozen canvas and source
label, resume with a fresh decoder epoch and advancing source position, bounded
seek with old-session cleanup before the replacement, and final close with all
resources closed and the resident idle. Both the replaced owner and the final
owner must report their own matching `stopConfirmed:true`; resource cleanup alone
cannot produce PASS. No automatic replay or reconnect occurs.

The private evidence document uses
`eufy-agent-hub/browser-playback-acceptance/v1`. It contains the exact private
device/HomeBase serial, model, firmware and channel scope, both requested
windows, Chromium version/viewport/language, source-received positions,
frame/epoch counters, browser and server-first-JPEG latency, pause wall time, and
the observed stop-confirmation/cleanup booleans for both owners.
It contains no JPEG/PNG bytes, screenshot, account, session path, IP address,
P2P payload or media path. The program's stdout is a fixed PASS/FAIL line and
does not reveal the evidence path or device identity.

The evidence always records Safari as `NOT_RUN`, `userWaived: true` and
`mergeBlocker: false`. This is the user-approved Safari exception; it must not be
described as Safari verification. Desktop Chromium plus the synthetic 390/1440
and English/zh-CN checks remain required separately.
