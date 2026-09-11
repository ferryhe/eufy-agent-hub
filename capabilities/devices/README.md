# 设备发现

设备发现的成熟实现来自 `LocalEufySession.refresh()`，通过 Mega 的设备列表接口读取。此目录提供轻量入口，不重复维护登录与协议逻辑。

```js
const { getDevices, refreshDevices } = require('./capabilities/devices/index.cjs');

const cached = getDevices(session);
const refreshed = await refreshDevices(session);
```

两个方法返回 `{ devices, diagnostics, message }`。设备仅包含 `serial`、`name`、`model`；同一序列号去重，未知型号仍保留。返回值为副本，调用方修改列表不会改变会话。

`getDevices` 返回缓存，不发请求。`refreshDevices` 要求已登录；设备请求失败时会返回此前列表和失败诊断。因此界面或 Agent 必须检查 `diagnostics`，不能把缓存当成刚刚刷新成功的数据。

## 成熟度与验证

CA 账号设备发现已在源项目实测。协议返回的未知型号可以列出，但这不代表相应设备可连接或受控。账号和设备发现原有行为由 [会话测试](../auth/session.test.cjs) 覆盖。

## 当前边界

- 当前摘要不包含设备在线状态、固件、所属 HomeBase 或通道。
- 尚无按型号和固件验证过的能力矩阵，不能向 Agent 声称任意型号支持回放、对讲或设置控制。
- 当前读取未分页；返回条数达到 100 时会提示列表可能不完整。
- 此目录未实现设备设置、布防、云台、灯光或门锁控制。

后续范围见 [Issue 草案](../../docs/issues/auth-devices.md)。
