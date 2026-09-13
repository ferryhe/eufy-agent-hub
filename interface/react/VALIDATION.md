# React interface validation

Issue #36 adds the opt-in `/app/recordings` workbench. The default `/` interface is unchanged.

## L1 browser parity

On 2026-09-13, `npm run browser:test` passed six Chromium tests, including fresh workbench checks at 390×844 and 1440×900. The fixture uses the real resident HTTP router with synthetic inventory, event index, continuous ranges and export execution; it does not intercept the production API with browser mocks.

The browser checks assert exact camera serial and unchanged local date/time/timezone input through `/recordings/query`, `/api/v1/devices/:serial/recording-ranges` and `/api/v1/exports`; legacy saved media is read through `/recordings/media/:id`, while continuous artifacts use registered job URLs. They also cover empty event results without a continuous-absence claim, device discovery failure and retry, unknown discovery completeness, `DEVICE_UNAVAILABLE`, `SERVICE_BUSY`, a response-lost request ID recovered after refresh, explicit acknowledgement before a changed-input intent, partial and complete server outcomes, known-job polling without retry, retained saved media/jobs after login expiry, EN/zh-CN switching, keyboard-native form controls, and no horizontal overflow at both widths.

The partial player DOM node is marked in the browser, assigned `currentTime = 17`, translated to Chinese, and checked again by object identity and time. This proves React polling/language updates do not remount that registered player. The complete label requires the API's `state:succeeded`, `result.outcome:complete`, `coverageVerified:true` and `validation.passed:true`; a playable partial remains visibly partial.

The fixture media bytes and synthetic completeness metadata are test data. They are not hardware acceptance, and the browser evidence does not claim gap-free footage or verified device firmware.

## Issue #38 assistant-ui integration

The React Assistant drawer uses the installed `@assistant-ui/react` external-store runtime against the real resident HTTP adapter and installed SDK `ScriptedModel`. Focused Chromium flows cover a restored draft and independent response language, one accepted natural-language export, the same resident job in workspace and task center, registered player identity/`currentTime` through polling, pin/reorder, locale and drawer changes, an ambiguous duplicate-name clarification without a second capture, and conversation/pin restoration after refresh. Browser-observed polling and refresh issue only `GET /interface/agent/state`; they never post a turn or export.

A second flow drops the accepted turn response, double-clicks send, probes `TURN_BUSY`, and then fails the model after export acceptance. One turn and one accepted job remain visible after refresh, with no duplicate model call. A third flow makes Agent state loading, empty, disconnected and recovered states visible while leaving the normal recordings workbench mounted. Unsupported edit/regenerate/cancel controls are absent; task-center export retry remains separately covered by the existing lost-reply retry tests.

The shared workspace continues to use version-1 reference descriptors and the existing renderer. Chrome state-preserving moves retain playback state; browsers without state-preserving node moves can pause media during reorder even though the same video element is retained. These offline flows are not real-model or hardware evidence.

## L2 hardware

The sanitized single-resident run verified the exact candidate hash for all 18 of 18 changed files. One uniquely identified resident was authenticated and connected; its eligible T8600 camera and paired T8030 HomeBase were tested over one retained same-day two-minute window.

The event query returned zero recordings without implying continuous absence, while the service index returned a continuous range for the same window. One durable request/job was recovered in a fresh tab without resubmission. It terminated honestly as `failed` with `result.outcome:partial`, `PARTIAL_RECORDING`, and 95% progress; requested/observed coverage and gap diagnostics remained visible. Validation and full decode passed for 119600 ms, and one playable MP4 was registered. An authenticated byte-range request to the registered artifact returned HTTP 206 and `video/mp4`.

Switching EN to zh-CN preserved the task, result, window, partial label, diagnostics and registered media. Invoking the native video control crashed the Codex in-app browser tab, so L2 does not claim playback start or preserved `currentTime`. The L1 Chromium evidence above remains the player identity/`currentTime` proof.
