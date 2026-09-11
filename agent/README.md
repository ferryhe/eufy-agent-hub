# Agent (Planned)

This directory is reserved for structured tool definitions, tool adapters, and Agent orchestration. No Agent SDK has been installed, no model has been selected, and no monitoring has been started.

The Agent will use available capabilities and job APIs to find devices, query recordings, create exports, track progress, and return files. Device IDs, available ranges, job states, and artifacts must come from tool results.
Tools will not directly expose unknown P2P command numbers or accept account passwords as ordinary model parameters.

Initial tools: `get_session_status`, `list_devices`, `get_device_capabilities`, `list_recording_ranges`, `create_recording_export`, `get_job`, `cancel_job`, and `get_artifact`.
MCP can provide an adapter entry point but does not replace the persistent service. The CLI, web interface, and Agent will share that service.

First acceptance criterion: a natural-language request specifying a device and time range creates a real export job and returns a playable file with its actual coverage when complete. If the session is unavailable, the flow must correctly direct the user to login.

See the Issues table in the root [README](../README.md) for implementation progress.
