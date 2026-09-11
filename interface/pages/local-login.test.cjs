const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function pageHarness() {
  const { createI18n } = await import('../i18n/i18n.mjs');
  const catalogs = Object.fromEntries(['en', 'zh-CN'].map(locale => [locale, {
    ...JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/ui.${locale}.json`), 'utf8')),
    ...JSON.parse(fs.readFileSync(path.join(__dirname, `../i18n/service.${locale}.json`), 'utf8')),
  }]));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', children: [], textContent: '', dataset: {}, listeners: {},
      replaceChildren(...children) { this.children = children; },
      addEventListener(event, listener) { this.listeners[event] = listener; },
    });
    return nodes.get(id);
  };
  const state = {
    auth: { phase: 'idle', busy: false, devices: [], message: 'Legacy auth text', messageI18n: { key: 'service.auth.idle' } },
    recordings: { busy: false, records: [], saved: [], message: 'Legacy recording text', messageI18n: { key: 'service.recordings.idle' } },
  };
  const response = (body, ok = true) => ({ ok, json: async () => structuredClone(body) });
  let post = () => assert.fail('Unexpected request');
  let pollFailure;
  const fetch = async (url, options) => {
    if (url.startsWith('/locales/')) return response(catalogs[url.includes('zh-CN') ? 'zh-CN' : 'en']);
    if (options?.method === 'POST') return post(url);
    if (pollFailure === 'network') throw new TypeError('Temporary status connection reset');
    if (pollFailure === 'http') return response({}, false);
    return response(url === '/status' ? state.auth : state.recordings);
  };
  // Exercise the real page controller and catalogs. Only browser DOM/network
  // boundaries are replaced; full DOM and video behavior has browser coverage.
  const source = fs.readFileSync(path.join(__dirname, 'local-login.mjs'), 'utf8')
    .replace(/^import \{ createI18n \} from '\/assets\/i18n\.mjs';\r?\n/, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const controller = await new AsyncFunction('createI18n', 'document', 'window', 'navigator', 'fetch', 'setInterval',
    source + '\nreturn { submit, refresh, recordingAction, refreshRecordings };')(
    createI18n,
    { getElementById: node, documentElement: {}, querySelectorAll: () => [] },
    { addEventListener() {} }, { languages: ['en'] }, fetch, () => {},
  );
  await Promise.all([controller.refresh(), controller.refreshRecordings()]);
  return {
    ...controller, state, node, catalogs, response,
    setPost(handler) { post = handler; },
    setPollFailure(failure) { pollFailure = failure; },
    selectLanguage(locale) { node('language').value = locale; node('language').listeners.change(); },
  };
}

test('a successful auth poll clears a lost login response instead of masking the connected state', async () => {
  const page = await pageHarness();
  page.setPost(() => {
    page.state.auth = { ...page.state.auth, phase: 'connected', messageI18n: { key: 'service.devices.empty', params: { country: 'CA' } } };
    throw new TypeError('POST response lost after the server accepted login');
  });
  await page.submit('/login', {});
  assert.equal(page.node('status').textContent, page.catalogs.en['ui.unreachable']);
  await page.refresh();
  assert.equal(page.node('login').hidden, true);
  assert.equal(page.node('status').textContent, page.catalogs.en['service.devices.empty'].replace('{country}', 'CA'));
});

for (const failure of ['network', 'http']) {
  for (const channel of ['auth', 'recordings']) {
    test(`${channel} validation survives a ${failure} status failure and unchanged recovery`, async () => {
      const page = await pageHarness();
      const key = channel === 'auth' ? 'ui.error.credentials' : 'service.recordings.invalidEndTime';
      const status = channel === 'auth' ? 'status' : 'recording-message';
      const refresh = channel === 'auth' ? page.refresh : page.refreshRecordings;
      page.setPost(() => page.response({ error: 'Legacy validation text', errorI18n: { key } }, false));
      if (channel === 'auth') await page.submit('/login', {});
      else await page.recordingAction('/recordings/query', {});
      page.setPollFailure(failure);
      await refresh();
      page.selectLanguage('zh-CN');
      assert.equal(page.node(status).textContent, page.catalogs['zh-CN'][key]);
      page.setPollFailure(undefined);
      await refresh();
      assert.equal(page.node(status).textContent, page.catalogs['zh-CN'][key]);
      page.selectLanguage('en');
      assert.equal(page.node(status).textContent, page.catalogs.en[key]);
    });
  }
}

test('a successful recording poll clears a lost export response and shows completion', async () => {
  const page = await pageHarness();
  page.setPost(() => {
    page.state.recordings = { ...page.state.recordings, messageI18n: { key: 'service.recordings.saved' } };
    throw new TypeError('POST response lost after the server accepted export');
  });
  await page.recordingAction('/recordings/download', { recordId: '1' });
  assert.equal(page.node('recording-message').textContent, page.catalogs.en['ui.recordings.unreachable']);
  await page.refreshRecordings();
  assert.equal(page.node('recording-message').textContent, page.catalogs.en['service.recordings.saved']);
});

test('unchanged status polls retain validation errors and language changes translate them', async () => {
  const page = await pageHarness();
  page.setPost(url => page.response({
    error: 'Legacy validation text',
    errorI18n: { key: url === '/login' ? 'ui.error.credentials' : 'service.recordings.invalidEndTime' },
  }, false));
  await page.submit('/login', {});
  await page.recordingAction('/recordings/query', {});
  await page.refresh();
  await page.refreshRecordings();
  assert.equal(page.node('status').textContent, page.catalogs.en['ui.error.credentials']);
  assert.equal(page.node('recording-message').textContent, page.catalogs.en['service.recordings.invalidEndTime']);
  page.selectLanguage('zh-CN');
  assert.equal(page.node('status').textContent, page.catalogs['zh-CN']['ui.error.credentials']);
  assert.equal(page.node('recording-message').textContent, page.catalogs['zh-CN']['service.recordings.invalidEndTime']);
});
