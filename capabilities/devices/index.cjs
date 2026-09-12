const { initialDiscovery } = require('./discovery.cjs');

function getDevices(session) {
  return {
    devices: session.state.devices.map(device => ({ ...device,
      ...(device.capabilities ? { capabilities: { ...device.capabilities } } : {}),
    })),
    diagnostics: [...session.state.diagnostics],
    discovery: structuredClone(session.state.discovery || initialDiscovery()),
    message: session.state.message,
  };
}

async function refreshDevices(session) {
  await session.refresh();
  return getDevices(session);
}

module.exports = { getDevices, refreshDevices, ...require('./capabilities.cjs'), ...require('./verification-store.cjs') };
