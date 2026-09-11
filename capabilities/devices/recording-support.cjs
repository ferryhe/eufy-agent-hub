const { Device, DeviceCommands, CommandName } = require('../../adapters/eufy');

function isRecordingCamera(device) {
  return Number.isInteger(device?.device_type)
    && Device.isCamera(device.device_type)
    && (DeviceCommands[device.device_type] || []).includes(CommandName.DeviceStartDownload);
}

function supportsEventRecordings(device, inventory) {
  return isRecordingCamera(device) && inventory.some(base =>
    base.device_sn === device.parent_sn && base.device_model === 'T8030');
}

module.exports = { isRecordingCamera, supportsEventRecordings };
