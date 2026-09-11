// Only the hardware-tested continuous recording path is advertised here.
const { supportsEventRecordings } = require('./recording-support.cjs');
function continuousDevices(inventory) {
  if (!Array.isArray(inventory) || inventory.some(raw => !raw || typeof raw.device_sn !== 'string' || !raw.device_sn))
    throw new Error('Device inventory is missing a device serial.');
  return inventory.map(raw => {
    const base = inventory.find(item => item.device_sn === raw.parent_sn);
    const supported = raw.device_model === 'T8600' && base?.device_model === 'T8030'
      && Number.isInteger(raw.device_channel) && raw.device_channel >= 0 && supportsEventRecordings(raw, inventory);
    const address = base?.local_ip || base?.params?.find(item => item.param_type === 1176)?.param_value;
    return {
      serial: raw.device_sn, name: typeof raw.device_name === 'string' && raw.device_name ? raw.device_name : raw.device_sn,
      model: typeof raw.device_model === 'string' ? raw.device_model : null,
      homeBaseId: base?.device_sn || null, channel: Number.isInteger(raw.device_channel) ? raw.device_channel : null,
      recordingExport: { supported, status: supported ? 'verified' : 'unsupported' },
      // Inventory cannot prove that a LAN device is online; a range query tests reachability.
      availability: supported && !address ? 'unavailable' : 'unknown',
    };
  });
}

module.exports = { continuousDevices };
