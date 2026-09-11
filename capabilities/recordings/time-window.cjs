const { serviceError } = require('../../api/messages.cjs');

const LEGACY_TIMEZONE = 'America/Toronto';

function resolveTimezone(timezone = process.env.EUFY_RECORDING_TIMEZONE ?? LEGACY_TIMEZONE) {
  try {
    if (typeof timezone !== 'string' || !timezone || /^[+-]/.test(timezone)) throw new RangeError();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return timezone;
  } catch {
    throw serviceError('请提供有效的 IANA 时区。', 'service.recordings.invalidTimezone');
  }
}

function validateDay(day) {
  const value = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(value) || day.startsWith('0000') || new Date(value).toISOString().slice(0, 10) !== day) {
    throw serviceError('日期格式错误。', 'service.recordings.invalidDate');
  }
  return day;
}

function localTime(day, time, timezone) {
  validateDay(day);
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw serviceError('请填写有效的日期和时间。', 'service.recordings.invalidDateTime');
  }
  timezone = resolveTimezone(timezone);
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wallTime = instant => {
    const parts = Object.fromEntries(clock.formatToParts(instant).map(part => [part.type, part.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
  };
  const target = `${day}T${time}:00Z`, naive = Date.parse(target);
  // Gather offsets on both sides of nearby transitions, including non-hour offsets.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours++) {
    const instant = naive + hours * 3600000;
    offsets.add(Date.parse(wallTime(instant)) - instant);
  }
  const matches = [...offsets].map(offset => naive - offset).filter(instant => wallTime(instant) === target);
  if (matches.length !== 1) {
    throw serviceError('此时间不存在或因夏令时重复，请选择明确的时间。', 'service.recordings.ambiguousTime');
  }
  return matches[0];
}

function normalizeWindow(data, options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw serviceError('请填写有效的日期和时间。', 'service.recordings.invalidDateTime');
  }
  const timezone = resolveTimezone(data.timezone === undefined ? options.defaultTimezone : data.timezone);
  const start = localTime(data.day, data.start, timezone);
  const end = localTime(data.day, data.end, timezone);
  if ((data.endDay !== undefined && data.endDay !== data.day) || end <= start) {
    throw serviceError('结束时间必须晚于开始时间，且在同一天。', 'service.recordings.invalidEndTime');
  }
  return {
    version: 1,
    input: { day: data.day, start: data.start, end: data.end, timezone: data.timezone ?? null },
    normalized: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone },
  };
}

module.exports = { normalizeWindow, localTime, resolveTimezone, validateDay, LEGACY_TIMEZONE };
