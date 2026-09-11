# Recording capabilities

This directory was migrated from the local eufy prototype. All protocol dependencies go through `../../adapters/eufy`.
Callers provide an authenticated session; these modules do not store passwords or take over another service's login state.

| File | Function | Maturity |
|---|---|---|
| `events.cjs` | Event date index, device filtering, confirmed download completion | Validated in the source project and migrated; currently limited to HomeBase 3 on the same LAN |
| `export.cjs` | Export confirmed raw downloads to MP4 and verify by decoding the entire file | Validated in the source project and migrated; requires FFmpeg |
| `continuous.cjs` | Query continuous ranges with 6000, play history with 6001, and save timestamped raw frames | Experimental; only a short clip has been validated on a real device |
| `mux.py` | Generate MPEG-TS using individual frame timestamps | Experimental; requires Python and PyAV, and is not integrated with background jobs |

## Event recordings

Run this example from the repository root. `session` is an authenticated session provided by the auth capability.

```javascript
const path = require('node:path');
const { LocalRecordings } = require('./capabilities/recordings/events.cjs');
const { exportRecording } = require('./capabilities/recordings/export.cjs');
const service = new LocalRecordings(session);
try {
  const records = await service.listDay(cameraSerial, '2026-08-27');
  if (!records.length) throw new Error('No event index for this date; continuous recordings may still exist.');
  const directory = path.resolve('output', 'my-export');
  const download = await service.download(records[0].record_id, directory);
  const result = await exportRecording(download.prefix, path.join(directory, 'event.mp4'));
} finally {
  service.close();
}
```

Callers choose the output directory; the CLI/API should use a directory beneath this repository's `output/`.
Raw video, audio, and metadata are retained. A download is recorded as successful only after the device sends its completion notification and file writes finish.
Exports must also pass a full decoding check. Event downloads currently time out after 90 seconds. An event list is not a continuous playback timeline.

The HB3 download branch sends an account-bound `CMD_SET_PAYLOAD` request with the camera channel, recording path, and download RSA public key. Its former unsupported TODO was stale; a device can still reject a request with `-104` (invalid account), which is returned as a failed download rather than recorded as success. Offline tests exercise that branch and rejection handling. Prior source-project acceptance is limited to the documented CA/LAN setup, not every HB3 firmware.

FFmpeg uses the executable specified by `EUFY_FFMPEG`, falling back to `ffmpeg` on `PATH`.
If FFmpeg is missing, the module returns an installation/configuration hint; it does not depend on the old repository's private runtime.
For explicit caller timezones, normalize a window with `time-window.cjs`, query
with `service.listWindow(serial, window)`, and pass the window as the third
argument to `service.download`. Export preserves this context in MP4 metadata
and a JSON sidecar. See the [recording time-window contract](../../docs/recording-time-window.md)
for defaults, DST rejection, device-calendar bounds and unknown actual coverage.

## Continuous recordings

Commands 6000/6001 have been independently called and used to obtain a short clip. This capability no longer relies on the earlier 1025/1026 guesses.
See [CONTINUOUS_PLAYBACK.md](CONTINUOUS_PLAYBACK.md) for commands, usage, and limitations.
Long recordings, interrupted connections, time gaps, automatic conversion, and task recovery have not completed acceptance validation. See the [issue drafts](../../docs/issues/recordings.md).

Tests: run `node --test capabilities/recordings/*.test.cjs` from the repository root after building the protocol adapter dependency.
