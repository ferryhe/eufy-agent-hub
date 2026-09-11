# Interface and API migration notes and issue drafts

Migrated: the fixed login/device/event-recording page, local HTTP routes, event downloads and MP4 Range playback. Dependencies now point to capability modules, and outputs go to the new repository's `output/` directory. The server factory supports creation without listening, configurable ports, and recording-connection cleanup on close. Toronto date/DST and media-range tests were migrated, and a real HTTP smoke test requiring no account was added.

Not delivered as finished features: the Agent sidebar, dynamic workspace and shared components have only directory documentation, and there is no v1 Agent API. These drafts were consolidated by the main migration task to avoid duplicate issues. See the [issue index](README.md) for the created work items.

## API: Define a v1 capability and job protocol for the CLI and Agent

- Evidence: `api/legacy-recording-routes.cjs` supports event queries and downloads, but uses a global busy flag and status polling without individual job IDs. Continuous playback exists only in the capability layer.
- Gaps: Capability discovery, structured parameters/errors, job submission/query/cancellation, and continuous-recording endpoints.
- Dependencies: The persistent job model in `jobs/` and continuous-recording completeness validation.
- Acceptance: Publish parameter and response documentation; the CLI and Agent use the same protocol; every submission returns a job ID; callers can query and distinguish success, failure and cancellation; responses include accessible outputs and actual coverage intervals; existing login and event exports continue working.

## Interface: Share result components between the fixed recording page and Agent sidebar

- Evidence: `interface/pages/local-login.html` is the migrated fixed page; other interface directories contain only responsibility descriptions.
- Gaps: Reusable device cards, timeline, player, job cards and conversation sidebar.
- Dependencies: The v1 API and the repository's Agent tool layer.
- Acceptance: Preserve direct login and search operations; a natural-language recording request displays an explanation in the sidebar and a timeline/player/job card in the main area; component data comes from the API, with visible failures and missing parameters; users can switch between fixed browsing and Agent operations.

## Interface: Implement a structured dynamic workspace and pinned results

- Evidence: `interface/workspace/` has a defined responsibility but no rendering implementation.
- Gaps: A structured presentation protocol, registered-component rendering, pinned results and layout restoration.
- Dependencies: Shared components and stable v1 object identifiers.
- Acceptance: The Agent can combine at least device lists, timelines, players and job cards; pinned results survive a refresh and reload their state from the API; unknown component types show an understandable fallback; fixed pages and the workspace share operation behavior.
