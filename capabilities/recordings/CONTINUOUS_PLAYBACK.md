# HomeBase 3 continuous historical playback: experimental capability

Validation date: 2026-09-10. Devices: Drive Way T8600 and HomeBase 3 T8030. Account region: CA. Time zone: America/Toronto.
Runtime code from Android App 5.0.10_4569 and LAN traffic provided the command evidence. The commands were subsequently called successfully from a computer independently of the app.

## Validation results

- Command 6000 queried 2026-08-27 16:30–16:50 and returned the complete `[1787862600,1787863800]` range with command return code 0.
- Command 6001 started continuous playback. Video frames with command 1300 and audio frames with command 1301 arrived over the VIDEO transport.
- A sample was directly extracted for 16:30:00–16:30:20: 267 video frames and 307 audio packets. The first frame was at 16:30:00.283 and the last at 16:30:19.945. A subsequent video frame reaching 16:30:20 confirmed the end boundary.
- Raw frames were HEVC/AAC. The sample changed resolution from 1920×1080 to 1280×720. Individual frame timestamps must be preserved rather than assembling at a fixed frame rate.
- The MP4 passed full decoding. The first and last watermarks were Aug 27 2026 04:30:00 PM and 04:30:19 PM.
- Direct extraction of the full 20 minutes through the new interface has not completed validation. The previously delivered 20-minute file assembled from phone recordings remains unchanged.
- Local calling code is available; the web interface does not yet expose a continuous playback timeline.

The validation sample remains in the original local workspace. Private recordings and runtime data are not migrated into the new repository.

## Wire command format

Both commands use outer P2P command 1700, with the JSON payloads below. Times are Unix seconds.

Query on camera channel 1:

```json
{"commandType":6000,"data":{"device_sn":"<camera-serial>","begin_time":1787862600,"end_time":1787863800}}
```

The response arrives through notification 1351:

```json
{"cmd":6000,"payload":{"begin_time":1787862600,"end_time":1787863800,"account":"","videos":[{"start_time":1787862600,"stop_time":1787863800}]}}
```

Start continuous playback (`account_id` comes from the current authenticated session):

```json
{"commandType":6001,"data":{"session_id":125,"cmd":0,"begin_time":1787862600,"play_speed":1,"play_type":0,"device_sn":"<camera-serial>","account_id":"<current-account-id>","index":0}}
```

Stop:

```json
{"commandType":6001,"data":{"session_id":123,"cmd":3,"begin_time":0,"play_speed":1,"play_type":0,"file_path":"","device_sn":"<camera-serial>","index":0}}
```

The continuous playback start payload omits `file_path`. Event playback supplies a recording path and uses `play_type:1`. Event file downloads are not a substitute for a continuous timeline.
This device returns historical media on channel 101, still using the VIDEO transport. Reception must be enabled on the connection before sending the start command; otherwise the library discards media packets.
The app code also contains cmd 1 for pause and cmd 2 for resume. These controls have not been validated independently from a computer and are not exposed as available capabilities.

## Local usage

Build the project first. Use an existing authenticated `LocalEufySession`; do not write passwords or sessions into scripts.

```javascript
const { LocalContinuousRecordings } = require('./capabilities/recordings/continuous.cjs');
const service = new LocalContinuousRecordings(session);
try {
  const ranges = await service.listRange('<camera-serial>', 1787862600, 1787863800);
  await service.captureRange('<camera-serial>', 1787862600, 1787862620, 'output/new-sample');
} finally {
  service.close();
}
```

The capture directory must not contain an existing `frames.bin` or `frames.json`, to prevent overwriting. Capture produces raw frames and a timestamped index. An interruption, failed command, or failure to reach the end time produces an explicit partial/failed index with diagnostics; it does not certify success.
`reachedEnd` means a frame reached or passed the requested end time; it does not prove that no frames were lost within the interval. The first displayed image starts at the first returned decodable keyframe.

After installing PyAV, run `python capabilities/recordings/mux.py output/new-sample` to generate `timed.ts` with the original timestamps.
Then use FFmpeg to convert it into an MP4 compatible with players, for example:

```text
ffmpeg -i output/new-sample/timed.ts -vf scale=1920:1080,format=yuv420p -fps_mode vfr -c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart output/new-sample/playback.mp4
ffmpeg -v error -xerror -i output/new-sample/playback.mp4 -f null -
```

After installing dependencies and building the adapter from the new repository root, run `node --test capabilities/recordings/*.test.cjs`. These tests do not connect to devices. The original project's real-device short-clip validation does not constitute full-interval acceptance in the new repository.

## Issue #6 completeness contract (rule version 1)

This remains an experimental, hardware-gated capability. The 20-minute direct capture has **not** passed acceptance. Fresh inspection of the historical 20-second index found a 1734 ms video timestamp gap (from +3.207 s to +4.941 s), despite successful full MP4 decoding. Its first video frame also starts 283 ms after the request. Under this rule it is partial, not proof of uninterrupted capture.

`captureRange` keeps `serial`, `begin`, `end`, `reachedEnd`, `bytes`, and `frames`. It adds `ranges`, per-range `segments`, `diagnostics`, `status`, and `completeness`. The requested interval is half-open `[begin, end)`, in Unix seconds; frame times are Unix milliseconds. First/last actual media times are separate from the request. Adjacent and overlapping query ranges are captured in order without duplicating their shared interval. Query gaps remain visible. Each range starts at a returned keyframe. Natural stream stops permit attempts at later ranges, but do not count as end-boundary evidence; disconnects, timeout and rejected commands stop further attempts.

