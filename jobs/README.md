# Background Jobs (Planned)

The current legacy API only has an in-memory `busy` state within one process. It has no persistent jobs, `jobId`, restart recovery, or cancellation endpoint. This directory does not contain a runnable job service.

The future service should manage `queued`, `running`, `validating`, `completed`, `failed`, and `cancelled` states, along with three processing stages: recording reception, container conversion, and decode validation.
The service will queue media operations for the same HomeBase, and repeated `requestId` values will return the same job. If an operation cannot safely resume after a restart, the service must explicitly mark it as interrupted and offer an explicit retry instead of silently duplicating the export.

Completed results will record the requested range, actual first and last frames, whether coverage has been verified, the file location, and validation results. Ending a terminal session or Agent turn must not stop background jobs.

See the Issues table in the root [README](../README.md) for implementation progress.
