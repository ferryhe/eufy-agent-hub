# Interface

The React interface is served at `/`. The original project's local login, device list, event recording search, download, and playback page remains at `/legacy/`.

```sh
node interface/server.cjs
```

Open `http://127.0.0.1:3187/` by default. If the old service occupies that port, use PowerShell:

```powershell
$env:EUFY_PORT = '3188'
node interface/server.cjs
```

The service listens only on local `127.0.0.1`. The request Host and submission Origin must match the actual port. `createServer(options)` creates a server without listening; call `.start()` to start it and, after `.close()`, await `.shutdown()` to drain owned work. Normal session restoration follows the existing [authentication contract](../capabilities/auth/README.md).

On `/legacy/`, choose **Browse recordings** for the existing login and event search/download flow, or **Ask assistant** for a natural recording request. The conversation sidebar explains/clarifies the request; the main area shows shared API device cards, normalized range timelines, durable job progress and registered players. Switching views preserves owned work. Refreshing observes the resident without paid model polling. See the [Agent interface contract](agent/README.md).

| Directory | Current status | Responsibility |
| --- | --- | --- |
| `pages/` | Migrated | Fixed feature pages |
| `components/` | Implemented | Shared cards, timelines, and players |
| `agent/` | Implemented | Resident conversation adapter, sidebar and job observation |
| `workspace/` | Runnable | Registered Agent composition, pinned references, ordering and API layout restoration |
| `i18n/` | Implemented | Shared English/Chinese catalogs, automatic browser-language matching, and manual selection |

The page defaults to the browser's preferred language, with English fallback. English/Chinese preferences are remembered locally. Fixed event searches retain their explicit `America/Toronto` behavior. Agent requests pass caller times unchanged to service normalization and display the service's effective timezone. A separate response-language preference changes explanations without rewriting names, times or earlier messages. Both modes use the [localization contract](i18n/README.md).

See the [API documentation](../api/README.md) for the current request protocol.

## React shell (`/` and `/app/`)

Issue #35 adds a Vite React/TypeScript shell. PR #46 serves it at **`/`** as well as `/app/`. Build it with `npm run app:build` (included in `npm run build`), then start the same resident with `npm start`; no second frontend server is needed. For development, run `EUFY_VITE_RESIDENT_URL=http://127.0.0.1:3187 npm run app:dev`; its proxy rewrites Host/Origin to the resident target so the existing local guards remain enabled. Production/integration testing uses the same-origin built route.

The shell reads `GET /api/v1/contract` before using typed v1 session mutations. It also reads the established `/status` compatibility projection because it carries localized asynchronous session outcomes and inventory diagnostics that the current v1 session projection does not include. Passwords, CAPTCHA answers and email codes live only in submitted form state; they are not put in browser storage, URLs or logs. Existing job and artifact reads remain resident-owned and therefore remain available after logout.

The shell's **Assistant** drawer uses `@assistant-ui/react` with an `ExternalStoreRuntime` adapter over the existing resident `/interface/agent/turn` and `/interface/agent/state` routes. It does not add another model backend, streaming protocol or cloud persistence. The shared workspace stays mounted behind the drawer and reuses the existing registered device/timeline/job/player renderer; its timeline export action remains the existing `/interface/agent/export` operation. Unsupported edit, regenerate and cancel controls are not rendered.

The recordings route selects an exact resident serial and sends one unchanged device/window to the legacy event routes and the v1 continuous range/export routes. Event results, saved event MP4s, continuous index ranges and continuous jobs stay visibly separate. The browser stores only the current export request ID and input plus known job IDs under `eufy-agent-hub.recording-workbench`; it never stores credentials, capability snapshots, job results or media paths. A refresh can safely repeat a submission whose response was lost, while terminal jobs are only observed. Changing the device/window requires an explicit new-intent acknowledgement. See [React recordings validation](react/VALIDATION.md).

The Live route is **`/app/live`**. It requires a selected camera and explicit start, keeps duration within 1–60 seconds, and displays only resident-reported `verified` or `protocol_hint` eligibility. A protocol hint is labeled as unverified. It uses the resident's one global media owner; Live, historical playback, range requests and exports continue to conflict through the existing server admission guards. The page never auto-starts or auto-renews a session, keeps the media URL stable across UI rerenders, waits for stop/cleanup confirmation before an in-app route change, and sends a bounded stop request on page exit. The resident enforces timeout, client-disconnect and shutdown cleanup. The MJPEG preview is video only, capped at five fps and 960 px; it does not expose talkback or RTSP. The 2026-09-29 exact-scope browser acceptance is tracked separately from the 2026-09-12 API hardware evidence; see [Live module evidence](../capabilities/live/README.md#react-live-page) and the [parity checklist](../docs/FEATURE_PARITY.md).

`/` is the React interface. The old page remains at **`/legacy/`** for one transition release. Returning to it does not move or delete session, jobs, recordings, Agent history, ports, or preference data. Upstream provenance and adapted file map: [`react/UPSTREAM.md`](react/UPSTREAM.md). M5 cutover status: [`docs/FEATURE_PARITY.md`](../docs/FEATURE_PARITY.md).
