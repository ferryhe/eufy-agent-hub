// Presentation only. Windows, range ordering, status and URLs belong to the API.
export function createResults({ document, i18n }) {
  const t = (key, params, fallback) => i18n.t(key, params, fallback);
  const error = value => t(`ui.error.${value.code}`, {}, value.message || value.code);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function device(device) {
    const card = node('article', undefined, 'device-card');
    const unknown = t('ui.capability.unknown');
    card.append(node('strong', device.name), node('p', `${device.model || unknown} · ${device.serial}`));
    if (device.firmware) card.append(node('p', t('ui.firmware', { main: device.firmware.main || unknown, secondary: device.firmware.secondary || unknown })));
    if (device.state && Object.hasOwn(device.state, 'inventoryStatus')) card.append(node('p', t('ui.inventoryStatus', { status: device.state.inventoryStatus ?? unknown })));
    if (device.state) card.append(node('p', t(`ui.availability.${device.availability}`)),
      node('small', [t(`ui.reason.${device.state.reason}`, {}, device.state.reason), device.state.observedAt].filter(Boolean).join(' · ')));
    if (device.recordingExport) card.append(node('p', t(device.recordingExport.supported ? 'ui.eligible' : 'ui.ineligible')),
      node('small', t('ui.evidence', { status: t(`ui.capability.${device.recordingExport.status}`) })));
    return card;
  }
  function timeline({ ranges, window, label, action, busy = false }) {
    const card = node('article', undefined, 'timeline-card');
    if (label) card.append(node('h3', label));
    if (window) {
      const normalized = window.normalized;
      card.append(node('p', t('ui.normalizedWindow', normalized)),
        node('small', t('ui.requestedWindow', window.input)), node('p', t('ui.indexHint')));
    }
    const list = node('ol');
    for (const range of ranges || []) {
      const item = node('li', `${range.start} — ${range.end}`);
      if (action) {
        const button = node('button', t('ui.extract')); button.type = 'button'; button.disabled = busy;
        button.onclick = () => action(range); item.append(button);
      }
      list.append(item);
    }
    if (ranges) card.append(ranges.length ? list : node('p', t('ui.noFootage')));
    return card;
  }
  function player(artifact, label) {
    const card = node('article', undefined, 'clip');
    const title = node('strong', label);
    const video = node('video'); video.controls = true; video.preload = 'metadata'; video.src = artifact.url;
    const link = node('a', t('ui.downloadFile')); link.href = artifact.url + (artifact.url.includes('?') ? '&' : '?') + 'download';
    card.append(title, video, link); return card;
  }
  function updateJob(card, view) {
    const { job } = view;
    card.querySelector('h3').textContent = `${t('ui.job')} · ${job.serial || ''} · ${job.jobId}`;
    card.querySelector('[data-status]').textContent = t(`ui.job.${view.status}`);
    card.querySelector('[data-stage]').textContent = `${t('ui.stage')}: ${t(`ui.stage.${job.stage}`, {}, job.stage)}`;
    const progress = card.querySelector('progress'); progress.value = job.progress ?? 0;
    progress.setAttribute('aria-label', t('ui.progress'));
    card.querySelector('[data-progress]').textContent = `${Math.round((job.progress ?? 0) * 100)}%`;
    card.querySelector('[data-error]').textContent = job.error ? error(job.error) : '';
    card.querySelector('[data-window]').replaceChildren(timeline({ window: job.window }));
    card.querySelector('summary').textContent = t('ui.details');
    card.querySelector('details').toggleAttribute('open', view.status === 'partial');
    card.querySelector('pre').textContent = JSON.stringify({ coverage: view.coverage, validation: view.validation,
      diagnostics: view.diagnostics, completeness: job.result?.completeness, stage: job.stage, error: job.error }, null, 2);
    const players = card.querySelector('[data-players]');
    // Keep video elements alive while polling, changing language and switching modes.
    const keys = new Set();
    for (const artifact of view.videos) {
      keys.add(artifact.id);
      let existing = [...players.children].find(child => child.dataset.artifact === artifact.id);
      if (!existing) { existing = player(artifact, artifact.name); existing.dataset.artifact = artifact.id; players.append(existing); }
      existing.querySelector('strong').textContent = `${artifact.name} · ${t(`ui.job.${artifact.outcome}`)}`;
      existing.querySelector('a').textContent = t('ui.downloadFile');
    }
    for (const child of [...players.children]) if (!keys.has(child.dataset.artifact)) child.remove();
  }
  function job(view) {
    const card = node('article', undefined, 'job-card'); card.dataset.job = view.job.jobId;
    card.append(node('h3'));
    for (const name of ['status', 'stage', 'progress', 'error', 'window', 'players']) {
      const element = node(name === 'window' || name === 'players' ? 'div' : 'p'); element.setAttribute(`data-${name}`, ''); card.append(element);
    }
    const progress = node('progress'); progress.max = 1; card.insertBefore(progress, card.querySelector('[data-progress]'));
    const details = node('details'); details.append(node('summary'), node('pre')); card.append(details);
    updateJob(card, view); return card;
  }
  return { device, timeline, player, job, updateJob, error };
}
