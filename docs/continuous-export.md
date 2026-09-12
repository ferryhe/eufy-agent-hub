# Continuous recording export service

`capabilities/recordings/continuous-export.cjs` connects the persistent Phase A jobs contract to the T8030/T8600 continuous recording path. Instantiate it once in a resident process with an authenticated session. A submitting HTTP/CLI client may exit after receiving the job ID. Public v1 transport belongs to Issue #2; this module does not add an HTTP endpoint or replace the existing event recording page.

```js
const { ContinuousExportService } = require('./capabilities/recordings/continuous-export.cjs');
const exporter = new ContinuousExportService({ session });
const accepted = exporter.submit({
  requestId: 'client-request-id',
  serial: 'resolved-camera-serial', homeBaseId: 'resolved-parent-homebase-serial',
  day: '2026-08-27', start: '16:30', end: '16:50', timezone: 'America/Toronto',
});
// Return accepted.jobId immediately; processing belongs to this resident service.
const snapshot = exporter.get(accepted.jobId);
```

This internal interface expects the caller to supply a **trusted, resolved** camera and its real HomeBase ID, not a caller-chosen conflict key. Device mapping/capability policy belongs to Issue #4 and the service adapter. The acceptance runner resolves and checks the camera and parent from the normal authenticated inventory. One HomeBase runs one media job at a time through validation. Different HomeBases can progress independently. Do not simultaneously use an unrelated exporter/session to operate the same HomeBase.

Submission uses the [shared time contract](recording-time-window.md): original input and normalized UTC instants plus IANA timezone are persisted. Ambiguous/nonexistent DST times and cross-midnight input are rejected before a job is allocated. Omitted timezone uses `EUFY_RECORDING_TIMEZONE`, default Toronto. Reusing a `requestId` returns the original job, input and files, even after failure or a changed second request. Use a new ID for an intentional new attempt. It is not an automatic retry.

## Runtimes and output

Configure `EUFY_PYTHON` to a Python executable with PyAV installed, and `EUFY_FFMPEG` to FFmpeg with libx264/AAC support. Constructor `python`/`ffmpeg` options override environment variables. Defaults are `python` and `ffmpeg` on PATH. Runtime probes occur before device acquisition; executable absence, import failure, and media errors leave their stage logs and a diagnostic result. PyAV 18.1.0 and FFmpeg 7.1 were exercised during this delivery; other builds must supply the same codecs/features.

Default output is `<repository>/output/continuous-jobs/<jobId>/`, independent of working directory. Optional `outputRoot` must stay below this repository's `output/`. Use one resident writer per store. Jobs own unique UUID directories:

- `metadata.json`: durable queued/running/terminal state, stage and progress, original/normalized request, result and owned artifact index.
- `partial/capture/frames.bin` and `frames.json`: original raw packets, absolute timestamps, queried ranges, acquisition diagnostics and segment boundaries.
- `partial/capture/timed.ts`: timestamp-preserving packet mux, including salvageable captures that did not reach the end.
- `partial/logs/`: Python/PyAV and FFmpeg probes, mux, conversion, complete decode and timeline logs.
- `partial/capture/media-timeline.json`: independently decoded MP4 video/audio counts and first/last presentation timestamps.
- `partial/result.json`: completeness, requested/observed coverage, timeline mapping, errors and playable-file designation.
- `artifacts/playback.mp4`: only a fully decoded, complete output. A fully decoded **partial** output stays at `partial/capture/playback.mp4` and is explicitly labelled partial. Unverified/corrupt files also remain there for diagnosis but have no playable designation.

Raw files and diagnostics are registered with `validated:false`. Artifact existence is never proof of success. Disk/storage faults still fail closed; already written files remain inspectable even if metadata registration itself cannot finish. On Windows, temporary sharing denials during atomic metadata replacement receive at most five retries (150 ms total wait); permanent errors propagate while preserving the previous snapshot.

## Stages and result

Progress records stage milestones: runtime, capture, mux, convert, decode, and completed. The capture stage does not estimate remaining wall time. The pipeline muxes original packet timestamps, converts with variable frame timing, fully decodes all output video and any audio with FFmpeg error checking, then decodes presentation timestamps through PyAV. Video duration is measured from video frames, not an audio tail or container duration.

The result includes `window`, observed absolute `coverage`, `timeline`, `completeness`, `validation`, `media` and `diagnostics`. Coverage describes received first/last timestamps and detected gaps; it is not a claim that every instant between them exists. The MP4's relative presentation timeline is separate. `timeline.mp4ZeroUnixMs` maps MP4 timestamps back to acquisition time using the timestamp-preserving TS start offset; first video timestamp and span are checked with a 100 ms tolerance. Raw versus decoded frame counts are retained. Transcoding does not establish a one-to-one packet/frame correspondence.

