# Third-party code

`vendor/eufy-security-client` includes eufy-security-client by bropat, copyright 2021–2024, under the MIT license. Its license and upstream source reference are retained in that directory.

This project is a community client, not an official eufy or Anker application.

## Shadcn Admin adaptation (Issue #35)

`interface/react` adapts the application shell, navigation, theme, accessible form/OTP, and dialog patterns from [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) revision `e16c87f213a5ba5e45964e9b67c792105ec74d26` (v2.2.1), copyright Sat Naing (2024), MIT. Adapted source is recorded in `interface/react/UPSTREAM.md`; no upstream demo data, Clerk routes, Clerk dependency, avatars, or mock authentication are included.

## assistant-ui (Issue #38)

The opt-in React shell uses [`@assistant-ui/react`](https://github.com/assistant-ui/assistant-ui) version `0.15.19`, copyright AgentbaseAI Inc., under the MIT license. It uses the external-store runtime and composable thread, message, and composer primitives with the existing local resident; Assistant Cloud and model/backend integrations are not used.
