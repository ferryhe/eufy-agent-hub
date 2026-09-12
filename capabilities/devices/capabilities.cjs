const { DeviceCommands, CommandName } = require('../../adapters/eufy');
const { continuousDevices } = require('./continuous-mapping.cjs');

const CAPABILITIES = Object.freeze([
  'continuousRecordingQuery', 'continuousRecordingExport', 'eventRecordings', 'liveVideo', 'talkback', 'rtsp',
]);
const STATUSES = Object.freeze(['verified', 'unsupported', 'unknown', 'protocol_hint']);
const text = value => typeof value === 'string' && value.trim() ? value : null;
const firmware = raw => ({ main: text(raw.main_sw_version), secondary: text(raw.sec_sw_version) });
const channel = value => Number.isInteger(value) && value >= 0 ? value : null;

function scopeFor(raw, base) {
  const parent = text(raw.parent_sn);
  return {
    serial: raw.device_sn, model: text(raw.device_model), firmware: firmware(raw),
    homeBase: base ? { serial: base.device_sn, model: text(base.device_model), firmware: firmware(base) }
      : parent && parent !== raw.device_sn ? { serial: parent, model: null, firmware: { main: null, secondary: null } } : null,
    channel: channel(raw.device_channel),
  };
}

// Construct keys explicitly so persisted JSON property order cannot affect scope matching.
function scopeKey(scope) {
  const device = item => [item.serial, item.model, item.firmware.main, item.firmware.secondary];
  return JSON.stringify([...device(scope), scope.homeBase ? device(scope.homeBase) : null, scope.channel]);
}

function validFirmware(value) {
  return value && ['main', 'secondary'].every(key => value[key] === null || text(value[key]) !== null);
}

function validateRecord(record) {
  if (!CAPABILITIES.includes(record?.capability)) throw new Error('Unknown capability.');
  if (!STATUSES.includes(record.status)) throw new Error('Unknown capability status.');
  const scope = record.scope;
  const validDevice = item => item && text(item.serial) && (item.model === null || text(item.model)) && validFirmware(item.firmware);
  if (!validDevice(scope) || !(scope.homeBase === null || validDevice(scope.homeBase))
    || !(scope.channel === null || channel(scope.channel) !== null)) throw new Error('Explicit device and firmware scope is required.');
  if (!text(record.reason)) throw new Error('Capability reason is required.');
  if (!Array.isArray(record.evidence) || record.evidence.some(item => !text(item?.source)
    || !text(item.observedAt) || !Number.isFinite(Date.parse(item.observedAt)) || !text(item.outcome))
    || (['verified', 'unsupported'].includes(record.status) && !record.evidence.length)) {
    throw new Error('Dated evidence is required for a verified or unsupported capability.');
  }
}

/** Pure incremental update. The caller owns persistence; this function never writes to disk or hardware. */
function recordCapability(records, record) {
  records.forEach(validateRecord);
  validateRecord(record);
  const key = scopeKey(record.scope);
  return structuredClone([...records.filter(existing => existing.capability !== record.capability
    || scopeKey(existing.scope) !== key), record]);
}

function entry(status, reason, evidence = []) {
  return { status, reason, evidence: structuredClone(evidence) };
}

function defaultCapability(capability, raw, base, eligible) {
  if (capability === 'continuousRecordingQuery' || capability === 'continuousRecordingExport') {
    if (eligible) return entry('protocol_hint', 'tested_model_path_requires_device_firmware_verification');
    if (raw.device_model === 'T8030') return entry('protocol_hint', 'historical_homebase_path_requires_device_firmware_verification');
    if (raw.device_model === 'T8600' && (!base || channel(raw.device_channel) === null))
      return entry('unknown', 'association_missing');
    return entry('unknown', 'no_verified_continuous_recording_path');
  }
  const command = {
    eventRecordings: CommandName.DeviceStartDownload,
    liveVideo: CommandName.DeviceStartLivestream,
    talkback: CommandName.DeviceStartTalkback,
  }[capability];
  const commands = Number.isInteger(raw.device_type) ? DeviceCommands[raw.device_type] || [] : [];
  return command && commands.includes(command)
    ? entry('protocol_hint', 'protocol_command_declared_not_hardware_verified')
    : entry('unknown', 'no_verification_or_protocol_hint');
}

/** Device/firmware capability projection shared by local callers and the v1 query API. */
function describeDevices(inventory, { records = [], reachability = [] } = {}) {
  records.forEach(validateRecord);
  const legacy = continuousDevices(inventory);
  return inventory.map((raw, index) => {
    const base = inventory.find(item => item.device_sn === raw.parent_sn && item.device_sn !== raw.device_sn);
    const scope = scopeFor(raw, base);
    const device = legacy[index];
    const capabilities = Object.fromEntries(CAPABILITIES.map(capability => [capability,
      defaultCapability(capability, raw, base, device.recordingExport.supported)]));
    // Unknown firmware is not a wildcard, even when the historical record also has null firmware.
    if (scope.model && scope.firmware.main && (!scope.homeBase || (scope.homeBase.model && scope.homeBase.firmware.main))) {
      for (const record of records) {
        if (scopeKey(record.scope) === scopeKey(scope)) {
          capabilities[record.capability] = entry(record.status, record.reason, record.evidence);
        }
      }
    }
    // Mega inventory status has no documented online/offline semantics. Reachability is an explicit,
    // dated observation supplied by the caller, never inferred from status codes or a LAN address.
    const observed = reachability.findLast(item => item.serial === raw.device_sn && ['online', 'offline'].includes(item.status)
      && text(item.reason) && text(item.observedAt) && Number.isFinite(Date.parse(item.observedAt)));
    return {
      ...device, model: scope.model, homeBaseId: base?.device_sn || null, channel: scope.channel,
      firmware: firmware(raw),
      availability: observed?.status || device.availability,
      state: {
        inventoryStatus: Number.isInteger(raw.status) ? raw.status : null,
        reason: observed?.reason || (device.availability === 'unavailable'
          ? 'homebase_address_missing' : 'inventory_does_not_prove_reachability'),
        observedAt: observed?.observedAt || null,
      },
      recordingExport: { supported: device.recordingExport.supported, status: capabilities.continuousRecordingExport.status },
      verificationScope: scope,
      verificationHistory: structuredClone(records.filter(record => record.scope.serial === raw.device_sn)),
      capabilities,
    };
  });
}

function queryDevice(inventory, serial, options) {
  return describeDevices(inventory, options).find(device => device.serial === serial) || null;
}

function queryCapability(device, capability) {
  return structuredClone((CAPABILITIES.includes(capability) && device?.capabilities?.[capability])
    || entry('unknown', 'capability_not_catalogued'));
}

module.exports = { CAPABILITIES, STATUSES, describeDevices, queryDevice, queryCapability, recordCapability };
