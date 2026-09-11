# Authentication and sessions

`session.cjs` was migrated from `scripts/local-eufy-session.cjs` in the original project. It preserves the existing behavior and accesses the protocol through `adapters/eufy`.

## Available capabilities

- `LocalEufySession.login({ email, password, country })`: select the regional Mega service and sign in.
- `verify(code)`: submit an image CAPTCHA answer or email verification code, according to the current session phase.
- `refresh()`: reload devices; a device query failure preserves the login and previous list and records diagnostics.
- `state`: expose the phase, message, device summaries, diagnostics, and a CAPTCHA image when required.
- `fail(error)`: let the caller place a request error into displayable state; callers must still catch errors from asynchronous methods.

`phase` can be `idle`, `busy`, `captcha`, `tfa`, `connected`, or `error`. `connected` means authentication succeeded; check `diagnostics` to determine whether device discovery also succeeded.

## Maturity and validation

This is an existing local, single-account login flow. The original project completed login and device discovery with the current user's CA account. The migration did not repeat login or copy sessions or credentials. Other accounts and regions were not tested against the service during this migration.

Six offline tests were retained. They cover login, correcting a verification code, email verification after an image CAPTCHA, retrying failed device discovery, invalid inventory responses, and session expiration. They use a mocked service and do not replace validation against eufy.

```sh
node --test capabilities/auth/session.test.cjs
```

## Current limitations

Sessions exist only in the current process; restarting requires signing in again. Session restoration, automatic renewal, a logout entry point, multiple-account isolation, and a queue for concurrent login attempts on one account are not implemented. Callers must prompt for a new login after expiration. Device discovery still runs through `session.refresh()`, which `capabilities/devices` reuses.

See the [issue drafts](../../docs/issues/auth-devices.md) for planned work.
