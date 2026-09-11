# Auth and devices issue drafts

The following gaps were identified during migration; they are not implemented features. These drafts were intended for repository maintainers to deduplicate against other module tasks before creating remote issues. See the [issue index](README.md) for the created work items.

## [auth] Session lifecycle and restart recovery for the persistent service

**Existing evidence:** Single-account login, email/image verification challenges and expiration detection are implemented, with six offline tests. Sessions exist only in memory, and expiration requires a new login.

**Scope:** Provide shared session status, logout and restart recovery for the CLI, API and background jobs. Verify whether Mega permits session recovery or refresh; enter an explicit login-required state when recovery is unavailable. Continue supporting a single account by default, without introducing a multi-account architecture.

**Acceptance criteria:**

- The CLI and API use the same account session, and verification challenges can continue the original login flow.
- After a service restart, recover a still-valid session or explicitly report that login is required. Never display an expired session as usable.
- Device requests require a new login after logout, and waiting recording jobs accurately report that login is required.
- Simulate valid, expired, recovery-failure and logout scenarios, and record at least one real-account validation.

**Dependencies:** The persistent service, the background-job state model, and verification of Mega session recovery/refresh mechanisms.

## [devices] Expose device capabilities and connection information to the Agent

**Existing evidence:** Mega device discovery lists HomeBase stations and cameras while retaining unknown models. Public summaries currently contain only serial number, name and model.

**Scope:** Extract HomeBase relationships, channels and available firmware/status information from the device data already retrieved. Record capability verification levels by device and firmware, and expose query methods to the CLI/API/Agent. Cover the devices currently in use first. Retain unknown models and mark them as unknown instead of guessing their capabilities.

**Acceptance criteria:**

- The Agent can query which device functions are verified and which are only leads from the protocol library.
- Verified devices map to the correct HomeBase and channel; missing information is explicitly null or unknown.
- The API returns a stable data structure with understandable results for unknown models, unsupported features and offline devices.
- Record validation for the current cameras and HomeBase; include tests for unknown models and missing relationships.

**Dependencies:** The auth session, protocol adapter, and actual verification results from the recordings/live capabilities.

## [devices] Verify Mega device-list pagination and report completeness

**Existing evidence:** A response containing 100 devices currently produces only a possible-incompleteness warning. Pagination has not been verified.

**Scope:** Confirm pagination or continuation behavior using Mega documentation or request evidence from an authorized account. If the interface has no pagination, explicitly expose completeness as unknown. Do not claim that a response reaching the limit is complete.

**Acceptance criteria:**

- Merge and deduplicate simulated multi-page responses while retaining unknown models.
- Report failure and incompleteness when pagination fails midway, and allow a retry.
- Record the protocol evidence used. When pagination cannot be established, retain the limitation and return structured completeness status.

**Dependencies:** Protocol evidence for the Mega device interface.
