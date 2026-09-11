# Recording capability follow-up issues

This file records features unfinished at migration time as drafts for repository maintainers. Drafts do not imply acceptance. See the [issue index](README.md) for the created remote work items.

## Continuous recording: Complete long-duration export and completeness validation

**Existing evidence:** On HomeBase 3 T8030 / T8600, independent calls to the 6000 range query, 6001 playback and approximately 20 seconds of raw-stream capture succeeded. The short clip passed full decoding. The new repository retains this code and offline tests.

**Gaps/scope:** `continuous.cjs` currently confirms only that the end boundary was received; it cannot prove the absence of gaps within the interval. Capture begins at the first keyframe, and spanning several adjacent recording ranges is unsupported. A complete direct 20-minute export has not been validated.

**Acceptance criteria:**

- Export a still-available continuous 20-minute recording from a real device, recording the requested time zone/range, actual first/last frame times and missing intervals.
- Decode the entire file successfully. If frames are missing, timestamps jump or only part of the interval is available, return a partial result with explicit status rather than reporting complete success.
- Add automated coverage for adjacent ranges, gaps between ranges, no recordings, device disconnection and command rejection.

**Dependencies:** An authenticated session, a HomeBase 3 available on the LAN, and user-selected recordings that are still retained; protocol-adapter support for 6000/6001. Deleting device recordings is unnecessary.

## Continuous recording: Connect capture and muxing to export jobs

**Existing evidence:** `captureRange` produces frames and a timestamp index, and `mux.py` can generate `timed.ts`. MP4 conversion and decoding validation remain manual steps.

**Gaps/scope:** Build a complete continuous-export service call that runs capture, timestamp-preserving muxing, MP4 conversion and full decoding in order, for use by the CLI/API/Agent. UI implementation is outside this issue.

**Acceptance criteria:**

- One job invocation provides a playable MP4, actual coverage and progress.
- Missing PyAV/FFmpeg produces a diagnosable error. Failure at any stage preserves diagnostic status and never registers a successful file.
- All outputs go to job directories under this repository's `output/`; repeated jobs do not overwrite existing captures.
- Test cancellation, disconnection and process restart, agreeing with the shared jobs capability on partial-file handling and recovery behavior.

**Dependencies:** The shared jobs capability; completeness assessment from the preceding issue; configurable Python/PyAV and FFmpeg runtimes.

## Recording time: Remove the single-Toronto-time-zone assumption

**Existing evidence:** Toronto time parsing in the current event entry point handles daylight saving time. Event-export metadata still hardcodes `America/Toronto`. Continuous playback uses Unix seconds.

**Gaps/scope:** Unify the time-zone contract for date queries, CLI/API requests, Agent tools and export metadata.

**Acceptance criteria:**

- Allow callers to explicitly supply an IANA time zone, with a configurable default shown in responses.
- Never silently choose an incorrect interpretation of nonexistent or repeated local times. Explicitly support or reject cross-midnight intervals.
- Test at least Toronto summer/winter times, DST transitions and one other time zone; exported time-zone metadata matches the request.

**Dependencies:** API time-window parsing and CLI/Agent input contracts; the migrated event-query and export capabilities.

## Continuous playback: Verify and expose pause, resume and playback speed

**Existing evidence:** Android runtime code contains 6001 `cmd:1` for pause, `cmd:2` for resume, and `play_speed`. Only start/stop have been tested from the computer.

**Gaps/scope:** Expose playback controls only after real-device verification. Do not expose unverified parameters to the Agent as usable capabilities.

**Acceptance criteria:**

- Verify pause/resume command responses and media timestamp behavior, ensuring other channels are unaffected.
- Test the device's allowed playback speeds rather than guessing the supported set; capability queries clearly identify the device and verification status.
- Return explicit errors for inactive sessions, lost connections and command rejection.

**Dependencies:** Short/long continuous-playback validation and the device-capability query contract.
