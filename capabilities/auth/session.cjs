const { MegaHTTPApi, ResponseErrorCode: Code } = require('../../adapters/eufy');
const { supportsEventRecordings } = require('../devices/recording-support.cjs');
const { initialDiscovery, readDeviceInventory } = require('../devices/discovery.cjs');
const { messageI18n, serviceError, setMessage } = require('../../api/messages.cjs');
const fs = require('node:fs');
const path = require('node:path');

// Also supports embedded callers which supply a small session adapter.
function isAuthenticated(session) {
  return session.isAuthenticated ? session.isAuthenticated()
    : Boolean(session.authenticated && session.api?.hasValidSession?.() !== false);
}

class LocalEufySession {
  constructor(createApi = options => new MegaHTTPApi(options), { sessionPath } = {}) {
    this.createApi = createApi;
    this.sessionPath = sessionPath;
    this.state = { phase: 'idle', message: '请使用加拿大（CA）地区登录你的 eufy 账号。', devices: [], discovery: initialDiscovery(), diagnostics: [] };
    this.state.messageI18n = messageI18n('service.auth.idle');
    this.state.diagnosticsI18n = [];
    this.authenticated = false;
  }

  isAuthenticated() {
    const valid = Boolean(this.authenticated && this.api?.hasValidSession());
    if (this.authenticated && !valid) {
      this.state.phase = 'login_required';
      this.state.devices = [];
      this.state.discovery = initialDiscovery();
      setMessage(this.state, '登录已过期，请重新登录。', messageI18n('service.auth.expired'));
    }
    return valid;
  }

  async restore() {
    if (!this.sessionPath || !fs.existsSync(this.sessionPath)) return;
    this.state.phase = 'busy';
    try {
      const saved = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
      if (saved.version !== 1 || !/^[A-Z]{2}$/.test(saved.country)
        || !saved.session || typeof saved.session.cloud_token !== 'string'
        || !saved.session.user_id || !Number.isFinite(saved.session.cloud_token_expiration)) throw new Error('Invalid saved session');
      this.state.country = saved.country;
      this.api = this.createApi({ ab: saved.country.toLowerCase(), phoneModel: 'Local Eufy Client' });
      await this.api.init();
      this.api.restoreSession(saved.session);
      if (!this.api.hasValidSession()) throw new Error('Expired saved session');
      this.authenticated = true;
      // A token alone does not prove that a restored cloud session is usable.
      await this.refresh({ strict: true });
    } catch {
      this.logout('service.auth.restoreFailed');
    }
  }

  persist() {
    if (!this.sessionPath || !this.isAuthenticated()) return;
    const saved = { version: 1, country: this.state.country, session: this.api.exportSession() };
    fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
    fs.writeFileSync(`${this.sessionPath}.tmp`, JSON.stringify(saved), { mode: 0o600, flush: true });
    fs.renameSync(`${this.sessionPath}.tmp`, this.sessionPath);
  }

  logout(key = 'service.auth.loggedOut') {
    // Drop only the shared cloud login. Already-owned LAN captures keep their own identity.
    this.authenticated = false;
    this.api = undefined;
    this.credentials = undefined;
    this.captchaId = undefined;
    this.state = { phase: 'login_required', devices: [], discovery: initialDiscovery(), diagnostics: [], diagnosticsI18n: [] };
    setMessage(this.state, key === 'service.auth.restoreFailed'
      ? '无法恢复登录，请重新登录。' : '已登出，请重新登录。', messageI18n(key));
    if (this.sessionPath) {
      fs.rmSync(this.sessionPath, { force: true });
      fs.rmSync(`${this.sessionPath}.tmp`, { force: true });
    }
  }

  async login({ email, password, country }) {
    this.logout();
    this.credentials = { email: email.trim(), password };
    this.captchaId = undefined;
    this.state = { phase: 'busy', message: '正在登录 eufy…', country: country.trim().toUpperCase(), devices: [], discovery: initialDiscovery(), diagnostics: [] };
    this.state.messageI18n = messageI18n('service.auth.signingIn');
    this.state.diagnosticsI18n = [];
    this.api = this.createApi({ ab: this.state.country.toLowerCase(), phoneModel: 'Local Eufy Client' });
    await this.api.init();
    await this.api.estimateDomain();
    await this.authenticate();
  }

  async verify(code) {
    const phase = this.state.phase;
    if (!this.credentials || !['tfa', 'captcha'].includes(phase)) throw serviceError('请先登录，再输入验证码。', 'service.auth.loginBeforeCode');
    await this.authenticate(phase === 'tfa' ? code : undefined,
      phase === 'captcha' ? { captchaId: this.captchaId, answer: code } : undefined);
  }

