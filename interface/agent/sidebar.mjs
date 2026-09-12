import { createResults } from '/assets/results.mjs';

export function mountSidebar({ document, window, i18n, fetch, storage }) {
  const el = id => document.getElementById(id), t = (key, params, fallback) => i18n.t(key, params, fallback);
  const results = createResults({ document, i18n });
  let state, inventory, pollError, submitError, polling = false, sending = false, pending;
  let mode = 'fixed', responseLocale = 'auto', receiptKey = '', deviceKey = '', turnKey = '', noticeKey = '';
  try {
    mode = storage?.getItem('eufy-agent-hub.mode') === 'agent' ? 'agent' : 'fixed';
    responseLocale = storage?.getItem('eufy-agent-hub.responseLocale') || 'auto';
    pending = JSON.parse(storage?.getItem('eufy-agent-hub.pendingTurn') || 'null');
    el('agent-message').value = storage?.getItem('eufy-agent-hub.draft') || '';
  } catch { /* Optional browser storage. Resident state is authoritative. */ }
  const save = (key, value) => { try { storage?.setItem(`eufy-agent-hub.${key}`, value); } catch {} };
  function acknowledge(turn) {
    if (el('agent-message').value === turn.text) {
      el('agent-message').value = ''; save('draft', '');
    }
    if (pending?.id === turn.id) {
      pending = undefined; save('pendingTurn', 'null'); submitError = undefined;
    }
  }
  function setMode(value) {
    mode = value; save('mode', mode);
    document.documentElement.dataset.mode = mode;
    el('agent-sidebar').hidden = mode !== 'agent';
    for (const id of ['recordings', 'saved-section']) el(id).hidden = mode !== 'fixed';
    for (const value of ['fixed', 'agent']) el(`mode-${value}`).setAttribute('aria-pressed', String(mode === value));
  }
  function errorText(value) {
    return results.error(value);
  }
  function render() {
    el('response-language').value = ['en', 'zh-CN'].includes(responseLocale) ? responseLocale : 'auto';
    el('agent-send').disabled = sending || state?.busy === true;
    el('agent-status').textContent = submitError ? errorText(submitError) : pollError ? errorText(pollError)
      : state?.busy ? t('ui.agentRunning') : t('ui.agentReady');
    const turns = state?.turns || [];
    const nextTurnKey = JSON.stringify([turns, i18n.locale]);
    if (turnKey !== nextTurnKey) {
      turnKey = nextTurnKey;
      el('agent-history').replaceChildren(...turns.map(turn => {
        const article = document.createElement('article'); article.className = 'conversation-turn';
        const user = document.createElement('p'); user.textContent = `${t('ui.you')}: ${turn.text}`;
        const response = document.createElement('p'); response.textContent = turn.error ? errorText(turn.error)
          : turn.state === 'running' ? t('ui.agentRunning') : turn.response;
        article.append(user, response); return article;
      }));
    }
    const notices = state?.busy ? state.notices : turns.at(-1)?.notices || [];
    const nextNoticeKey = JSON.stringify([notices, i18n.locale]);
    if (noticeKey !== nextNoticeKey) {
      noticeKey = nextNoticeKey;
      el('agent-notices').replaceChildren(...notices.map(notice => {
        const item = document.createElement('p'); item.textContent = errorText(notice.error);
        if (notice.devices) for (const device of notice.devices) item.append(results.device(device));
        return item;
      }));
    }
    const nextDeviceKey = JSON.stringify([inventory, i18n.locale]);
    if (deviceKey !== nextDeviceKey) {
      deviceKey = nextDeviceKey;
      el('shared-devices').replaceChildren(...(inventory?.devices || []).map(results.device));
      el('device-status').textContent = inventory?.error ? errorText(inventory.error) : '';
    }
    const nextReceiptKey = JSON.stringify([state?.receipts, i18n.locale]);
    if (receiptKey !== nextReceiptKey) {
      receiptKey = nextReceiptKey;
      el('shared-timelines').replaceChildren(...(state?.receipts || []).map(receipt => results.timeline({
        window: receipt.window, ranges: receipt.ranges, label: `${receipt.device.name} · ${receipt.serial}`,
      })));
    }
    el('job-status').textContent = (state?.jobs || []).filter(view => !view.job && view.error).map(view => errorText(view.error)).join('\n');
    for (const view of state?.jobs || []) {
      if (!view.job) continue;
      const existing = [...el('shared-jobs').children].find(card => card.dataset.job === view.job.jobId);
      if (existing) results.updateJob(existing, view); else el('shared-jobs').append(results.job(view));
    }
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch('/interface/agent/state');
      const body = await response.json();
      if (!response.ok) throw body.error;
      state = body; pollError = undefined;
      if (pending && state.turns.some(turn => turn.id === pending.id)) {
        acknowledge(pending);
      }
      const devices = await fetch('/api/v1/devices');
      inventory = await devices.json();
    } catch { pollError = { code: 'SERVICE_UNAVAILABLE' }; }
    finally { polling = false; render(); }
  }
  async function send(event) {
    event?.preventDefault();
    if (sending || state?.busy) return;
    const text = el('agent-message').value;
    if (!text.trim()) return;
    // A lost POST response retries only this same turn identity.
    if (!pending || pending.text !== text) pending = { id: window.crypto.randomUUID(), text,
      locale: ['en', 'zh-CN'].includes(responseLocale) ? responseLocale : i18n.locale };
    save('pendingTurn', JSON.stringify(pending)); sending = true; submitError = undefined; render();
    const submitted = pending;
    try {
      const response = await fetch('/interface/agent/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submitted) });
      const body = await response.json();
      if (!response.ok) { submitError = body.error; return; }
      acknowledge(submitted);
      await poll();
    } catch { if (pending?.id === submitted.id) submitError = { code: 'SERVICE_UNAVAILABLE' }; }
    finally { sending = false; render(); }
  }
  for (const value of ['fixed', 'agent']) el(`mode-${value}`).addEventListener('click', () => setMode(value));
  el('response-language').addEventListener('change', () => {
    responseLocale = el('response-language').value; save('responseLocale', responseLocale);
  });
  el('agent-message').addEventListener('input', () => save('draft', el('agent-message').value));
  el('agent-form').addEventListener('submit', send);
  el('agent-login').addEventListener('click', () => {
    const target = !el('verify').hidden ? el('code') : !el('login').hidden ? el('email') : el('status');
    target.scrollIntoView(); target.focus();
  });
  setMode(mode); render(); poll();
  const timer = window.setInterval(poll, 1500);
  return { render, poll, send, stop: () => window.clearInterval(timer) };
}
