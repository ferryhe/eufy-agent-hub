const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalEufySession } = require('./session.cjs');
const { MegaHTTPApi } = require('../../adapters/eufy');

const credentials = { email: 'test@example.invalid', password: 'never-persist-this', country: 'CA' };
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionPath = path.join(directory, 'session.json');
  const calls = { create: 0, init: 0, restore: 0, login: 0, inventory: 0 };
  const make = () => new LocalEufySession(settings => {
    calls.create++;
    // Exercise the actual bundled provider's export, restore and 60s validity margin.
    const api = new MegaHTTPApi(settings);
    api.init = async () => { calls.init++; };
    api.estimateDomain = async () => {};
    const restore = api.restoreSession.bind(api);
    api.restoreSession = saved => { calls.restore++; if (options.restoreThrows) throw new Error('restore failed'); restore(saved); };
    api.login = async () => {
      calls.login++;
      const code = options.codes?.shift() ?? 0;
      if (code === 0) restore({ cloud_token: 'fixture-token', user_id: 'fixture-user',
        cloud_token_expiration: Date.now() / 1000 + 3600, ab: 'ca', openudid: 'fixture-device',
        domains: { eufy_security: 'example.invalid' }, identities: {}, megaDomain: 'example.invalid' });
      return { code };
    };
    api.sendVerifyCode = async () => ({ code: 0 });
    api.generateCaptcha = async () => ({ captcha_id: 'fixture-challenge', item: 'image' });
    api.getDevsListDecrypted = async () => {
      calls.inventory++;
      if (options.inventoryFails) throw new Error('private upstream failure');
      return { devices: [{ device_sn: 'fixture-camera', device_name: 'Camera' }] };
    };
    return api;
  }, { sessionPath });
  return { sessionPath, calls, make };
}

test('completed login persists only provider material and a new instance restores without password or login replay', async t => {
  const f = fixture(t); const first = f.make(); await first.login(credentials);
  const source = fs.readFileSync(f.sessionPath, 'utf8');
  for (const secret of [credentials.email, credentials.password, 'credentials', 'captcha']) assert.ok(!source.includes(secret));
  const saved = JSON.parse(source);
  assert.equal(saved.session.cloud_token, 'fixture-token');
  assert.equal(saved.session.openudid, 'fixture-device');
  const second = f.make(); await second.restore();
  assert.notEqual(first.api, second.api);
  assert.equal(second.state.phase, 'connected'); assert.equal(second.isAuthenticated(), true);
  assert.equal(second.state.devices.length, 1);
  assert.deepEqual(f.calls, { create: 2, init: 2, restore: 1, login: 1, inventory: 2 });
});

test('expired, safety-margin, malformed and failed restoration require login without exposing cached inventory', async t => {
  for (const kind of ['expired', 'margin', 'malformed', 'missing-token', 'restore-failed', 'inventory-failed'])
    await t.test(kind, async t => {
      const settings = {};
      const f = fixture(t, settings); const original = f.make(); await original.login(credentials);
      const saved = JSON.parse(fs.readFileSync(f.sessionPath));
      if (kind === 'expired') saved.session.cloud_token_expiration = Date.now() / 1000 - 1;
      if (kind === 'margin') saved.session.cloud_token_expiration = Date.now() / 1000 + 30;
      if (kind === 'missing-token') delete saved.session.cloud_token;
      fs.writeFileSync(f.sessionPath, kind === 'malformed' ? '{' : JSON.stringify(saved));
      settings.restoreThrows = kind === 'restore-failed'; settings.inventoryFails = kind === 'inventory-failed';
      const session = f.make(); await session.restore();
      assert.equal(session.state.phase, 'login_required'); assert.equal(session.isAuthenticated(), false);
      assert.deepEqual(session.state.devices, []); assert.equal(session.api, undefined);
      assert.equal(session.state.messageI18n.key, 'service.auth.restoreFailed');
      assert.equal(fs.existsSync(f.sessionPath), false); assert.equal(f.calls.login, 1);
      assert.equal(f.calls.inventory, kind === 'inventory-failed' ? 2 : 1);
    });
});

test('captcha and email challenges remain on the same instance and are never persisted', async t => {
  const f = fixture(t, { codes: [100032, 26052, 26050, 0] }); const session = f.make();
  await session.login(credentials); const api = session.api;
  assert.equal(session.state.phase, 'captcha'); assert.equal(fs.existsSync(f.sessionPath), false);
  await session.verify('image-answer'); assert.equal(session.state.phase, 'tfa');
  assert.equal(fs.existsSync(f.sessionPath), false);
  await session.verify('wrong'); assert.equal(session.state.phase, 'tfa');
  await session.verify('123456'); assert.equal(session.api, api);
  assert.equal(session.state.phase, 'connected'); assert.equal(fs.existsSync(f.sessionPath), true);
});

test('logout removes shared and persisted login and challenge material; restart stays logged out', async t => {
  const f = fixture(t); const session = f.make(); await session.login(credentials);
  session.logout();
  assert.equal(session.authenticated, false); assert.equal(session.api, undefined);
  assert.equal(session.credentials, undefined); assert.equal(session.captchaId, undefined);
  assert.deepEqual(session.state.devices, []); assert.equal(fs.existsSync(f.sessionPath), false);
  const restarted = f.make(); await restarted.restore(); assert.equal(restarted.isAuthenticated(), false);
  const challenge = fixture(t, { codes: [100032] }).make(); await challenge.login(credentials); challenge.logout();
  assert.equal(challenge.state.captcha, undefined);
  await assert.rejects(challenge.verify('answer'), /请先登录/);
});

test('status marks expiry as login required and removes cached device availability', async t => {
  const f = fixture(t); const session = f.make(); await session.login(credentials);
  const api = session.api; api.hasValidSession = () => false;
  assert.equal(session.isAuthenticated(), false); assert.equal(session.state.phase, 'login_required');
  assert.deepEqual(session.state.devices, []); assert.equal(session.api, api);
});
