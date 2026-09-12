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

Live video uses the resident [v1 live-session contract](../capabilities/live/README.md). Embedded hosts must begin `server.shutdown()` while HTTP closes: an active media response needs owned cleanup before HTTP can drain. Await both operations before exiting.
