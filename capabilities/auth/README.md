# 账号与会话

从原项目 `scripts/local-eufy-session.cjs` 迁入 `session.cjs`。协议通过 `adapters/eufy` 接入，保留原有行为。

## 已有能力

- `LocalEufySession.login({ email, password, country })`：按地区选择 Mega 服务并登录。
- `verify(code)`：提交图片验证码或邮件验证码，依据当前会话阶段选择。
- `refresh()`：重新读取设备；设备查询失败保留登录和此前列表，并记录诊断。
- `state`：提供阶段、提示、设备摘要、诊断，以及需要验证时的验证码图片。
- `fail(error)`：由调用方把请求异常写入可展示状态；异步方法的异常仍需调用方捕获。

`phase` 包含 `idle`、`busy`、`captcha`、`tfa`、`connected`、`error`。`connected` 表示账号登录成功，设备读取是否成功还须检查 `diagnostics`。

## 成熟度与验证

这是已使用的本地单账号登录流程：源项目在当前用户 CA 账号完成过登录和设备读取。本次迁移不重新登录、不复制会话或凭证。其他地区和账号未在此次迁移实测。

保留 6 个离线测试，覆盖登录、验证码纠错、图片验证码后邮件验证、设备读取失败后重试、无效设备响应、会话过期。测试使用模拟服务，不能替代 eufy 在线验证。

```sh
node --test capabilities/auth/session.test.cjs
```

## 当前边界

会话只存在于进程内，重启需重新登录。未实现会话恢复、自动续期、登出入口、多账号隔离或同一账号的并发登录队列。收到过期提示后，由调用方引导重新登录。设备列表仍由 `session.refresh()` 读取，`capabilities/devices` 复用该实现。

后续范围见 [Issue 草案](../../docs/issues/auth-devices.md)。