**Intentional return-contract change:** acquisition failures now return `partial` or `failed` and preserve `frames.bin` plus `frames.json`, including diagnostics. Invalid requests, reused output paths, and filesystem failures which prevent a trustworthy manifest still throw. Callers must inspect `status`; a resolved promise is not success. No production API currently calls this experimental method. The original `mux.py` still requires `reachedEnd`; partial-mux handling belongs to #7 and is not implemented here.

`assessCompleteness(capture, {decode})` is the consumption contract for #7:

- **failed:** no retained video beginning with a nonempty keyframe. Empty retention, rejection before media and disconnection before media have this outcome.
- **partial:** some usable raw video exists, but any requested coverage is absent or uncertain; a query gap, positive leading/keyframe trim, non-increasing/invalid timestamp, packet gap, unproven segment boundary, truncated tail, capture diagnostic, or unverified/failed/short full decode is sufficient. Decode failure preserves potentially salvageable raw artifacts as partial; it does not certify a playable MP4.
- **complete:** no reasons remain: query ranges cover the request, each segment starts exactly at its requested boundary with a keyframe, all segment ends have timestamp evidence, observed timestamps pass the continuity checks, and full decode passes with at least the captured video frame count and duration covering the request within 100 ms. A boundary frame is evidence only and is not stored beyond the half-open request.

The timestamp rule is deliberately conservative and provisional. Within each present stream, a positive interval over the smaller of **100 ms** and **1.5 times the smallest observed positive interval** is a reported gap. The same limit applies to the final video frame's distance from the observed boundary. Any positive leading video trim is partial. This catches an isolated dropped packet in a regular cadence as well as large jumps. Gap intervals describe *unobserved time between packet timestamps*, not an assertion of the precise missing frame count or its cause. Source frame sequence numbers are not exposed by this adapter, so even a `complete` observation cannot prove a lossless source packet sequence. Variable cadence can conservatively produce partial; do not widen the rule to force a pass. A missing optional audio stream is reported by count zero; #7 must additionally enforce the requested output's stream requirements.

`decode` must describe a real check of the entire output, with `status: 'passed'`, `full: true`, `videoFrames`, and `durationMs`. Omitting evidence cannot produce complete. Raw capture always records `decode_not_verified`, so raw `status` is at most partial. #7 must preserve timestamps through mux/conversion and validate output coverage/stream contracts; passing an arbitrary decode object or checking only a subprocess exit code is not acceptance. This helper does not implement the #7 export pipeline.

## Reproducible 20-minute hardware check

The only authorized source for this runner is **Drive Way T8600 / T8030**, August 27, 2026, **16:30–16:50 America/Toronto** (`2026-08-27T20:30:00Z`–`20:50:00Z`, Unix `1787862600`–`1787863800`). It queries current retention before playback. If that window is absent, the result is failed; another window requires user selection.

Prerequisites: Node 24+, `npm ci`, `npm run setup`, `npm run build`, LAN access to the HomeBase and a normal CA-region login. The existing service on port **3187** is left running. Do not restart it, extract its session, or place credentials in commands/files. Start a separate login page and in-process capture session from this checkout:

```powershell
node capabilities/recordings/continuous-evidence.cjs capture 'output/continuous-20260827-20min-new'
```

Open **http://127.0.0.1:3188**, log in normally, and complete any eufy challenge there. No password is requested in chat or printed by this runner. Once login and device refresh finish, the page closes and capture begins automatically. Do not start another HomeBase playback during this check. The runner refuses port 3187; choose another free port with `EUFY_VALIDATION_PORT` if 3188 is occupied. Use a fresh private output directory for every attempt. **Ctrl+C** stops this runner only; during capture it closes its own connection so available frames/index can be saved. Wait for the final report before closing the terminal. A forced process kill cannot guarantee a saved index.

The initial result is intentionally partial pending decode (exit 2; failed is exit 1). It saves private `frames.bin`/`frames.json` and an `evidence.json` report containing normalized request times, actual frame boundaries, observed/query gaps, segment results and file hashes. No credentials, serials, account IDs, raw media payloads or LAN addresses are included in `evidence.json`; private raw/index/decoder logs should stay local. The report always leaves `hardwareAccepted: false` until a human/manager reviews all required evidence.

For captures reaching the end, use the existing timestamp-preserving mux and a full MP4 decode:

```powershell
python -m pip install av
python capabilities/recordings/mux.py 'output/continuous-20260827-20min-new'
# Set EUFY_FFMPEG to a local FFmpeg executable if it is not on PATH.
& $env:EUFY_FFMPEG -n -i 'output/continuous-20260827-20min-new/timed.ts' -vf 'scale=1920:1080,format=yuv420p' -fps_mode vfr -c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart 'output/continuous-20260827-20min-new/playback.mp4'
node capabilities/recordings/continuous-evidence.cjs verify 'output/continuous-20260827-20min-new'
```

If FFmpeg is on PATH, use `ffmpeg` for the conversion command instead. Verification runs full video/audio decoding with `-xerror`, preserves stderr/progress locally, and combines decoded frame count/duration with the original capture's continuity evidence. Exit 0 means the provisional observation rule found no gap; exit 2 means partial, and exit 1 means failed. None closes the hardware gate automatically. If capture ended early, preserve raw/index/diagnostics; do not edit `reachedEnd` to make mux accept it. #7 will add supported partial-artifact muxing.

Before marking hardware acceptance, retain: this report and artifact hashes; full decode logs and FFmpeg/PyAV versions; exact requested and actual first/last times; all range/frame gaps; camera/HomeBase model and firmware versions (record manually from the device settings); local beginning/end/timestamp review; and confirmation that this is a newly retained direct 20-minute capture, not phone-recording assembly. Share only sanitized statistics/hashes and device/firmware versions. If login, LAN, retention, decoding or timestamp preservation is unavailable, leave #6 open with that exact gate.
