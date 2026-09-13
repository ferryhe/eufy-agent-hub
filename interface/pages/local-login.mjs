import { createI18n } from '/assets/i18n.mjs';
import { createResults } from '/assets/results.mjs';
import { mountSidebar } from '/assets/sidebar.mjs';

const catalogs = Object.fromEntries(await Promise.all(['en', 'zh-CN'].map(async locale => {
  const response = await fetch(`/locales/${locale}.json`);
  if (!response.ok) throw new Error(`Cannot load locale ${locale}`);
  return [locale, await response.json()];
})));
let storage;
try { storage = window.localStorage; } catch { /* Storage is optional. */ }
const i18n = createI18n({ catalogs, storage, languages: () => navigator.languages || [navigator.language] });
const el = id => document.getElementById(id);
const t = (key, params) => i18n.t(key, params);
const components = createResults({ document, i18n });
let sidebar;
let authState, recordingState, authError, recordingError;
let deviceKey = '', resultKey = '', savedKey = '';

el('recording-day').value = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function errorText(error) {
  if (error.error && typeof error.error === 'object') return components.error(error.error);
  return error.errorI18n ? i18n.message(error.error, error.errorI18n) : t('ui.externalError', { detail: error.error });
}
function localError(key) { return { errorI18n: { key } }; }
function updateQueryButton() {
  el('query-submit').disabled = !authState || authState.busy || recordingState?.busy || authState.phase !== 'connected' || !el('recording-device').value;
}
function deviceLabel(device) {
  return i18n.message(device.name, device.nameI18n) + ' · ' + i18n.message(device.model, device.modelI18n);
}
function renderAuth() {
  if (authState) {
    const s = authState;
    const nextDeviceKey = JSON.stringify([s.devices, i18n.locale]);
    if (deviceKey !== nextDeviceKey) {
      deviceKey = nextDeviceKey;
      const selected = el('recording-device').value;
      el('recording-device').replaceChildren(...s.devices.filter(d => d.capabilities?.eventRecordings === true).map(d => {
        const option = document.createElement('option');
        option.value = d.serial; option.textContent = deviceLabel(d);
        option.selected = selected ? d.serial === selected : d.name === 'Drive Way';
        return option;
      }));
      el('devices').replaceChildren(...s.devices.map(d => {
        const li = document.createElement('li'); li.textContent = deviceLabel(d); return li;
      }));
    }
    el('submit').disabled = s.busy;
    el('verify-submit').disabled = s.busy;
    el('reload-devices').hidden = s.phase !== 'connected';
    el('reload-devices').disabled = s.busy;
    el('logout').hidden = !['connected', 'tfa', 'captcha'].includes(s.phase);
    el('logout').disabled = s.busy;
    el('diagnostics').replaceChildren(...(s.diagnostics || []).map((text, index) => {
      const li = document.createElement('li');
      li.textContent = i18n.message(text, s.diagnosticsI18n?.[index]); return li;
    }));
    el('login').hidden = ['tfa', 'captcha', 'connected'].includes(s.phase);
    el('verify').hidden = !['tfa', 'captcha'].includes(s.phase);
    el('captcha').hidden = s.phase !== 'captcha';
    if (s.phase === 'captcha') el('captcha').src = s.captcha;
  }
  el('status').textContent = authError ? errorText(authError) : authState
    ? i18n.message(authState.message, authState.messageI18n) : t('ui.connecting');
  updateQueryButton();
}
function renderRecordings() {
  const state = recordingState;
  el('recording-message').textContent = recordingError ? errorText(recordingError) : state
    ? i18n.message(state.message, state.messageI18n) : '';
  if (!state) return;
  const expectedQuery = state.query ? { serial: state.query.serial, ...state.query.window.input } : null;
  const nextResultKey = JSON.stringify([expectedQuery, state.records, state.busy, i18n.locale]);
  if (nextResultKey !== resultKey) {
    resultKey = nextResultKey;
    el('recording-results').replaceChildren(...(state.records.length && expectedQuery ? [components.timeline({
      ranges: state.records.map(record => ({ ...record, start: i18n.date(record.start), end: i18n.date(record.end) })),
      busy: state.busy, action: record => recordingAction('/recordings/download', { recordId: record.id, expectedQuery }),
    })] : []));
  }
  const nextSavedKey = JSON.stringify(state.saved);
  if (savedKey !== nextSavedKey) {
    savedKey = nextSavedKey;
    el('saved-recordings').replaceChildren(...state.saved.map(clip => components.player(clip, clip.device)));
  }
  // Updating translated labels in place preserves video playback and currentTime.
  [...el('saved-recordings').children].forEach((div, index) => {
    const clip = state.saved[index];
    div.querySelector('strong').textContent = clip.device + ' · ' + i18n.date(clip.start);
    div.querySelector('a').textContent = t('ui.download', { size: i18n.number(clip.bytes / 1024 / 1024) });
  });
  updateQueryButton();
}
function applyLanguage() {
  document.documentElement.lang = i18n.locale;
  document.title = t('ui.title');
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-alt]').forEach(node => { node.alt = t(node.dataset.i18nAlt); });
  el('language').value = i18n.preference;
  renderAuth(); renderRecordings(); sidebar?.render();
}
el('language').addEventListener('change', () => { i18n.setPreference(el('language').value); applyLanguage(); });
window.addEventListener('languagechange', () => { if (i18n.preference === 'auto') applyLanguage(); });

