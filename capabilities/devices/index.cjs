function getDevices(session) {
  return {
    devices: session.state.devices.map(device => ({ ...device })),
    diagnostics: [...session.state.diagnostics],
    message: session.state.message,
  };
}

async function refreshDevices(session) {
  await session.refresh();
  return getDevices(session);
}

module.exports = { getDevices, refreshDevices };