The merged Issue #6 rule version 2 remains authoritative: range gaps, observed video/audio timestamp gaps or discontinuities, missing boundaries, missing initial keyframe, acquisition errors, or short/unverified decode forbid `complete`. Video gap tolerance is median observed positive cadence × 1.5, capped at 100 ms. Decoding checks output frame count and video duration against raw/request evidence. An output timeline mismatch also forbids complete. When raw audio exists, output audio must retain at least its packet count and match its first timestamp and span within 100 ms. Decoder/encoder losses are conservatively partial, even if the output plays.

| Result | Durable state | Consumption |
| --- | --- | --- |
| `complete`, verified coverage, full decode passed | `succeeded` | Complete playable export |
| `partial` | `failed`, with `result.outcome:'partial'` | Use `media` only if explicitly present and playable; inspect missing coverage and diagnostics |
| `failed` | `failed` | No usable capture/runtime or stage failure without salvageable evidence |
| `cancelled` | `cancelled` | Service stopped its work; retained files remain diagnostic |

A successful process exit, received end boundary, MP4 existence, or short playable output cannot alone make a job succeed. Capture failures with usable raw data still attempt mux/conversion/validation. Later stage failures preserve raw/intermediate files and logs, and never advertise an unvalidated candidate as playable.

## Shutdown and restart

`await exporter.shutdown()` rejects new work, cancels queued jobs, aborts this service's active capture or child process, and waits until workers settle. A submitted client's disconnection does not call shutdown. Acquisition stop waits for in-progress readiness to settle and closes any resulting connection before the job slot is released. A child process is awaited through `close` after termination.

`exporter.cancel(jobId)` provides per-job operator cancellation. Running work keeps its HomeBase slot until cleanup settles and then persists `cancelled`; the last stage and partial evidence remain available. Each runtime check, capture and media stage receives a combined job/service abort signal, checked before and after processing so cancellation cannot start a later mux, conversion or decode stage. The [v1 API](../api/v1.md) exposes this as `POST /api/v1/jobs/:jobId/cancel`.

After a crash, instantiate once against the same store only after the old owner and its media processes have stopped. Queued jobs resume in their original FIFO order because execution never began. Previously running jobs become `failed` with `JOB_INTERRUPTED`, preserving the last stage, progress, registered artifacts and saved diagnostics. Persisted cancellation requests become `cancelled`. No running or failed export is replayed implicitly; duplicate request identity still returns the original job. `exporter.retry(jobId, { requestId: 'new-id' })` or the [v1 retry endpoint](../api/v1.md) creates a fresh linked attempt and fresh output directory while retaining the original evidence. The service keeps existing public terminal states, and queued recovery without a valid session fails with `LOGIN_REQUIRED` before capture.

## Tests and real-device acceptance

`npm test` includes deterministic pipeline, stage failure, identity, serialization foundation, shutdown, subprocess interruption and real resident-process restart tests. To run the actual synthetic media tests, set both runtime variables and run:

```text
node --test capabilities/recordings/continuous-export-media.test.cjs
```

These generate a 60-second synthetic clip and exercise complete, gapped and interrupted captures through the actual runtimes. They are not hardware evidence. The retained real 20-minute Issue #6 raw capture was separately copied and processed through this service: full video/audio decode passed, while the existing real gaps correctly produced **partial**, not successful complete coverage.

For a fresh one-call hardware run, keep the old service on 3187 untouched. Configure both runtimes, then run the reviewed acceptance helper in the repository:

```text
node capabilities/recordings/continuous-export-evidence.cjs <new-request-id>
```

Sign in normally on the separate local page (3188 by default; `EUFY_VALIDATION_PORT` may select an unused port, never 3187). Do not put credentials in chat, command lines or evidence. After authentication and an idle login page, the helper closes that page, resolves exactly one Drive Way T8600 on T8030, and submits only August 27, 2026, 16:30–16:50 America/Toronto. If that recording is not retained, preserve the honest failure/partial result; do not silently choose another window. The helper prints the job ID and durable metadata path. Exit 0 means complete, 2 partial, 1 failed/cancelled; hardware acceptance still requires evidence review.

Preserve the full job directory, runtime logs, source/MP4 SHA-256 hashes, requested/actual windows, firmware/model observations, all completeness reasons, full decode counts/duration, and acquisition-to-MP4 timeline check. Keep account/device identifiers and private media local; publish only sanitized summaries. For review, distinguish a fresh hardware pipeline run from offline reprocessing of the earlier capture. Never substitute synthetic data for device acceptance.
