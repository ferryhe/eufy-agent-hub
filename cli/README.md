# CLI (Planned)

This directory is reserved for the persistent service's command-line client. There is currently no `eufy` executable. The client will not log in again or open an independent HomeBase connection for each command.

Initial command scope: `auth status/login`, `devices list/capabilities`, `recordings ranges/export`, `jobs get/cancel`, and `artifacts get`.
Commands and the HTTP API will share input and output contracts. With `--json`, stdout will contain only structured results, progress will go to stderr, and failures will use stable error codes and nonzero exit codes.

Long exports will immediately return a `jobId`, with an option to wait. Exiting the terminal will not cancel jobs in the service. This work depends on the versioned API and jobs layer.

See the Issues table in the root [README](../README.md) for implementation progress.
