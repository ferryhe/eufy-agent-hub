# Dynamic Workspace (Planned)

The workspace will map structured Agent results to registered cards, timelines, and players, supporting composed views, pinned results, and layout restoration. Actual data and progress come from the API. Dynamic rendering is not implemented yet, and there is no entry point for a model to generate and execute arbitrary page code directly.

Composed views must inherit the shared [interface locale](../i18n/README.md). Store structured results rather than translated labels so existing cards can change language without rerunning tools or interrupting media playback.
