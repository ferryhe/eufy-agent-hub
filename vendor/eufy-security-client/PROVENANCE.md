# Vendored protocol source

- Upstream: https://github.com/bropat/eufy-security-client
- Base commit: `8ca2545a45460ccf6bca66901ee90ef58b07934d`
- Snapshot date: 2026-09-11
- Upstream package version: 4.1.1
- License: MIT; original [LICENSE](LICENSE) retained.
- Snapshot contains the upstream tracked `src/` tree plus its build configuration and lockfile. It does not contain account sessions, recordings, Android binaries, packet captures, debug tools or built output.

This is a source snapshot, not an unmodified copy of the published npm package. The following local changes are included:

1. HomeBase event date-query count can be increased explicitly.
2. Download-complete notification is surfaced separately from stream finish.
3. HomeBase continuous range query (6000), history start/stop (6001), and timestamped media-frame events are implemented in the P2P session.
4. Asset copying uses Node's built-in filesystem API instead of an undeclared `npx copyfiles` download, so builds require only the installed lockfile dependencies.

The business scripts and legacy page have been moved into the hub's capabilities, API and interface directories. The upstream package's temporary local `start` script is removed here; run the hub from its root.

Upstream README describes broad library support and its legacy-cloud deprecation notice. It is not a statement that every listed device feature is exposed or tested by this hub.

Update this commit reference and local-change list whenever the snapshot is updated. A future separately published protocol fork can replace this snapshot through `adapters/eufy` without changing capability consumers.
