# Architecture and migration boundaries

```text
interface (fixed pages / agent sidebar / dynamic workspace)
                         ↓
agent tools → versioned API ← cli
                         ↓
              persistent service + jobs
                         ↓
         capabilities/auth, devices, recordings, live
                         ↓
                   adapters/eufy
                         ↓
             Mega cloud APIs + HomeBase P2P
```

This diagram describes the target architecture. The currently runnable path is `interface/server.cjs` → legacy API → auth/recordings capabilities → eufy adapter.
CLI, v1 API, jobs, agent integration, and the dynamic interface are tracked in Issues; creating their directories does not implement these features.

Business capabilities are separate from presentation. CLI and agent clients will use the same API. A persistent service will own account sessions and media connections and execute long-running jobs. The agent will orchestrate tools with structured inputs and results.

Fixed pages and the agent entry point will coexist. Simple queries can return in the sidebar, while players, timelines, multiple-camera results, and export jobs can be composed in the main workspace. Registered components render the data; the model does not generate arbitrary interface code. Component state comes from actual API responses and job results.

## Migration status categories

- **Validated migration:** the prototype performed real operations on the current account or device and has offline regression tests. This does not promise production support for every model.
- **Experimental migration:** code and some hardware evidence exist, but the complete workflow or failure scenarios have not passed acceptance testing.
- **Planned:** directories and work items exist, but no CLI commands, API routes, or agent capabilities are represented as implemented.

The original project, running service, and recordings remain in their original directory. The new repository does not include account sessions, private clips, packet captures, Android packages, emulators, or debugging output.
The protocol library is an MIT-licensed source snapshot with required local changes. It installs and builds independently from its lockfile; the adapter can later switch to a separately maintained protocol package.

## Original scripts and their destinations

| Original script | New location |
|---|---|
| local-eufy-session.cjs / tests | capabilities/auth/session.cjs / session.test.cjs |
| Device list and refresh in the session | capabilities/devices/index.cjs (thin wrapper reusing the session) |
| local-recordings.cjs | capabilities/recordings/events.cjs |
| local-recording-export.cjs | capabilities/recordings/export.cjs |
| local-continuous-recordings.cjs | capabilities/recordings/continuous.cjs |
| mux-continuous-recording.py | capabilities/recordings/mux.py |
| local-recording-routes.cjs | api/legacy-recording-routes.cjs |
| local-login.cjs | interface/server.cjs |
| local-login.html | interface/pages/local-login.html |
| Local continuous-recording protocol patches | vendor/eufy-security-client/src/p2p/ and adapters/eufy |

The protocol library's release and changelog scripts are not application capabilities and were not adopted as the hub's release process.