async function refresh() {
  try {
    const response = await fetch('/status');
    if (!response.ok) throw new Error();
    const nextState = await response.json();
    if (['ui.disconnected', 'ui.unreachable'].includes(authError?.errorI18n?.key)
      || JSON.stringify(nextState) !== JSON.stringify(authState)) authError = undefined;
    authState = nextState;
  } catch { authError ??= localError('ui.disconnected'); }
  renderAuth();
}
async function submit(url, data) {
  authError = undefined;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) { authError = result; renderAuth(); return; }
    el('password').value = ''; el('code').value = '';
    await refresh();
  } catch { authError = localError('ui.unreachable'); renderAuth(); }
}
async function refreshRecordings() {
  try {
    const response = await fetch('/recordings/status');
    if (!response.ok) throw new Error();
    const nextState = await response.json();
    if (['ui.recordings.unavailable', 'ui.recordings.unreachable'].includes(recordingError?.errorI18n?.key)
      || JSON.stringify(nextState) !== JSON.stringify(recordingState)) recordingError = undefined;
    recordingState = nextState;
  } catch { recordingError ??= localError('ui.recordings.unavailable'); }
  renderRecordings();
}
async function recordingAction(route, data) {
  recordingError = undefined;
  try {
    const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) { recordingError = result; renderRecordings(); return; }
    await refreshRecordings();
  } catch { recordingError = localError('ui.recordings.unreachable'); renderRecordings(); }
}
el('login').addEventListener('submit', event => {
  event.preventDefault(); submit('/login', { email: el('email').value, password: el('password').value, country: el('country').value });
});
el('verify').addEventListener('submit', event => { event.preventDefault(); submit('/verify', { code: el('code').value }); });
el('reload-devices').addEventListener('click', () => submit('/refresh', {}));
el('logout').addEventListener('click', () => submit('/logout', {}));
el('query-recordings').addEventListener('submit', event => {
  event.preventDefault(); recordingAction('/recordings/query', {
    serial: el('recording-device').value, day: el('recording-day').value, start: el('recording-start').value, end: el('recording-end').value, timezone: 'America/Toronto',
  });
});
applyLanguage();
sidebar = mountSidebar({ document, window, i18n, fetch, storage });
refresh(); setInterval(refresh, 1500);
refreshRecordings(); setInterval(refreshRecordings, 1500);
