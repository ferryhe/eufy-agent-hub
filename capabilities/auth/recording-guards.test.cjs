const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalRecordings } = require('../recordings/events.cjs');

test('expired provider session cannot acquire a new recording connection', async () => {
  let cloudCalls = 0;
  const session = { authenticated: true, api: { hasValidSession: () => false,
    getDevsListDecrypted: async () => { cloudCalls++; return { devices: [] }; } } };
  await assert.rejects(new LocalRecordings(session).connect('camera'), /请先登录/);
  assert.equal(cloudCalls, 0);
});

test('logout during recording inventory rejects acquisition before device setup', async () => {
  const session = { authenticated: true, api: { hasValidSession: () => true,
    getDevsListDecrypted: async () => { session.authenticated = false; return { devices: [] }; } } };
  await assert.rejects(new LocalRecordings(session).connect('camera'), /请先登录/);
});
