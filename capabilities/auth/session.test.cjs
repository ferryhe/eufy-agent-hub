const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LocalEufySession } = require('./session.cjs');

const credentials = { email: 'test@example.invalid', password: 'test-only-password', country: 'CA' };
function harness(results = [0]) {
  let valid = false;
  const calls = [];
  const api = {
    init: async () => {}, estimateDomain: async () => {},
    login: async (...args) => {
      calls.push(args);
      const code = results.shift();
      valid = code === 0;
      return { code };
    },
    hasValidSession: () => valid,
    sendVerifyCode: async () => ({ code: 0 }),
    generateCaptcha: async () => ({ captcha_id: 'test-image', item: 'aW1hZ2U=' }),
    getDevsListDecrypted: async () => ({ devices: [
      { device_sn: 'TEST_BASE', device_name: 'HomeBase', device_model: 'T8030', secret: 'do-not-expose' },
      { device_sn: 'TEST_CAMERA', device_name: 'Camera', device_model: 'UNKNOWN_MODEL' },
    ] }),
  };
  const session = new LocalEufySession(options => { assert.equal(options.ab, 'ca'); return api; });
  return { session, api, calls };
}

test('Mega-only login shows stations and unknown camera models without exposing raw fields', async () => {
  const { session } = harness();
  await session.login(credentials);
  assert.equal(session.state.phase, 'connected');
  assert.equal(session.state.devices.length, 2);
  assert.equal(session.state.devices[1].model, 'UNKNOWN_MODEL');
  assert.equal(session.credentials, undefined);
  assert.ok(!JSON.stringify(session.state).includes('do-not-expose'));
  assert.ok(!JSON.stringify(session.state).includes(credentials.password));
});

test('incorrect 2FA can be corrected on the same Mega session', async () => {
  const { session, calls } = harness([26052, 26050, 0]);
  await session.login(credentials);
  assert.equal(session.state.phase, 'tfa');
  await session.verify('wrong');
  assert.equal(session.state.phase, 'tfa');
  assert.equal(session.authenticated, false);
  await session.verify('123456');
  assert.equal(session.state.phase, 'connected');
  assert.equal(calls[2][2], '123456');
  assert.equal(calls.length, 3);
});

test('picture captcha then email 2FA complete without a second backend login', async () => {
  const { session, calls } = harness([100032, 26052, 0]);
  await session.login(credentials);
  assert.equal(session.state.phase, 'captcha');
  await session.verify('abcd');
  assert.deepEqual(calls[1][3], { captchaId: 'test-image', answer: 'abcd' });
  assert.equal(session.state.phase, 'tfa');
  await session.verify('123456');
  assert.equal(session.state.phase, 'connected');
  assert.equal(session.state.captcha, undefined);
});

test('inventory failure preserves login and devices, and can be retried', async () => {
  const { session, api, calls } = harness();
  await session.login(credentials);
  api.getDevsListDecrypted = async () => { throw new Error('get_devs_list failed: 4404'); };
  await session.refresh();
  assert.equal(session.state.phase, 'connected');
  assert.equal(session.authenticated, true);
  assert.equal(session.state.devices.length, 2);
  assert.match(session.state.diagnostics[0], /4404/);
  api.getDevsListDecrypted = async () => ({ devices: [{ device_sn: 'TEST_NEW', device_name: 'New camera' }] });
  await session.refresh();
  assert.equal(session.state.devices.length, 1);
  assert.equal(session.state.devices[0].name, 'New camera');
  assert.deepEqual(session.state.diagnostics, []);
  assert.equal(calls.length, 1);
});

test('invalid inventory is reported instead of claiming no devices', async () => {
  const { session, api } = harness();
  api.getDevsListDecrypted = async () => ({ unexpected: [] });
  await session.login(credentials);
  assert.equal(session.state.phase, 'connected');
  assert.equal(session.state.diagnostics.length, 1);
  assert.match(session.state.message, /读取失败/);
});

test('expired sessions require login before making another inventory call', async () => {
  const { session, api } = harness();
  await session.login(credentials);
  api.hasValidSession = () => false;
  await assert.rejects(session.refresh(), /登录已过期/);
  assert.equal(session.authenticated, false);
});
