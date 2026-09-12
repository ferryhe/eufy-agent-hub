// Version 1 stores references only; labels, media URLs and status come from the resident.
export function descriptor(value) {
  const text = value => typeof value === 'string' && value.length > 0 ? value : null;
  const item = { type: text(value?.type) || 'unknown' };
  if (item.type === 'device-list') item.deviceIds = value.deviceIds == null ? null
    : Array.isArray(value.deviceIds) && value.deviceIds.every(text) ? [...new Set(value.deviceIds)] : false;
  if (item.type === 'timeline') item.receiptId = text(value.receiptId);
  if (['job-card', 'player'].includes(item.type)) item.jobId = text(value.jobId);
  if (item.type === 'player') item.artifactId = text(value.artifactId);
  return item;
}
export const viewKey = value => JSON.stringify(descriptor(value));
export function presentation(value) {
  if (!value) return [];
  if (value.version !== 1 || !Array.isArray(value.views)) return [{ type: 'unknown' }];
  return [...new Map(value.views.map(value => { const item = descriptor(value); return [viewKey(item), item]; })).values()];
}
