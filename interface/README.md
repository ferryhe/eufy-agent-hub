# Interface

The original project's local login, device list, event recording search, download, and playback page has been migrated here.

```sh
node interface/server.cjs
```

Open `http://127.0.0.1:3187/` by default. If the old service occupies that port, use PowerShell:

```powershell
$env:EUFY_PORT = '3188'
node interface/server.cjs
```

The service listens only on local `127.0.0.1`. The request Host and submission Origin must match the actual port. `createServer(options)` creates a server without listening; call `.start()` to start it and, after `.close()`, await `.shutdown()` to drain owned work. Normal session restoration follows the existing [authentication contract](../capabilities/auth/README.md).

Choose **Browse recordings** for the existing login and event search/download flow, or **Ask assistant** for a natural recording request. The conversation sidebar explains/clarifies the request; the main area shows shared API device cards, normalized range timelines, durable job progress and registered players. Switching views preserves owned work. Refreshing observes the resident without paid model polling. See the [Agent interface contract](agent/README.md).

| Directory | Current status | Responsibility |
| --- | --- | --- |
| `pages/` | Migrated | Fixed feature pages |
| `components/` | Implemented | Shared cards, timelines, and players |
| `agent/` | Implemented | Resident conversation adapter, sidebar and job observation |
| `workspace/` | Runnable | Registered Agent composition, pinned references, ordering and API layout restoration |
| `i18n/` | Implemented | Shared English/Chinese catalogs, automatic browser-language matching, and manual selection |

The page defaults to the browser's preferred language, with English fallback. English/Chinese preferences are remembered locally. Fixed event searches retain their explicit `America/Toronto` behavior. Agent requests pass caller times unchanged to service normalization and display the service's effective timezone. A separate response-language preference changes explanations without rewriting names, times or earlier messages. Both modes use the [localization contract](i18n/README.md).

See the [API documentation](../api/README.md) for the current request protocol.

## Opt-in React shell (`/app/`)

Issue #35 adds a Vite React/TypeScript shell at **`/app/`**. Build it with `npm run app:build` (included in `npm run build`), then start the same resident with `npm start`; no second frontend server is needed. For development, run `EUFY_VITE_RESIDENT_URL=http://127.0.0.1:3187 npm run app:dev`; its proxy rewrites Host/Origin to the resident target so the existing local guards remain enabled. Production/integration testing uses the same-origin built `/app/` URL.

The shell reads `GET /api/v1/contract` before using typed v1 session mutations. It also reads the established `/status` compatibility projection because it carries localized asynchronous session outcomes and inventory diagnostics that the current v1 session projection does not include. Passwords, CAPTCHA answers and email codes live only in submitted form state; they are not put in browser storage, URLs or logs. Existing job and artifact reads remain resident-owned and therefore remain available after logout.

`/` is still the legacy interface. Roll back from this opt-in shell by opening `/` (or remove `/app/` links) without moving or deleting session, jobs, recordings, Agent history, ports, or preference data. Upstream provenance and adapted file map: [`react/UPSTREAM.md`](react/UPSTREAM.md). M5 cutover status: [`docs/FEATURE_PARITY.md`](../docs/FEATURE_PARITY.md).
