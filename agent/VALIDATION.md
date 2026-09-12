# Recording Agent validation record

## Result

On **2026-09-12**, a new natural-language request completed the real OpenAI model → structured tools → resident v1 API → camera capture → registered video workflow. It produced **one playable partial video**. The service correctly reported `PARTIAL_RECORDING`, `complete:false` and `coverageVerified:false`, while media validation passed.

This is engineering evidence for execution, durable identity, registered artifact delivery and honest partial-result reporting. The captured recording contains gaps; full decoding does not establish complete requested coverage or lossless acquisition.

## Authorized device and window

| Item | Recorded value |
|---|---|
| Device | User-named Drive Way, uniquely resolved by the resident; T8600 camera linked to T8030 HomeBase |
| Requested local window | 2026-08-27 16:30–16:50, America/Toronto |
| Service-normalized UTC window | 2026-08-27 20:30–20:50Z |
| Actual job submission | 2026-09-12T04:20:25.662Z |
| Durable terminal result | 2026-09-12T04:35:13.562Z |
| Agent runtime | One ordinary OpenAI Agents SDK Agent, SDK 0.18.0, gpt-4.1-mini through Responses |
| Model-selected tool sequence | `recording_ranges` → `recording_export` → `job_artifacts` |
| Request / job / export tool call counts | 1 / 1 / 1 |

The coordinator used a fresh normal CA login on an independent resident. Preflight uniquely resolved the authorized display name. The model supplied local window fields to the range tool, used its normalization receipt for export, and later queried registered artifacts. HTTP polling observed the resident-owned job without model calls during the wait. No password, challenge answer or video content was supplied as a model tool parameter.

The first real Agent attempt found the unique device but incorrectly rejected the returned serial at the next tool boundary. It created no export or capture. A minimal fix retained the uniquely resolved caller-name-to-service-ID selection, with an actual SDK failing-then-passing regression and independent review before resumption. The second attempt reused the same caller state and resident and performed the **first and only capture**. Unknown and ambiguous candidates still require clarification.

## Coverage and media validation

| Field | Result |
|---|---|
| Durable job state / error | `failed` / `PARTIAL_RECORDING` |
| Result outcome | `partial` |
| Complete / coverage verified | `false` / `false` |
| Validation passed | `true` |
| Registered playable videos | 1 |
| Raw video frames | 17,472 |
| Raw video first / last timestamp | 2026-08-27T20:30:00.283Z / 2026-08-27T20:49:59.942Z |
| Video timestamp gaps over 250 ms | 51; maximum 4,067 ms |
| Raw audio frames | 18,597 |
| Raw audio first / last timestamp | 2026-08-27T20:30:00.313Z / 2026-08-27T20:49:59.967Z |
| Reported audio timestamp gaps | 128; maximum 204 ms |
| Pipeline full decode | 17,472 video frames; 18,598 audio frames |
| Decoded duration | 1,199,733.333 ms |
| Pipeline timing / audio coverage preservation checks | Both `true` |
| Independent full video-and-audio FFmpeg decode | `-xerror`, exit 0, error log 0 bytes |

Raw and decoded audio frame counts differ. These measurements do not claim that acquisition was lossless or that raw and decoded frame counts must match. The timing-preservation checks describe the pipeline's handling of captured material; `coverageVerified:false` remains authoritative for the requested window. Neither exit 0, playable bytes nor the end timestamp can promote this result to complete.

The final Agent response explicitly described partial coverage and timestamp gaps and returned the registered link to the playable partial video.

## Artifact and retained evidence

The downloaded MP4 contains **496,018,038 bytes**. Its SHA256 is:

```text
3bf1e34f73c617498221fba0274cb5330c76a0ee5b1da246852b0ea8ad31d4b5
```

The coordinator retained the full terminal resident job evidence in an external private archive: durable metadata, raw frames and index, media timeline, intermediate/output media and processing logs. Independent source/archive/manifest comparison matched all **19 files and 626,856,561 bytes**, checking every file's hash and size. Durable job/request metadata matched the retained caller state and final result; the downloaded video's hash and byte count also matched.

Both real-attempt records and the caller/tool/result evidence were preserved outside the checkout. Private media, account data, device identifiers, network addresses and credentials are excluded from this document. This was fresh acquisition; historical Issue #6 capture and Issue #7 retained-input processing are separate evidence and do not substitute for this run.

After terminal verification and archive preservation, the coordinator completed normal logout, confirmed unauthenticated and idle state, and stopped the independent validation resident. Retained non-session evidence remains available for review.

## Acceptance-criteria coverage

| Criterion | Evidence and limit |
|---|---|
| AC1: natural language, unique service ID and normalized window reach an actual export | New real model/tool/API/hardware run above; offline actual SDK regression also verifies display-name → returned serial handoff and preserves ambiguity refusal |
| AC2: progress and registered complete/partial/failed results | Real durable terminal partial result and registered downloaded video; offline fixtures additionally cover complete, failed, timeout and observer exit |
| AC3: device and login failures, no footage, offline and local result access | Real normal login and corrected unique-device handoff; offline tests cover unknown/duplicate/missing devices, unavailable/no-footage results, challenge isolation and reads/reuse after logout |
| AC4: deterministic identity and accurate completeness | Real retained state has one request/job and one export call; archive metadata agrees. Offline duplicate/concurrent/lost-response/resumption tests verify identity retention. Real playable partial remains partial |
| AC5: service-owned local-time semantics | Real local and normalized UTC window recorded above; offline tests cover service defaults, invalid timezone/calendar values, DST gaps/repeated hours and cross-midnight rejection |
| AC6: offline and new actual end-to-end evidence | Configured Node24 full suite: **226 passed, 0 failed, 0 skipped** (original 203 plus 23 Agent tests). Actual SDK fixtures and the separate bounded real-model synthetic smoke are supplemented by this fresh hardware record |

The prior install/setup/build gates passed. The final implementation passed configured PyAV/FFmpeg tests after the ID-handoff fix. This validation record documents observed behavior; it makes no claim that recording coverage is complete or that all devices/firmware have been verified.
