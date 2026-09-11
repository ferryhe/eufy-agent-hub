# Real-account session lifecycle validation

A new normal-user-login run on **2026-09-11** verified the session lifecycle for Issue #3 using the independently reviewed `lifecycle-evidence.cjs` runner. The user entered credentials through the local login page. No credentials, account identifiers or device identifiers are included in this record.

| Check | Observed result |
| --- | --- |
| Normal login | Completed at `2026-09-11T23:49:12.609Z`; authenticated session persisted |
| Process restart | A fresh resident Node process restored the session and reported `authenticated:true`, `phase:connected`, `result:restored` |
| Local logout | HTTP 202; `authenticated:false`; persisted session file removed |
| New device request after logout | HTTP 401, `UNAUTHENTICATED` |
| Run completion | `complete:true` at `2026-09-11T23:49:14.294Z` |
| Cleanup | Runner exited with code 0; controller confirmed no validation listener or private session file remained |

The sanitized `auth-lifecycle.json` report has SHA-256:

```text
8d6d02d9404160e07979a50be7a818d97b35f2ea6b481d8a0757e6be345f3a2a
```

The controller verified completion and cleanup at `2026-09-11T23:49:49.3088741Z`; the Issue manager independently checked the sanitized report and listener cleanup. This is a new authentication validation record. Earlier recording or media validation did not substitute for this run. Expired and malformed-session cases, challenge continuation, and queued-job behavior are covered separately by the automated tests described in the [auth documentation](README.md).
