# Interface localization

All application interfaces use a shared localization boundary: stable message keys, English and Simplified Chinese catalogs, and the browser's `Intl` formatters. The current vanilla JavaScript page uses a small dependency-free runtime in `i18n.mjs`; introducing a framework or i18next is unnecessary for this page. Future components can reuse the catalogs or adapt them to their framework's i18n library.

## Language selection

1. An explicit `en` or `zh-CN` selection stored under `eufy-agent-hub.language` wins.
2. In automatic mode, match `navigator.languages` in preference order: `en-*` maps to English and `zh-*` maps to Simplified Chinese.
3. Fall back to English if none of the preferred languages is supported. Traditional Chinese currently uses Simplified Chinese; it does not have a separate translation.

The default is automatic. Browser language normally follows the operating system but can be configured separately; a website cannot reliably read a separate OS language preference. The `languagechange` event updates automatic mode without a reload. Manual selection survives reloads where local storage is available, and still works in memory when storage is blocked.

The selector, document title, `html.lang`, labels, CAPTCHA alternative text, statuses, errors, results, and download links update together. Language changes preserve form values, the selected device, and existing video elements, so an active video is not recreated. Native date/time pickers, form validation bubbles, and video control menus are provided by the browser and may continue using its own language.

## Messages and data

- `ui.*.json` contains page text and local HTTP validation messages.
- `service.*.json` contains translated capability statuses and errors.
- `/locales/en.json` and `/locales/zh-CN.json` combine these catalogs for the browser.
- Backend status responses optionally carry `messageI18n: {key, params}`; errors carry `errorI18n`, and `diagnosticsI18n` aligns with the diagnostics array. Legacy `message` and `error` strings remain for existing callers.
- Unknown upstream details remain verbatim. Do not infer translations by matching error text.
- Render translated strings and parameters as text, never as HTML. Missing translations fall back to English, then the original service message.
- Account regions, serial numbers, user-defined device names, request values, and filenames are data and are not translated. Only generated device-name/model fallbacks have translation metadata.

Dates and file sizes use `Intl` with the selected interface locale. **Recording queries still use `America/Toronto`**, explicitly shown on the page. Switching language does not change recording timestamps or account region. Configurable recording time zones remain a separate work item.

## Future interfaces

Fixed pages, shared cards/players, the Agent sidebar, and the dynamic workspace must consume this same locale and message catalog. Keep new labels in catalogs instead of embedding language-specific strings in components. Tool results should contain structured values and stable message keys, so the same result can be rendered in either language. Agent-generated prose is separate from translated interface text: pass the selected locale as its output-language preference when the Agent runtime is implemented; do not translate tool arguments or saved footage.

Use `npm test` to check automatic matching, persistence and blocked storage, fallback behavior, catalog key/parameter parity, static page keys, HTTP locale delivery, and unchanged Toronto timestamps. Browser checks additionally cover switching without losing form values or replacing video elements.

References: [browser language preferences and change events](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages), [locale-aware date formatting](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat).
