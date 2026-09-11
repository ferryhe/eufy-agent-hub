const { MegaHTTPApi, ResponseErrorCode: Code } = require('../../adapters/eufy');

class LocalEufySession {
  constructor(createApi = options => new MegaHTTPApi(options)) {
    this.createApi = createApi;
    this.state = { phase: 'idle', message: '请使用加拿大（CA）地区登录你的 eufy 账号。', devices: [], diagnostics: [] };
    this.authenticated = false;
  }

  async login({ email, password, country }) {
    this.authenticated = false;
    this.credentials = { email: email.trim(), password };
    this.captchaId = undefined;
    this.state = { phase: 'busy', message: '正在登录 eufy…', country: country.trim().toUpperCase(), devices: [], diagnostics: [] };
    this.api = this.createApi({ ab: this.state.country.toLowerCase(), phoneModel: 'Local Eufy Client' });
    await this.api.init();
    await this.api.estimateDomain();
    await this.authenticate();
  }

  async verify(code) {
    const phase = this.state.phase;
    if (!this.credentials || !['tfa', 'captcha'].includes(phase)) throw new Error('请先登录，再输入验证码。');
    await this.authenticate(phase === 'tfa' ? code : undefined,
      phase === 'captcha' ? { captchaId: this.captchaId, answer: code } : undefined);
  }

  async authenticate(verifyCode, captcha) {
    this.state.phase = 'busy';
    this.state.message = '正在验证账号…';
    const result = await this.api.login(this.credentials.email, this.credentials.password, verifyCode, captcha);
    if (result.code === Code.CODE_NEED_VERIFY_CODE || result.code === Code.CODE_VERIFY_CODE_EXPIRED) {
      const sent = await this.api.sendVerifyCode();
      if (sent.code !== 0 && sent.code !== 200) throw new Error(`验证码发送失败（错误码 ${sent.code}），请稍后重新登录。`);
      this.state.phase = 'tfa';
      this.state.message = '验证码已发送，请输入最新收到的 eufy 邮件验证码。';
      return;
    }
    if (result.code === Code.CODE_VERIFY_CODE_ERROR || result.code === Code.CODE_VERIFY_CODE_NONE_MATCH) {
      this.state.phase = 'tfa';
      this.state.message = '验证码不正确，请重新输入最新收到的验证码。';
      return;
    }
    if (result.code === Code.LOGIN_NEED_CAPTCHA || result.code === Code.LOGIN_CAPTCHA_ERROR) {
      const challenge = await this.api.generateCaptcha();
      this.captchaId = challenge.captcha_id;
      this.state.captcha = challenge.item.startsWith('data:') ? challenge.item : `data:image/png;base64,${challenge.item}`;
      this.state.phase = 'captcha';
      this.state.message = '请输入图片中的验证码。';
      return;
    }
    if (result.code !== 0 || !this.api.hasValidSession()) {
      throw new Error(`未能完成登录（错误码 ${result.code}），请检查账号信息后重试。`);
    }
    this.authenticated = true;
    this.credentials = undefined;
    delete this.state.captcha;
    this.captchaId = undefined;
    await this.refresh();
  }

  async refresh() {
    if (!this.authenticated) throw new Error('请先完成登录。');
    if (!this.api.hasValidSession()) {
      this.authenticated = false;
      throw new Error('登录已过期，请重新登录。');
    }
    this.state.phase = 'connected';
    this.state.message = '账号已登录，正在读取设备…';
    this.state.diagnostics = [];
    try {
      const inventory = await this.api.getDevsListDecrypted();
      if (!inventory || !Array.isArray(inventory.devices)) throw new Error('设备列表格式与预期不符。');
      const devices = new Map();
      for (const raw of inventory.devices) {
        if (!raw || typeof raw.device_sn !== 'string' || !raw.device_sn) throw new Error('设备列表缺少设备标识。');
        devices.set(raw.device_sn, {
          serial: raw.device_sn,
          name: typeof raw.device_name === 'string' && raw.device_name ? raw.device_name : '未命名设备',
          model: typeof raw.device_model === 'string' ? raw.device_model : '未知型号',
        });
      }
      this.state.devices = [...devices.values()];
      this.state.message = devices.size
        ? `已登录（${this.state.country}），已从 eufy 新接口加载 ${devices.size} 台设备。`
        : `已登录（${this.state.country}），eufy 新接口返回了空设备列表。`;
      if (inventory.devices.length >= 100) this.state.diagnostics.push('设备数量达到本次请求上限，列表可能不完整。');
    } catch (error) {
      this.state.message = `账号已登录（${this.state.country}），但设备读取失败，可以重新读取设备。`;
      this.state.diagnostics = [error.message];
    }
  }

  fail(error) {
    this.state.phase = 'error';
    this.state.message = error instanceof Error ? error.message : '请求失败，请重试。';
  }
}

module.exports = { LocalEufySession };
