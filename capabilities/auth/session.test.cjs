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

test('session and capability entry points expose unknown completeness even for short and capped inventories', async () => {
  const { getDevices, refreshDevices } = require('../devices/index.cjs');
  const { session, api } = harness();
  assert.equal(session.state.discovery.status, 'not_requested');
  await session.login(credentials);
  assert.equal(session.state.discovery.completeness, 'unknown');
  assert.equal(session.state.discovery.status, 'succeeded');
  api.getDevsListDecrypted = async () => ({ devices: Array.from({ length: 100 }, (_, i) => ({
    device_sn: `fixture-${i % 99}`, device_model: 'FUTURE_MODEL',
  })) });
  const result = await refreshDevices(session);
  assert.equal(result.devices.length, 99);
  assert.equal(result.devices[98].model, 'FUTURE_MODEL');
  assert.equal(result.discovery.completeness, 'unknown');
  assert.equal(result.discovery.limitReached, true);
  assert.equal(result.discovery.receivedCount, 100);
  assert.equal(result.discovery.uniqueCount, 99);
  result.discovery.reasons.push('mutated');
  assert.ok(!getDevices(session).discovery.reasons.includes('mutated'));
  api.getDevsListDecrypted = async () => ({ devices: [] });
  await session.refresh();
  assert.equal(session.state.discovery.completeness, 'unknown');
  assert.equal(session.state.discovery.uniqueCount, 0);
  session.logout();
  assert.equal(session.state.discovery.status, 'not_requested');
});

test('failed session refresh marks retained devices stale and incomplete until a successful retry', async () => {
  const { session, api } = harness();
  await session.login(credentials);
  api.getDevsListDecrypted = async () => { throw new Error('offline inventory failure'); };
  await session.refresh();
  assert.equal(session.state.devices.length, 2);
  assert.equal(session.state.discovery.status, 'failed');
  assert.equal(session.state.discovery.completeness, 'incomplete');
  assert.equal(session.state.discovery.failedPage, 1);
  assert.equal(session.state.discovery.retryable, true);
  assert.equal(session.state.discovery.stale, true);
  assert.equal(session.state.discovery.uniqueCount, 0);
  api.getDevsListDecrypted = async () => ({ devices: [{ device_sn: 'new' }] });
  await session.refresh();
  assert.equal(session.state.discovery.status, 'succeeded');
  assert.equal(session.state.discovery.completeness, 'unknown');
  assert.equal(session.state.discovery.stale, false);
  assert.equal(session.state.discovery.retryable, false);
  assert.equal(session.state.discovery.failedPage, null);
  api.hasValidSession = () => false;
  session.isAuthenticated();
  assert.equal(session.state.discovery.status, 'not_requested');
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

test('auth localization metadata follows verification and preserves legacy text', async () => {
  const { session, api } = harness([26052, 26050, 0]);
  assert.equal(session.state.messageI18n.key, 'service.auth.idle');
  await session.login(credentials);
  assert.equal(session.state.message, '验证码已发送，请输入最新收到的 eufy 邮件验证码。');
  assert.equal(session.state.messageI18n.key, 'service.auth.codeSent');
  await session.verify('wrong');
  assert.equal(session.state.messageI18n.key, 'service.auth.codeIncorrect');
  await session.verify('123456');
  assert.deepEqual(session.state.messageI18n, { key: 'service.devices.loaded', params: { country: 'CA', count: 2 } });
  api.hasValidSession = () => false;
  await assert.rejects(session.refresh(), error => {
    assert.equal(error.message, '登录已过期，请重新登录。');
    assert.equal(error.i18n.key, 'service.auth.expired');
    session.fail(error);
    return true;
  });
  assert.equal(session.state.messageI18n.key, 'service.auth.expired');
  session.fail(new Error('upstream-specific failure'));
  assert.equal(session.state.message, 'upstream-specific failure');
  assert.equal(Object.hasOwn(session.state, 'messageI18n'), false);
});

test('diagnostics metadata remains aligned and clears after retry without translating upstream data', async () => {
  const { session, api } = harness();
  api.getDevsListDecrypted = async () => ({ unexpected: [] });
  await session.login(credentials);
  assert.equal(session.state.diagnosticsI18n[0].key, 'service.devices.invalidInventory');
  api.getDevsListDecrypted = async () => { throw new Error('upstream error 4404'); };
  await session.refresh();
  assert.deepEqual(session.state.diagnostics, ['upstream error 4404']);
  assert.deepEqual(session.state.diagnosticsI18n, [null]);
  api.getDevsListDecrypted = async () => ({ devices: [
    { device_sn: 'MISSING' },
    { device_sn: 'NAMED', device_name: '未命名设备', device_model: '未知型号' },
  ] });
  await session.refresh();
  assert.deepEqual(session.state.diagnosticsI18n, []);
  const [fallback, actual] = session.state.devices;
  assert.equal(fallback.name, '未命名设备');
  assert.equal(fallback.nameI18n.key, 'service.devices.unnamed');
  assert.equal(fallback.modelI18n.key, 'service.devices.unknownModel');
  assert.equal(actual.name, '未命名设备');
  assert.equal(actual.nameI18n, undefined);
  assert.equal(actual.modelI18n, undefined);
});

test('upstream login error codes are preserved in localization parameters', async () => {
  const { session } = harness([1234]);
  await assert.rejects(session.login(credentials), error => {
    assert.match(error.message, /1234/);
    assert.deepEqual(error.i18n, { key: 'service.auth.loginFailed', params: { code: 1234 } });
    return true;
  });
});
