# Third-party code

`vendor/eufy-security-client` includes eufy-security-client by bropat, copyright 2021–2024, under the MIT license. Its license and upstream source reference are retained in that directory.

This project is a community client, not an official eufy or Anker application.

## Shadcn Admin adaptation (Issue #35)

`interface/react` adapts the application shell, navigation, theme, accessible form/OTP, and dialog patterns from [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) revision `e16c87f213a5ba5e45964e9b67c792105ec74d26` (v2.2.1), copyright Sat Naing (2024), MIT. Adapted source is recorded in `interface/react/UPSTREAM.md`; no upstream demo data, Clerk routes, Clerk dependency, avatars, or mock authentication are included.

## assistant-ui (Issue #38)

The React shell uses [`@assistant-ui/react`](https://github.com/assistant-ui/assistant-ui) version `0.15.19`, copyright AgentbaseAI Inc., under the MIT license. It uses the external-store runtime and composable thread, message, and composer primitives with the existing local resident; Assistant Cloud and model/backend integrations are not used.

## Windows private-evaluation runtime (Issue #49)

The Windows package inputs are pinned in `scripts/release/release-inputs.json`: Node.js 24.14.1 (MIT), CPython 3.13.11 (PSF-2.0), PyAV 18.1.0 (BSD-3-Clause), and Gyan FFmpeg 9.0.2 essentials (GPL-3.0-or-later). The release manifest records the actual FFmpeg configuration/license output, PyAV library versions, production npm packages, and every shipped file hash.

The selected static FFmpeg build enables GPL/version3 and libx264. Its exact dependency-to-source mapping is incomplete, including the exact libx264 revision. The PyAV wheel's bundled libraries also need final corresponding-source review. Therefore `publicationGate.status` is `BLOCKED`: a locally built ZIP is only for private evaluation and must not be published until those mappings and required source/license materials are complete.
