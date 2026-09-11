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

The capture directory must not contain an existing `frames.bin`, to prevent overwriting. Successful capture produces raw frames and a timestamped index. An interruption, failed command, or failure to reach the end time does not produce a success index.
`reachedEnd` means a frame reached or passed the requested end time; it does not prove that no frames were lost within the interval. The first displayed image starts at the first returned decodable keyframe.

After installing PyAV, run `python capabilities/recordings/mux.py output/new-sample` to generate `timed.ts` with the original timestamps.
Then use FFmpeg to convert it into an MP4 compatible with players, for example:

```text
ffmpeg -i output/new-sample/timed.ts -vf scale=1920:1080,format=yuv420p -fps_mode vfr -c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart output/new-sample/playback.mp4
ffmpeg -v error -xerror -i output/new-sample/playback.mp4 -f null -
```

After installing dependencies and building the adapter from the new repository root, run `node --test capabilities/recordings/*.test.cjs`. These tests do not connect to devices. The original project's real-device short-clip validation does not constitute full-interval acceptance in the new repository.
