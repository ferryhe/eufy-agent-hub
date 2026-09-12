const { serviceError } = require('../../api/messages.cjs');

// Evidence and protocol boundary: ./DISCOVERY.md. This is the known request size,
// not proof of either a server-side hard cap or a continuation mechanism.
const REQUEST_SIZE = 100;

function initialDiscovery() {
  return { status: 'not_requested', completeness: 'unknown', pagination: 'unverified',
    pagesRead: 0, receivedCount: 0, uniqueCount: 0, limitReached: false,
    failedPage: null, retryable: false, stale: false, reasons: ['pagination_unverified'] };
}

function failedDiscovery(discovery, reason, failedPage = null) {
  return { ...discovery, status: 'failed', completeness: 'incomplete', failedPage, retryable: true,
    reasons: [...discovery.reasons, reason] };
}

// A local collection model, not a Mega wire pagination API. Iterator exhaustion
// only proves that the supplied pages were consumed; completeness stays unknown.
async function collectDevicePages(pages) {
  let discovery = initialDiscovery(), error = null;
  const devices = new Map();
  try {
    for await (const page of pages) {
      if (!Array.isArray(page?.devices)) throw serviceError('设备列表格式与预期不符。', 'service.devices.invalidInventory');
      if (page.devices.some(raw => !raw || typeof raw.device_sn !== 'string' || !raw.device_sn))
        throw serviceError('设备列表缺少设备标识。', 'service.devices.missingSerial');
      for (const raw of page.devices) devices.set(raw.device_sn, raw);
      discovery.pagesRead++;
      discovery.receivedCount += page.devices.length;
      discovery.uniqueCount = devices.size;
      discovery.limitReached ||= page.devices.length >= REQUEST_SIZE;
    }
    discovery.status = 'succeeded';
  } catch (failure) {
    error = failure;
    const invalid = ['service.devices.invalidInventory', 'service.devices.missingSerial'].includes(error.i18n?.key);
    discovery = failedDiscovery(discovery, invalid ? 'invalid_inventory' : 'inventory_request_failed', discovery.pagesRead + 1);
  }
  if (discovery.limitReached) discovery.reasons.push('request_limit_reached');
  return { devices: [...devices.values()], discovery, error };
}

async function readDeviceInventory(api) {
  // Do not infer page/cursor/has_more/total semantics from arbitrary raw fields.
  // No verified continuation request exists in the retained Mega implementation.
  async function* pages() { yield await api.getDevsListDecrypted(); }
  return collectDevicePages(pages());
}

module.exports = { initialDiscovery, failedDiscovery, collectDevicePages, readDeviceInventory };
