# Migration acceptance record

Date: 2026-09-11.

Migration was split into auth/devices, recordings, and interface/API work. Agents who had not implemented the corresponding modules then reviewed them independently, and the primary agent checked, corrected, and consolidated the results.
Review was limited to this capability migration, independent operation, documentation accuracy, and functional regressions. It did not attempt to validate every device feature in the upstream project.

## Checks completed

- Each mature original script has an explicit destination; see the file mapping in [ARCHITECTURE.md](ARCHITECTURE.md).
- Protocol origin, version, license, and local patches are documented; no code paths depend on the old workspace.
- Installation from the repository root, protocol build, and 17 offline tests passed.
- After installing dependencies, an offline build with a fresh npm cache passed. All four required proto/crt resources matched the sources.
- HTTP tests cover the default session, dynamic ports, pre-login status, the fixed page, and media Range responses without signing into a real account.
- With a retained UDP handle in a child process, the standalone service exits normally on both SIGINT and SIGTERM.
- Temporary synthetic video and an explicit FFmpeg path were used to validate event MP4 export and full decoding. No private footage was used.
- Auth/devices, recording capabilities, and interface modules are labeled migrated, experimental, or planned as appropriate. Fourteen follow-up Issues were created and their links checked.
- Old account sessions, Android packages, emulators, packet captures, and recording files were not copied into the repository. The old workspace remains available.

## Findings and fixes

1. The original build copied assets through an undeclared `npx copyfiles` dependency, hidden by the machine's npm cache. It now uses Node's built-in filesystem operations, and the offline build passed with an empty cache.
2. The migrated entry point initially closed only HTTP, allowing retained protocol UDP handles to keep the process alive. The standalone entry point now exits from the HTTP close callback. The module factory does not exit its caller's process, and a child-process regression test covers shutdown.

Both findings were resolved. Independent review found no remaining migration blockers.

## PR #15 inline review follow-up

- The claim that HB3 downloads unconditionally return `-104` was based on a stale TODO. The branch sends a real account-bound payload; existing source-workspace artifacts include confirmed downloads. The comment is corrected, and regression tests check the HB3 wire fields and invalid-account rejection without a new hardware operation.
- The camera selector previously excluded only T8030, allowing sensors and locks to be selected. Discovery now exposes recording eligibility based on camera type, declared download command, and HB3 association; the page filters by it and the backend independently enforces it before camera construction. Unknown devices remain in the general inventory.

## Acceptance boundaries

This migration did not sign into or operate the user's devices, complete a new continuous 20-minute hardware acceptance test, or implement CLI, v1 API, persistent jobs, or an agent.
These remain tracked follow-up work. The existence of their directories does not mean they are complete. Other device capabilities in the upstream source did not gain hardware support guarantees through this migration.

GitHub Actions installs, builds, and tests with Node 24. Consult the actual checks on the relevant commit for remote CI status.
