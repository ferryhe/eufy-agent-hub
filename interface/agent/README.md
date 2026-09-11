# Agent Interface (Planned)

This directory will contain the conversation entry point, expandable sidebar, parameter clarification, and tool invocation status. It belongs to the interface layer; tool execution and job orchestration belong to the root `agent/` directory and the capability layer. No model is connected yet, and there is no working conversation sidebar.

Use the shared [interface locale](../i18n/README.md) for sidebar text and tool status labels. Pass that locale as the Agent's preferred response language when a runtime is implemented, while preserving tool arguments and user-defined names.
