export const supportedLocales = ['en', 'zh-CN'];
export const storageKey = 'eufy-agent-hub.language';

export function resolveLocale(preference, languages = []) {
  if (supportedLocales.includes(preference)) return preference;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

export function createI18n({ catalogs, storage, languages = () => [] }) {
  let preference = 'auto';
  try {
    const saved = storage?.getItem(storageKey);
    if (supportedLocales.includes(saved)) preference = saved;
  } catch { /* Browsing without storage still supports language selection. */ }
  return {
    get preference() { return preference; },
    get locale() { return resolveLocale(preference, languages()); },
    setPreference(value) {
      preference = supportedLocales.includes(value) ? value : 'auto';
      try { storage?.setItem(storageKey, preference); } catch { /* Keep the in-memory choice. */ }
    },
    t(key, params = {}, fallback = key) {
      const template = catalogs[this.locale]?.[key] ?? catalogs.en?.[key] ?? fallback;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
    },
    message(raw, metadata) {
      return metadata?.key ? this.t(metadata.key, metadata.params, raw) : (raw || '');
    },
    date(value) {
      return new Intl.DateTimeFormat(this.locale, {
        timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(new Date(value));
    },
    number(value) {
      return new Intl.NumberFormat(this.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
    },
  };
}
