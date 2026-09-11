# 界面

已迁移原项目的本地登录、设备列表、事件录像查询、下载与播放器页面。

```sh
node interface/server.cjs
```

默认打开 `http://127.0.0.1:3187/`。旧服务占用端口时，PowerShell 可运行：

```powershell
$env:EUFY_PORT = '3188'
node interface/server.cjs
```

服务只监听本机 `127.0.0.1`，请求的 Host 和提交时的 Origin 必须与实际端口一致。`createServer(options)` 只创建服务，不自动监听；调用 `.start()` 启动，`.close()` 关闭并清理录像连接。登录仍在进程内存中，重启需要重新登录。

这是迁移后的固定页面，还不是新的 Agent 界面。历史连续录像实验能力暂未接到此页面。未来固定页面与 Agent 界面复用同一组能力和组件。

| 目录 | 当前状态 | 归属 |
| --- | --- | --- |
| `pages/` | 已迁移 | 固定功能页面 |
| `components/` | 待实现 | 共享卡片、时间轴、播放器 |
| `agent/` | 待实现 | 对话入口、侧栏、工具调用状态 |
| `workspace/` | 待实现 | 动态结果组合、固定结果与布局恢复 |

当前请求协议见 [API 说明](../api/README.md)。
