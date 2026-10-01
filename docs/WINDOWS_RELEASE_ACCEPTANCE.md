# Windows release acceptance record

- Baseline: `cfd16d19cd8a4e9c1ab68740f7aa26f3ca55fc6c`
- Target: Windows 11 x64 standard user, extract-and-run local Web app
- Offline fixture acceptance: run `scripts/release/accept-package.ps1 -PackageRoot <extracted-package>` and retain its console output plus the package SHA-256.
- Offline fixture subset: bundled runtime loading, synthetic codec/container/filter checks, H.264/HEVC preview JPEG generation, synthetic AAC MP4 export and full decode, temporary-data-root export/import fixtures, resident HTTP endpoints, and the React static shell.
- Browser playback (AC-4): `NOT_RUN` — this fixture run does not launch packaged Chromium/Edge, play a resident MP4, or exercise exact-scope historical playback controls. Record AC-4 separately after those browser checks are run.
- Hardware acceptance (AC-6): `NOT_RUN` — device access is not authorized. T8600/T8030 identifiers and media must remain local when authorization is later granted.
- Publication gate (AC-7): `BLOCKED` — exact corresponding-source mapping is incomplete for the selected static FFmpeg dependencies (including exact libx264 revision) and PyAV wheel bundled libraries.

Fixture success must be recorded as a passed offline subset only. It must not be described as overall package acceptance, AC-4 browser acceptance, or hardware acceptance.
