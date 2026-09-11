# Live video: wrapping and validation pending

The protocol source already contains live video and talkback implementations. This directory does not yet provide a stable capability interface, and the new client has not validated these features on each device.

Planned work includes start/stop operations, media consumption, connection cleanup, and error results. Validation will begin with the current HomeBase 3 and cameras; talkback and RTSP will be exposed only when supported by the device.

Live video and historical playback share HomeBase media resources. Conflict handling must be coordinated with jobs and connection management, without silently taking over active playback.

See the Issues table in the root [README](../../README.md) for implementation tracking.
