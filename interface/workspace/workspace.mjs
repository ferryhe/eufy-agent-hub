import { createResults } from '../components/results.mjs';
import { descriptor, presentation, viewKey } from './contract.mjs';

export function mountWorkspace({ document, i18n, storage, fetch, onChange }) {
  const root = document.getElementById('workspace-views');
  const results = createResults({ document, i18n });
  const t = key => i18n.t(key);
  const storageKey = 'eufy-agent-hub.workspace';
  const entries = new Map();
  let pinned = [], order = [], compositionKey, state = {}, inventory, failure, actionError, extracting = false;
  try { const saved = JSON.parse(storage?.getItem(storageKey) || 'null'); pinned = presentation(saved); } catch {}
  function save() {
    try { storage?.setItem(storageKey, JSON.stringify({ version: 1, views: pinned })); } catch {}
  }
  const node = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
  async function extract(receiptId) {
    if (extracting) return;
    extracting = true; actionError = undefined; render();
    try {
      const response = await fetch('/interface/agent/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receiptId }) });
      const body = await response.json();
      if (!response.ok || body.error && !body.job) actionError = body.error;
      await onChange();
    } catch { actionError = { code: 'SERVICE_UNAVAILABLE' }; }
    finally { extracting = false; render(); }
  }
  // The registered components and handlers are used in both fixed and Agent modes.
  const registry = {
    'device-list': (item, entry) => {
      if (item.deviceIds === false) return unavailable(entry, 'ui.workspaceUnsupported');
      if (!inventory || inventory.error) return unavailable(entry, 'ui.workspaceUnavailable', inventory?.error);
      const devices = item.deviceIds === null ? inventory.devices : item.deviceIds.map(id => inventory.devices.find(d => d.serial === id));
      const content = node('div'); content.className = 'device-grid';
      if (!devices.length) content.append(node('p', t('ui.workspaceNoDevices')));
      for (const device of devices) content.append(device ? results.device(device) : node('p', t('ui.workspaceUnavailable')));
      replace(entry, content, [devices, i18n.locale]);
    },
    timeline: (item, entry) => {
      if (!item.receiptId) return unavailable(entry, 'ui.workspaceUnsupported');
      const receipt = state.receipts?.find(r => r.id === item.receiptId);
      if (!receipt) return unavailable(entry, 'ui.workspaceUnavailable');
      const content = results.timeline({ window: receipt.window, ranges: receipt.ranges,
        label: `${receipt.device.name} · ${receipt.serial}` });
      const button = node('button', t('ui.workspaceExport')); button.type = 'button'; button.disabled = extracting;
      button.onclick = () => extract(item.receiptId); content.append(button);
      replace(entry, content, [receipt, i18n.locale, extracting]);
    },
    'job-card': (item, entry) => {
      if (!item.jobId) return unavailable(entry, 'ui.workspaceUnsupported');
      const view = state.jobs?.find(view => (view.job?.jobId || view.jobId) === item.jobId);
      if (!view?.job) return unavailable(entry, 'ui.workspaceUnavailable', view?.error);
      if (entry.kind !== 'job') { entry.content.replaceChildren(results.job(view)); entry.kind = 'job'; }
      else results.updateJob(entry.content.firstElementChild, view);
    },
    player: (item, entry) => {
      if (!item.jobId || !item.artifactId) return unavailable(entry, 'ui.workspaceUnsupported');
      const view = state.jobs?.find(view => (view.job?.jobId || view.jobId) === item.jobId);
      const artifact = view?.videos?.find(a => a.id === item.artifactId);
      if (!artifact) return unavailable(entry, 'ui.workspaceUnavailable', view?.error);
      if (entry.kind !== 'player') { entry.content.replaceChildren(results.player(artifact, artifact.name)); entry.kind = 'player'; }
      const card = entry.content.firstElementChild;
      card.querySelector('strong').textContent = `${artifact.name} · ${i18n.t(`ui.job.${artifact.outcome}`)}`;
      card.querySelector('a').textContent = t('ui.downloadFile');
    },
  };
  function replace(entry, content, data) {
    const key = JSON.stringify(data);
    if (entry.kind !== key) { entry.content.replaceChildren(content); entry.kind = key; }
  }
  function unavailable(entry, key, error) { replace(entry, node('p', t(key) + (error ? ' ' + results.error(error) : '')), [key, error, i18n.locale]); }
  function views() {
    const defaults = [{ type: 'device-list', deviceIds: null }, ...(state.receipts || []).map(r => ({ type: 'timeline', receiptId: r.id })),
      ...(state.jobs || []).filter(v => v.job).map(v => ({ type: 'job-card', jobId: v.job.jobId }))];
    const composed = state.presentation ? presentation(state.presentation) : defaults;
    const nextCompositionKey = JSON.stringify(state.presentation);
    if (compositionKey !== nextCompositionKey) { compositionKey = nextCompositionKey; order = pinned.map(viewKey); }
    const current = [...new Map([...pinned, ...composed].map(v => [viewKey(v), descriptor(v)])).values()];
    // Keep a user's order when polling, and append newly composed results.
    const keys = new Set(current.map(viewKey));
    order = [...order.filter(key => keys.has(key)), ...current.map(viewKey).filter(key => !order.includes(key))];
    return order.map(key => current.find(v => viewKey(v) === key));
  }
  function render() {
    const items = views(), keys = new Set(items.map(viewKey));
    document.getElementById('workspace-status').textContent = failure ? results.error(failure) : actionError ? results.error(actionError) : '';
    for (const [key, entry] of entries) if (!keys.has(key)) { entry.shell.remove(); entries.delete(key); }
    items.forEach((item, index) => {
      const key = viewKey(item), isPinned = pinned.some(v => viewKey(v) === key);
      let entry = entries.get(key);
      if (!entry) {
        const shell = node('article'); shell.className = 'workspace-view'; shell.dataset.view = key; shell.dataset.type = item.type;
        const controls = node('div'); controls.className = 'workspace-controls';
        const title = node('strong'), pin = node('button'), up = node('button'), down = node('button');
        for (const button of [pin, up, down]) button.type = 'button';
        const content = node('div'); controls.append(title, pin, up, down); shell.append(controls, content);
        entry = { shell, content, title, pin, up, down }; entries.set(key, entry);
      }
      entry.title.textContent = Object.hasOwn(registry, item.type) ? t(`ui.workspace.${item.type}`) : t('ui.workspaceUnknown');
      entry.pin.textContent = t(isPinned ? 'ui.workspaceUnpin' : 'ui.workspacePin');
      entry.pin.setAttribute('aria-pressed', String(isPinned));
      entry.pin.onclick = () => { pinned = isPinned ? pinned.filter(v => viewKey(v) !== key) : items.filter(v => viewKey(v) === key || pinned.some(p => viewKey(p) === viewKey(v))); save(); render(); };
      const move = direction => {
        const target = index + direction; [order[index], order[target]] = [order[target], order[index]];
        pinned.sort((a, b) => order.indexOf(viewKey(a)) - order.indexOf(viewKey(b))); save(); render();
      };
      entry.up.textContent = t('ui.workspaceUp'); entry.up.disabled = index === 0; entry.up.onclick = () => move(-1);
      entry.down.textContent = t('ui.workspaceDown'); entry.down.disabled = index === items.length - 1; entry.down.onclick = () => move(1);
      if (Object.hasOwn(registry, item.type)) registry[item.type](item, entry); else unavailable(entry, 'ui.workspaceUnsupported');
      const before = root.children[index];
      if (before !== entry.shell) {
        // Chrome's state-preserving move keeps playing video alive during reorder.
        if (entry.shell.parentNode === root && root.moveBefore) root.moveBefore(entry.shell, before || null);
        else root.insertBefore(entry.shell, before || null);
      }
    });
  }
  return { render, update(value, devices, error) { state = value || {}; inventory = devices; failure = error; render(); },
    jobIds: () => [...new Set([...pinned, ...views()].map(v => v.jobId).filter(Boolean))],
  };
}
