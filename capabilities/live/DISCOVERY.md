# Live protocol discovery (L0)

Source inspection at baseline `89a4a5cf70597f42a4accdefdfc3781a5c99b557` on 2026-09-12. **Hardware acceptance: NOT RUN** — this execution has no authorized account session or HomeBase LAN. No device or firmware is verified by these findings.

## Exact owner and command path

Resolve the camera by its exact inventory `device_sn`, its HomeBase by `parent_sn`, and use the camera's `device_channel`. First delivery permits only model T8600 attached to T8030 with a nonnegative integer channel. Capture the exact device/HomeBase serials, both firmware fields and channel from `verificationScope`; unknown values stay null. The LAN adapter builds `Camera` and `Station` from that same inventory, sets `P2PConnectionType.ONLY_LOCAL`, and checks the connected owner before any start.

`vendor/eufy-security-client/src/http/station.ts`, `Station.startLivestream(camera, VideoCodec.H264)` checks station ownership, declared commands and existing streaming. For T8600 inventory type PROFESSIONAL_247 (`isCameraProfessional247`) it calls `sendCommandWithStringPayload` with outer `CMD_SET_PAYLOAD = 1350`, JSON `cmd = mValue3 = CMD_START_REALTIME_MEDIA = 1003`, `payload.ClientOS = Android`, requested H264 `streamtype = 1`, and `channel = camera.getChannel()`. The payload includes the account identifier and RSA public key; never put these values in public evidence. Other device types can reach a generic older-firmware/integrated-device branch using direct command 1003; this is not the T8600 PROFESSIONAL_247 branch. The offline Station-method test asserts the exact 1350/1003 payload and 1004 stop; observe the inventory type and commands again during hardware acceptance.

`Station.stopLivestream(camera)` calls `sendCommandWithInt` with `CMD_STOP_REALTIME_MEDIA = 1004`, `value = channel = camera.getChannel()`. A stop after an unacknowledged start still requires dedicated connection destruction; lack of streaming state is not cleanup evidence.

Observe P2P `command` results (channel, command_type, return_code), `livestream started(channel, metadata, video, audio)`, `livestream stopped(channel)`, `close`, and station `connection error`. Station translates the stream events to `livestream start` / `livestream stop`, adding the station argument. Metadata distinguishes H264/H265 and audio NONE/AAC/AAC_LC/AAC_ELD/UNKNOWN; actual codecs must be recorded. This delivery requests H264 and exports video only; audio is drained and destroyed. An event is not full-decode proof.

## Cleanup finding

`P2PClientProtocol.close()` clears many timers and disconnects but leaves the UDP socket allocated; `onClose()` recreates a socket. `Station.close()` is synchronous and skips an unconnected/connecting P2P session. A dedicated live owner therefore needs permanent asynchronous destruction: disable station reconnect, clear lookup/connection/heartbeat/keepalive/message/stream timers, end/destroy streams, close the UDP socket without its rebuild listener, and await close. Keep the JobService HomeBase slot until this and FFmpeg child `close` complete. Existing reusable station `close()` behavior must remain available to other callers.

## Offline evidence boundary

Fault fixtures exercise connection admission, command/channel matching, rejection, timeout, authentication loss, child/media errors, repeated calls, and cleanup. Synthetic H264 → resident media → full FFmpeg decode tests prove only offline runtime integration. Neither those tests nor protocol declarations create a `verified` capability record. Talkback and RTSP are not exposed by this delivery.

See [ACCEPTANCE.md](ACCEPTANCE.md) for the opt-in real-device procedure.
