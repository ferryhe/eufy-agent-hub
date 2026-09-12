# Live video sessions

The resident service exposes scoped, video-only live sessions through the [v1 API](../../api/v1.md). The T8600/PROFESSIONAL_247 → T8030 protocol path is implemented and tested offline. **Hardware acceptance has not run in this environment.** Existing capability records remain unchanged: a protocol declaration is `protocol_hint`, not `verified`. An unverified path requires `allowUnverified: true` on each new start request. Talkback and RTSP are not exposed or promoted by this module.

```json
{"serial":"YOUR_CAMERA_SERIAL","requestId":"one-live-attempt","allowUnverified":true}
```

POST this to `/api/v1/live-sessions`, then immediately GET the returned `live.mediaUrl`. GET `/api/v1/live-sessions/:sessionId` for status and POST `{}` to `/api/v1/live-sessions/:sessionId/stop` to stop. The media is an HTTP streamed fragmented MP4 with H264 video and no audio, suitable for FFmpeg, CLI and other streaming clients. It is a forward-only single-consumer response; it is not a seekable recording or HTTP Range resource. The service decodes/re-encodes the incoming H264/H265 video with FFmpeg/libx264. Unsupported input codecs fail explicitly.

Session IDs and exact request IDs are stable within one resident process. Repeating a request ID returns its original session; changing its camera returns `LIVE_REQUEST_CONFLICT`. A new attempt needs a new request ID. Repeated stop returns the same terminal session. Sessions are ephemeral and do not resume after restart. Status includes the exact device/HomeBase/firmware/channel scope, timestamps, input codec, received bytes, command/channel diagnostics, `stopConfirmed`, `cleanupComplete` and structured error.

## Ownership and deadlines

Interactive sessions use `JobService.acquireMedia`, the same active HomeBase map and FIFO as export jobs. A live start rejects previously queued/running historical work with `SERVICE_BUSY`; accepted history is never preempted. API playback, range, legacy operations and session replacements are conservatively excluded while live owns media. Direct job submissions to the resident JobService queue behind a live lease. Playback and range acquisition also use that map. Release happens only after all dedicated protocol, stream and child cleanup completes.

Production deadlines are 15 seconds for setup/media startup, 15 seconds without input video, 10 seconds to attach the media consumer after start, and 1.5 seconds for stop acknowledgment. Authentication/session identity is checked before admission, after asynchronous setup and every second while active. Client disconnect from the pending start or attached media response stops the owned session; a lost start response without a detected disconnect is bounded by the attachment deadline. Only one media consumer may attach. A second receives `LIVE_MEDIA_CLAIMED`.

Explicit stop, logout and shutdown allow up to 10 seconds for healthy attached media to flush through the response. Success waits for FFmpeg exit, buffered MP4 readable end and response finish, so a retained sample can be fully decoded. A stalled drain reports LIVE_MEDIA_TIMEOUT; disconnect during drain reports LIVE_CONNECTION_LOST; abnormal FFmpeg exit reports LIVE_DECODER_ERROR. These failed-media outcomes release ownership only after resources close; an actual cleanup failure still retains ownership. Decoder errors, offline/connection loss and client loss force cleanup. Child termination escalates to SIGKILL after one second and awaits `close`; protocol destruction closes the UDP socket without vendor reconnect/socket replacement. A failed cleanup retains ownership and returns `LIVE_CLEANUP_FAILED`; do not start a second resident on top of that owner. Stop rejection/timeout is recorded even when local resources clean up successfully; `stopConfirmed: false` is never hardware stop proof.

Use [DISCOVERY.md](DISCOVERY.md) for command evidence and [ACCEPTANCE.md](ACCEPTANCE.md) for exact opt-in hardware acceptance. The tests include fault injection, real local UDP cleanup and a real synthetic FFmpeg → HTTP → retained-sample full decode. Those checks are **offline** and do not create capability verification records.

```sh
EUFY_FFMPEG=/path/to/ffmpeg node --test capabilities/live/*.test.cjs api/live-routes.test.cjs
```
