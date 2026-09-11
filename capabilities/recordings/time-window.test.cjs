const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWindow } = require('./time-window.cjs');

const request = { day:'2026-08-27', start:'16:30', end:'16:50' };

test('stable window preserves caller input separately from UTC instants and the effective zone', () => {
  const window = normalizeWindow(request, {defaultTimezone:'America/Toronto'});
  assert.deepEqual(window, {version:1, input:{...request, timezone:null}, normalized:{
    start:'2026-08-27T20:30:00.000Z', end:'2026-08-27T20:50:00.000Z', timezone:'America/Toronto'}});
  assert.deepEqual(JSON.parse(JSON.stringify(window)), window);
  assert.equal(normalizeWindow({...request, day:'2026-01-27'}, {defaultTimezone:'America/Toronto'}).normalized.start, '2026-01-27T21:30:00.000Z');
});

test('IANA zones include whole-hour and fractional offsets', () => {
  for (const [timezone, start] of [['Asia/Shanghai','2026-08-27T08:30:00.000Z'],
    ['Asia/Kathmandu','2026-08-27T10:45:00.000Z'], ['Pacific/Auckland','2026-08-27T04:30:00.000Z']]) {
    const window = normalizeWindow({...request, timezone});
    assert.equal(window.normalized.start, start);
    assert.equal(window.input.timezone, timezone);
    assert.equal(window.normalized.timezone, timezone);
  }
});

test('default precedence is explicit request, option, environment, then legacy Toronto', t => {
  const previous = process.env.EUFY_RECORDING_TIMEZONE;
  t.after(() => { if (previous === undefined) delete process.env.EUFY_RECORDING_TIMEZONE; else process.env.EUFY_RECORDING_TIMEZONE = previous; });
  delete process.env.EUFY_RECORDING_TIMEZONE;
  assert.equal(normalizeWindow(request).normalized.timezone, 'America/Toronto');
  process.env.EUFY_RECORDING_TIMEZONE = 'Asia/Shanghai';
  assert.equal(normalizeWindow(request).normalized.timezone, 'Asia/Shanghai');
  assert.equal(normalizeWindow(request, {defaultTimezone:'Europe/London'}).normalized.timezone, 'Europe/London');
  assert.equal(normalizeWindow({...request, timezone:'UTC'}, {defaultTimezone:'Europe/London'}).normalized.timezone, 'UTC');
  process.env.EUFY_RECORDING_TIMEZONE = 'not-a-zone';
  assert.throws(() => normalizeWindow(request), error => error.i18n.key === 'service.recordings.invalidTimezone');
});

test('invalid dates, times, zones, zero-length and cross-midnight windows are rejected', () => {
  for (const changes of [{day:'2026-02-30'}, {day:'2026-13-01'}, {day:'0000-01-01'}, {day:null},
    {start:'24:00'}, {start:'12:60'}, {start:123}, {timezone:'Mars/Base'}, {timezone:'+08:00'}, {timezone:null},
    {start:'16:50'}, {start:'23:50',end:'00:10'}, {endDay:'2026-08-28'}]) {
    assert.throws(() => normalizeWindow({...request, ...changes}), JSON.stringify(changes));
  }
  assert.throws(() => normalizeWindow(null));
});

test('Toronto spring and autumn reject missing/repeated endpoints while allowing transition-spanning windows', () => {
  const base = {timezone:'America/Toronto'};
  for (const data of [{day:'2026-03-08',start:'02:30',end:'03:30'}, {day:'2026-03-08',start:'01:30',end:'02:30'},
    {day:'2026-11-01',start:'01:30',end:'02:30'}, {day:'2026-11-01',start:'00:30',end:'01:30'}]) {
    assert.throws(() => normalizeWindow({...base,...data}), error => error.i18n.key === 'service.recordings.ambiguousTime');
  }
  const spring = normalizeWindow({...base,day:'2026-03-08',start:'01:30',end:'03:30'}).normalized;
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 3600000);
  const autumn = normalizeWindow({...base,day:'2026-11-01',start:'00:30',end:'02:30'}).normalized;
  assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 3 * 3600000);
});

test('non-hour DST transitions are also rejected without choosing an occurrence', () => {
  for (const data of [{day:'2026-04-05',start:'01:45',end:'02:30'}, {day:'2026-10-04',start:'02:15',end:'03:30'}]) {
    assert.throws(() => normalizeWindow({...data,timezone:'Australia/Lord_Howe'}), error => error.i18n.key === 'service.recordings.ambiguousTime');
  }
});
