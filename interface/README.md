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

The service listens only on local `127.0.0.1`. The request Host and submission Origin must match the actual port. `createServer(options)` creates a server without listening; call `.start()` to start it and `.close()` to stop it and clean up recording connections. Sessions remain in process memory, so restarting requires logging in again.

This is the migrated fixed page, not the new Agent interface. Experimental continuous recording playback is not yet connected to this page. Fixed pages and the Agent interface will eventually share the same capabilities and components.

| Directory | Current status | Responsibility |
| --- | --- | --- |
| `pages/` | Migrated | Fixed feature pages |
| `components/` | Planned | Shared cards, timelines, and players |
| `agent/` | Planned | Conversation entry, sidebar, and tool invocation status |
| `workspace/` | Planned | Dynamic result composition, pinned results, and layout restoration |

See the [API documentation](../api/README.md) for the current request protocol.
