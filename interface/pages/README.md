# Fixed Pages

`local-login.html` was migrated from the old project. It provides account login, verification challenges, a device list, event search in Toronto time, downloads, and playback of saved recordings. Search results are event clips and do not establish continuous recording coverage.

Markup and styles live in `local-login.html`; `local-login.mjs` handles interaction using the shared [i18n runtime and catalogs](../i18n/README.md). The page has not been split into shared components. Future device pages, recording calendars, and job pages belong in this directory and must use the same language preference.
