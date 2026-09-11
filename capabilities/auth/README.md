# Authentication and sessions

One resident `LocalEufySession` owns the single account used by the API, login page and recording jobs. Future CLI clients consume the [resident session API](../../api/v1.md); they must not instantiate a separate login owner. No CLI or multi-account system is included here.

## Lifecycle

- `login({email,password,country})` starts a normal regional Mega login. Passwords remain in memory during sign-in and challenge continuation, and are never persisted.
- `verify(code)` continues the same provider instance through image CAPTCHA, email verification and incorrect-code retries.
- `isAuthenticated()` checks the provider's actual token validity. Expiry projects `phase:"login_required"` and removes cached devices without disturbing already-owned LAN capture.
- `refresh()` reloads inventory. Ordinary inventory failures retain the authenticated session and diagnostics so the page can retry.
- `restore()` initializes the provider, restores saved material and strictly validates cloud inventory before exposing `connected`. Expired, malformed or unusable saved sessions are removed and produce `login_required`.
- `logout()` clears the shared provider, password, challenge, inventory and saved session. It is a local logout, not a remote token-revocation claim.

Phases are `idle`, `busy`, `captcha`, `tfa`, `connected`, `login_required`, and `error`. Clients use the explicit `authenticated` status rather than interpreting a cached phase as token validity.

The bundled Mega provider implements `exportSession()` / `restoreSession()` in `vendor/eufy-security-client/src/http/megaApi.ts`. Its validity check uses a 60-second expiry margin. Export includes the token, user identifier, expiry, regional domains, ECDH identities and stable device identifier. There is no supported token-refresh method; expiration requires a normal login, with no password replay.

The resident service defaults to ignored `output/auth/session.json`; set `EUFY_SESSION_PATH` or `createServer({sessionPath})` to a private durable location outside a disposable checkout. It persists only after authentication completes. The file contains credentials equivalent to a login session and must stay private. No password or pending challenge is saved. Files are written through an atomic temporary-file replacement. Embedded `new LocalEufySession(createApi, {sessionPath})` opts into persistence; omitting `sessionPath` remains memory-only. `server.start()` restores before listening; `server.ready` exposes that initialization promise.

## Logout and recording ownership

`POST /logout` on the page and `POST /api/v1/session/logout` share the same operation. Login/verification/refresh retain the final request-body mutual exclusion checks. Logout can proceed during v1 work, so a queue cannot prevent logout indefinitely. It returns a busy error during a login or a legacy recording operation; retry when that operation settles.

At logout, queued resident exports become durable `cancelled` jobs with `error.code:"LOGIN_REQUIRED"` and retain their request IDs. They do not resume automatically: after login, submit a new request ID. A job already running but still preparing media tools checks login before capture and fails with `LOGIN_REQUIRED` plus the normal diagnostic artifacts if login is gone. New recording connection acquisition rechecks login after cloud inventory. A capture that already owns its LAN connection keeps its own account identifier and can finish safely.

While an expired session waits behind an owned job, queued job views report `stage:"login_required"` and `error.code:"LOGIN_REQUIRED"`; when scheduled, they cannot capture with that expired session. Local job status, artifacts and existing request-ID reuse remain available after expiry or logout. New devices/ranges/exports return 401. This does not introduce Phase B recovery, automatic retry or public cancellation.

## Verification

`node --test capabilities/auth/*.test.cjs api/v1-routes.test.cjs` covers real provider export/restore/expiry methods with offline cloud stubs, challenges, truthful restore failure, logout, queue ownership and HTTP request interleavings. Full validation also runs the configured PyAV/FFmpeg media tests.

`lifecycle-evidence.cjs` is an opt-in acceptance runner. A controller must review and launch it in a fresh private directory. It opens port 3189 for a normal user login, stops its own child process, starts a fresh Node process to test restoration, logs out, and checks that a new device request returns 401. It never reads another service's credentials. Its evidence records only phase/status/booleans and timestamps. Offline runner tests do not establish real-account acceptance. A new normal-login run completed on 2026-09-11; see the [sanitized real-account validation record](validation.md).
