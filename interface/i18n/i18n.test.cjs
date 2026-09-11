const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('automatic locale matching, explicit preference and storage-disabled browsing', async () => {
  const { resolveLocale, createI18n, storageKey } = await import('./i18n.mjs');
  assert.equal(resolveLocale('auto', ['fr-CA', 'zh-TW', 'en']), 'zh-CN');
  assert.equal(resolveLocale('auto', ['en-CA', 'zh-CN']), 'en');
  assert.equal(resolveLocale('auto', ['ja']), 'en');
  assert.equal(resolveLocale('en', ['zh-CN']), 'en');
  let browserLanguages = ['zh-CN'];
  const stored = new Map();
  const storage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const settings = { catalogs: {}, storage, languages: () => browserLanguages };
  const i18n = createI18n(settings);
  assert.equal(i18n.locale, 'zh-CN');
  browserLanguages = ['en-GB']; assert.equal(i18n.locale, 'en');
  i18n.setPreference('zh-CN'); assert.equal(i18n.locale, 'zh-CN');
  assert.equal(createI18n(settings).locale, 'zh-CN');
  i18n.setPreference('auto'); assert.equal(stored.get(storageKey), 'auto'); assert.equal(i18n.locale, 'en');
  stored.set(storageKey, 'corrupt'); assert.equal(createI18n(settings).preference, 'auto');
  const blocked = createI18n({ catalogs: {}, storage: {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
  } });
  blocked.setPreference('zh-CN'); assert.equal(blocked.locale, 'zh-CN');
});

test('fallbacks preserve raw diagnostics; locale formatting preserves Toronto time', async () => {
  const { createI18n } = await import('./i18n.mjs');
  const i18n = createI18n({ catalogs: {
    en: { greeting: 'Found {count} clips', fallback: 'English fallback' },
    'zh-CN': { greeting: '找到 {count} 段' },
  } });
  i18n.setPreference('zh-CN');
  assert.equal(i18n.t('greeting', { count: 3 }), '找到 3 段');
  assert.equal(i18n.t('fallback'), 'English fallback');
  assert.equal(i18n.message('Upstream detail 123', { key: 'unknown' }), 'Upstream detail 123');
  assert.equal(i18n.message('Upstream detail 123'), 'Upstream detail 123');
  for (const locale of ['en', 'zh-CN']) {
    i18n.setPreference(locale);
    assert.match(i18n.date('2026-08-27T20:30:00Z'), /16:30:00/);
  }
});

test('catalogs have matching keys/placeholders and all static page labels are translated', () => {
  for (const prefix of ['ui', 'service']) {
    const read = locale => JSON.parse(fs.readFileSync(path.join(__dirname, `${prefix}.${locale}.json`), 'utf8'));
    const en = read('en'), zh = read('zh-CN');
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const key of Object.keys(en)) {
      assert.deepEqual(en[key].match(/\{\w+\}/g)?.sort(), zh[key].match(/\{\w+\}/g)?.sort(), key);
    }
    if (prefix === 'ui') {
      const html = fs.readFileSync(path.join(__dirname, '../pages/local-login.html'), 'utf8');
      for (const match of html.matchAll(/data-i18n(?:-alt)?="([^"]+)"/g)) assert.ok(en[match[1]], match[1]);
    }
  }
});
