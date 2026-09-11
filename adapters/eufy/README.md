# eufy protocol adapter

`index.cjs` is the shared protocol entry point for capabilities. Migrated capabilities do not depend on the old project directory, global debugging objects, or an Android emulator.

The adapter currently uses the MIT-licensed source snapshot in `vendor/eufy-security-client`, with its origin documented. The snapshot is necessary because continuous playback commands 6000/6001, event query limits, and download confirmation depend on unpublished local changes. The npm package with the same version cannot replace it directly.

Build from the repository root with `npm run setup` followed by `npm run build`. See [PROVENANCE.md](../../vendor/eufy-security-client/PROVENANCE.md) for source details.

This adapter exposes only the classes and enums used by the migration. Existing upstream device control methods are not automatically stable capabilities of this project; the adapter will expand after capabilities are organized and validated by device model.
