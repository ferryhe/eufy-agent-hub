# Interface validation — Issue 13

Validated on Windows with Node 24.14.1: `npm ci`, `npm run setup`, `npm run build`, and the configured full `npm test` passed (253 passed, 0 failed, 0 skipped; baseline 226). `EUFY_PYTHON` selected Python with PyAV and `EUFY_FFMPEG` selected FFmpeg. Local installation paths and account material are not part of the repository.

The new DOM tests execute the actual result components and sidebar against linkedom. They check fixed timeline actions, service window labels, literal device names, independent offline/eligibility evidence, partial status, registered media URLs, stable video identity across polls/language changes, original message plus independent response locale, lost-response turn identity, mode switching, stable conversation nodes and normal challenge navigation. Known reachability reasons, job stages and API errors are translated into ordinary language across shared cards, fixed form errors and sidebar notices; unknown upstream text and user names are preserved, and raw job details remain in expandable diagnostics.

The HTTP tests mount the actual resident on isolated dynamically assigned ports and run the installed OpenAI Agents SDK `ScriptedModel` through the real root runtime and HTTP tools. They cover origin-bound saved state, separate preferred locale without input rewriting, queued/running work, partial media, HTTP Range, later-turn job reuse, repeated accepted turn IDs, observer disconnect, concurrent-turn rejection, and structured missing/ambiguous/no-login/offline/no-footage responses. Status observation makes no model calls. Existing tests continue to exercise actual configured media processing and complete/partial/failed API semantics.

Review regressions also run the actual sidebar DOM against resident HTTP and the installed SDK: a lost response after acceptance is acknowledged by polling or page refresh, clears only the matching old draft, and cannot send another turn from that cleared composer. Newly edited text survives both successful POST and polling acknowledgement, including a poll that arrives before the failed POST settles. A failure before acceptance still retries the same ID. An actual `job_get` of a mistyped ID produces the localized shared notice; stable task/service error mappings are checked in both languages and shared job cards, with raw diagnostics retained.

Actual Chrome interaction was observed at 1365×900 and 390×844, in English and Simplified Chinese. It covered normal sign-in, synthetic image and email challenges, device refresh, event query, event download through real FFmpeg and playback, natural request submission, range/job/player rendering, missing details, duplicate-name selection, offline device, no footage, invalid timezone, running → partial and complete, failure, model error, view switching, refresh, follow-up reuse, logout with retained jobs, and local-service disconnect. At 390 pixels the document had no horizontal overflow. Registered videos loaded at readyState 4; a play-control click advanced the partial video's currentTime, and language change did not reset playback. The fixed legacy video also played. The browser viewport was restored and the isolated fixture was stopped after archiving evidence.

## Reproduce the browser fixture

Set `EUFY_FFMPEG` to an installed FFmpeg executable and `EUFY_FIXTURE_EVIDENCE` to an external evidence directory, then run:

```sh
node interface/agent/browser-fixture.cjs
```

Read the emitted dynamically assigned URL. The fixture's local normal form accepts arbitrary synthetic email/password, any first challenge answer, and any second email-code answer. It never contacts eufy or OpenAI. The test-only `POST /fixture/scenario` endpoint queues a scenario before the corresponding browser message:

```json
{"scenario":"partial"}
```

Other scenarios: `noauth`, `missing`, `ambiguous`, `offline`, `empty`, `error`, `again`, `failed`, `complete`, `model-failed`, `response-lost`, `job-not-found`. `response-lost` destroys the next POST response only after the real adapter accepts the turn; automatic browser polling must clear its old draft and retain exactly one conversation turn/model call. `job-not-found` runs the root `job_get` tool for a mistyped ID. Both were observed in Chrome; the notice was checked at desktop and narrow widths in EN/Chinese, and a later unsent draft survived refresh. Supply `window.device` for another explicitly named synthetic camera (`CAMERA002` or `CAMERA003`) when testing a different export; repeated window/device requests intentionally reuse the original job. `again` refers to the most recent successful receipt. Complete normal login before scenarios requiring inventory. Send text naming the scenario's device through the actual sidebar. Inspect resident/UI status and registered links; scenario responses expose fixture capture/range/model-call counters.

## Evidence boundary

This is interface acceptance using synthetic inventory, challenges, transport and scripted model outputs. The browser helper uses a real generated three-second test-card MP4; its continuous capture/timeline/decode metadata is deliberately injected to produce each authoritative API state. A fixture “complete” status does not prove real 60-second media coverage, hardware success or natural-language model quality. This validation did not call private hardware, access private media, use credentials from disk, or make paid model calls. Prior real hardware evidence stays in the root [Agent validation](../../agent/VALIDATION.md).

The private local evidence directory retains 29 original observed browser screenshots plus refreshed English/Chinese desktop/mobile screenshots, final DOM, model/HTTP state and resident archive, media readiness/playback values, credential-exclusion checks, command logs and regression red/green outputs. Browser console warnings were from an unrelated installed extension; no application console errors were observed. No screenshots or generated media are committed.
