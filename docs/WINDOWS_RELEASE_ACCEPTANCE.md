# Windows release acceptance record

- Baseline: `cfd16d19cd8a4e9c1ab68740f7aa26f3ca55fc6c`
- Target: Windows 11 x64 standard user, extract-and-run local Web app
- Offline fixture acceptance: run `scripts/release/accept-package.ps1 -PackageRoot <extracted-package>` and retain its console output plus the package SHA-256.
- Offline fixture subset: bundled runtime loading, synthetic codec/container/filter checks, H.264/HEVC preview JPEG generation, synthetic AAC MP4 export and full decode, temporary-data-root export/import fixtures, resident HTTP endpoints, and the React static shell.
- Offline synthetic browser playback (AC-4): run `scripts/release/accept-ac4-package.ps1 -PackageRoot <extracted-package>`. It uses the extracted package's Node, Python/PyAV, FFmpeg, resident HTTP server, and built React assets. It generates an H.264/AAC MP4, fully decodes it with PyAV, plays event and continuous copies in Chromium, checks time advance, decoded pixels and observable AAC audio, then runs the exact-scope synthetic T8600/T8030 historical fixture for first frame, pause, resume, bounded seek, close, and the explicit unverified state.
- AC-4 synthetic boundary: all device identities, firmware, verification evidence, P2P packets, event manifests, job state, and media are generated offline. Chromium is supplied by the Playwright acceptance environment and is not bundled. This does not access or validate a real resident account, retained recording, or device.
- Hardware acceptance (AC-6): `NOT_RUN` — device access is not authorized. T8600/T8030 identifiers and media must remain local when authorization is later granted.
- Publication gate (AC-7): `BLOCKED` — the shipped README identifies x264 `v0.165.3223`, but artifact-specific source/build/license correspondence remains incomplete for the selected static FFmpeg dependencies and PyAV wheel bundled libraries.

The base fixture success must be recorded as a passed offline subset only. A successful `accept-ac4-package.ps1` run is AC-4 offline synthetic acceptance; it must not be described as hardware acceptance or as AC-6.