  async authenticate(verifyCode, captcha) {
    this.state.phase = 'busy';
    setMessage(this.state, '正在验证账号…', messageI18n('service.auth.verifying'));
    const result = await this.api.login(this.credentials.email, this.credentials.password, verifyCode, captcha);
    if (result.code === Code.CODE_NEED_VERIFY_CODE || result.code === Code.CODE_VERIFY_CODE_EXPIRED) {
      const sent = await this.api.sendVerifyCode();
      if (sent.code !== 0 && sent.code !== 200) throw serviceError(`验证码发送失败（错误码 ${sent.code}），请稍后重新登录。`, 'service.auth.codeSendFailed', { code: sent.code });
      this.state.phase = 'tfa';
      setMessage(this.state, '验证码已发送，请输入最新收到的 eufy 邮件验证码。', messageI18n('service.auth.codeSent'));
      return;
    }
    if (result.code === Code.CODE_VERIFY_CODE_ERROR || result.code === Code.CODE_VERIFY_CODE_NONE_MATCH) {
      this.state.phase = 'tfa';
      setMessage(this.state, '验证码不正确，请重新输入最新收到的验证码。', messageI18n('service.auth.codeIncorrect'));
      return;
    }
    if (result.code === Code.LOGIN_NEED_CAPTCHA || result.code === Code.LOGIN_CAPTCHA_ERROR) {
      const challenge = await this.api.generateCaptcha();
      this.captchaId = challenge.captcha_id;
      this.state.captcha = challenge.item.startsWith('data:') ? challenge.item : `data:image/png;base64,${challenge.item}`;
      this.state.phase = 'captcha';
      setMessage(this.state, '请输入图片中的验证码。', messageI18n('service.auth.captchaRequired'));
      return;
    }
    if (result.code !== 0 || !this.api.hasValidSession()) {
      throw serviceError(`未能完成登录（错误码 ${result.code}），请检查账号信息后重试。`, 'service.auth.loginFailed', { code: result.code });
    }
    this.authenticated = true;
    this.credentials = undefined;
    delete this.state.captcha;
    this.captchaId = undefined;
    await this.refresh();
    this.persist();
  }

  async refresh({ strict = false } = {}) {
    if (!this.authenticated) throw serviceError('请先完成登录。', 'service.auth.completeLogin');
    if (!this.api.hasValidSession()) {
      this.isAuthenticated();
      this.authenticated = false;
      throw serviceError('登录已过期，请重新登录。', 'service.auth.expired');
    }
    this.state.phase = strict ? 'busy' : 'connected';
    setMessage(this.state, '账号已登录，正在读取设备…', messageI18n('service.devices.loading'));
    this.state.diagnostics = [];
    this.state.diagnosticsI18n = [];
    try {
      const inventory = await readDeviceInventory(this.api);
      if (!this.isAuthenticated()) throw serviceError('登录已过期，请重新登录。', 'service.auth.expired');
      this.state.discovery = inventory.discovery;
      if (inventory.error && !inventory.discovery.pagesRead) {
        this.state.discovery.stale = this.state.devices.length > 0;
        throw inventory.error;
      }
      const devices = new Map();
      for (const raw of inventory.devices) {
        devices.set(raw.device_sn, {
          serial: raw.device_sn,
          name: typeof raw.device_name === 'string' && raw.device_name ? raw.device_name : '未命名设备',
          model: typeof raw.device_model === 'string' ? raw.device_model : '未知型号',
          capabilities: { eventRecordings: supportsEventRecordings(raw, inventory.devices) },
          ...(!(typeof raw.device_name === 'string' && raw.device_name) ? { nameI18n: messageI18n('service.devices.unnamed') } : {}),
          ...(typeof raw.device_model !== 'string' ? { modelI18n: messageI18n('service.devices.unknownModel') } : {}),
        });
      }
      this.state.devices = [...devices.values()];
      if (inventory.error) throw inventory.error;
      this.state.phase = 'connected';
      setMessage(this.state, devices.size
        ? `已登录（${this.state.country}），已从 eufy 新接口加载 ${devices.size} 台设备。`
        : `已登录（${this.state.country}），eufy 新接口返回了空设备列表。`,
      messageI18n(devices.size ? 'service.devices.loaded' : 'service.devices.empty', { country: this.state.country, count: devices.size }));
      if (inventory.discovery.limitReached) {
        this.state.diagnostics.push('设备数量达到本次请求上限，列表可能不完整。');
        this.state.diagnosticsI18n.push(messageI18n('service.devices.limitReached'));
      }
    } catch (error) {
      if (strict || !this.isAuthenticated()) throw error;
      setMessage(this.state, `账号已登录（${this.state.country}），但设备读取失败，可以重新读取设备。`, messageI18n('service.devices.loadFailed', { country: this.state.country }));
      this.state.diagnostics = [error.message];
      this.state.diagnosticsI18n = [error.i18n || null];
    }
  }

  fail(error) {
    this.state.phase = error?.i18n?.key === 'service.auth.expired' ? 'login_required' : 'error';
    setMessage(this.state, error instanceof Error ? error.message : '请求失败，请重试。',
      error instanceof Error ? error.i18n : messageI18n('service.requestFailed'));
  }
}

module.exports = { LocalEufySession, isAuthenticated };
