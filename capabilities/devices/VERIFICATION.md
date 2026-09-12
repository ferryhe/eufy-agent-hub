# Device capability verification

## Current camera and HomeBase: historical evidence

The aliases `historical-camera` and `historical-homebase` below identify the single
previously tested T8600 camera and T8030 HomeBase pair. They are **not real serials**
and must never be matched to inventory by model alone. The camera used channel 1.
Both main and secondary firmware versions are unknown: no firmware values were
recorded in the available evidence. This is device-specific historical evidence,
not a certification of all T8600/T8030 devices or any current firmware.

The machine-readable companion is [historical-verification.json](historical-verification.json).
Its records use the same explicit scope and four-state format as `recordCapability`.
They are documentation, not automatically loaded runtime defaults. Even if an
authorized caller later maps an alias to the real device, null firmware never
matches current verification. Keep the history, inspect the actual firmware, and
add a new dated observation after an authorized test before marking that firmware
verified. The module itself performs no hardware operations.

| Capability | Camera / HomeBase evidence | Limitation |
| --- | --- | --- |
| Continuous recording query | Verified historical command 6000 response for the retained 20-minute interval, through the HomeBase on camera channel 1 | Firmware unknown; observed retention for one interval only |
| Continuous recording export | Verified historical partial direct capture plus timestamp-preserving conversion and full decode | Partial media; no uninterrupted or lossless guarantee |
| Event recordings, live video, talkback, RTSP | No device-and-firmware verification recorded here | A protocol declaration is only a hint; lack of a declaration is unknown, not proof of unsupported hardware |

`verified` means the specific operation described by its evidence was observed.
For export, `outcome: partial` remains part of the evidence; verification of a
partial export must not turn a partial job into complete or succeeded. This module
does not change recording completeness, job outcomes or execution eligibility.

### Evidence lineage

- **2026-09-10 short direct capture:** camera T8600, HomeBase T8030, channel 1;
  the 20-second sample decoded, but subsequent rule-2 inspection found a 1,734 ms
  video timestamp interval and a 283 ms initial trim. It is not gap-free evidence.
- **2026-09-11 retained 20-minute direct capture (#6):** requested
  `2026-08-27T20:30:00Z`–`2026-08-27T20:50:00Z`
  (16:30–16:50 America/Toronto). Query returned the interval. Raw capture retained
  17,472 video frames and 18,597 audio packets. First/last video timestamps were
  `1787862600283` / `1787863799942` ms; the end marker was `1787863800007` ms.
  There were 51 video and 128 audio timestamp intervals over 100 ms; the largest
  video interval was 4,067 ms. Full decoding passed with 17,468 video frames and
  1,199,733.333 ms duration. Outcome: **partial**.
- **#7 retained-input processing:** the new export service processed the already
  captured real input offline and fully decoded the output (17,468 video and
  18,593 audio frames). Job result was `failed` with `PARTIAL_RESULT`, preserving
  a playable partial MP4. This is composite capture-plus-service evidence, not a
  new login-to-MP4 hardware run. Output audio coverage and raw/decoded count
  differences remain explicit limitations.

The committed [continuous playback evidence](../recordings/CONTINUOUS_PLAYBACK.md)
documents acquisition, channel, model association, timing, gaps and #6 hashes.
Related issue records: [#6](https://github.com/ferryhe/eufy-agent-hub/issues/6) and
[#7](https://github.com/ferryhe/eufy-agent-hub/issues/7). Private evidence archives
were read for the #7 sanitized counts and hashes; private serials, network
addresses, credentials, media and local paths are deliberately absent here.

| Artifact | SHA-256 |
| --- | --- |
| Shared real raw frames | `493f9c2a7d6f4128d5290d60e95c3bc4269d246bded9b93645d50f43b7b47d88` |
| Shared real frame index | `1210910962dff94d1732ea7e7538769e3dc5c65b959c2353fb72b9e1bb8c1454` |
| #6 converted MP4 | `02a3f2d1afe6cc027b3bf0219de6392e38d955feaa4f059a8457f3ee6b11dfde` |
| #7 service-produced partial MP4 | `6bc4a160ee54265d460deb14e52341ca2f373e5d100d6af592b309238956c86a` |

The two MP4 hashes refer to separate conversions. Neither is a new acquisition.
Hashes identify the retained evidence; they do not establish media completeness.

## Scope and current state

Inventory metadata and reachability are distinct. The current adapter's
`MegaHTTPApi.getDevsListDecrypted()` returns `Promise<unknown>`; `megaInterfaces.ts`
does not define typed device inventory fields or status meanings. The legacy
`DeviceListResponse` defines `main_sw_version`, `sec_sw_version` and numeric
`status`; device/station `getSoftwareVersion()` reads `main_sw_version`.
The projection copies those fields **when supplied**, leaves absent values null,
and does not invent a firmware value or translate numeric status to online/offline.
Existing `parent_sn` and `device_channel` fields supply association data.

Callers can supply explicitly dated `reachability` observations. The last supplied
valid observation for the device is shown with its reason and timestamp; callers
own ordering/freshness. Without one, availability is unknown, or unavailable when
the eligible recording path has no HomeBase address. An offline observation does
not erase a historical capability result. It is not authorization to operate an
offline device and does not prove the current connection is reachable.

Every observation is scoped to serial, model, main/secondary firmware, parent
HomeBase serial/model/firmware (if any), and channel (if any). Changed identity,
model, firmware or association cannot inherit a verified result. Main firmware
must be known on both participating devices for a record to be applied; unknown
secondary firmware remains an explicit null and does not match a later known value.
Older scope records remain in `verificationHistory`. Updates replace just one
capability at one exact scope; unrelated capabilities and other firmware scopes
remain intact. The pure matrix functions do not write files; the separately
configured `DeviceVerificationRepository` provides local persistence for the API
and authorized future recording/live evidence writers.

When `parent_sn` names an external parent absent from inventory, public
`homeBaseId` stays null while `verificationScope.homeBase` retains that parent's
serial with null model/firmware. This unresolved scope preserves history but cannot
qualify for current verification, and two missing parent identities remain distinct
on update. A device with no declared external parent (including a HomeBase whose
parent serial is its own serial) has `verificationScope.homeBase: null` and is
scoped to its own firmware; no external parent is inferred.
