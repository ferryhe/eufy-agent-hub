# 架构与迁移边界

```text
interface（固定页面 / Agent 侧栏 / 动态工作区）
                ↓
agent 工具 → 版本化 API ← cli
                ↓
         常驻服务 + jobs
                ↓
      capabilities/auth, devices, recordings, live
                ↓
          adapters/eufy
                ↓
      Mega 云接口 + HomeBase P2P
```

上图是目标结构。当前可运行路径是 `interface/server.cjs` → legacy API → auth/recordings 能力 → eufy adapter。
CLI、v1 API、jobs、agent 和动态界面仍由 Issues 跟踪；目录存在不代表功能已经实现。

业务能力与界面分离。CLI 和 agent 未来调用统一 API；常驻服务持有会话和媒体连接，执行长时任务。Agent 只编排有结构化参数与结果的工具。

界面采用固定页面与 Agent 入口共存：普通查询可以在侧栏反馈，播放器、时间轴、多摄像头结果和导出任务可在主区域组合展示。通过已定义组件呈现数据，不让模型临时生成任意界面代码。组件的状态来自实际 API 和任务结果。

## 迁移分类

- **已验证迁入**：原型在当前账号/设备完成过实际操作，并有离线回归测试。不是所有型号的生产级承诺。
- **实验性迁入**：代码和部分实机证据已有，但完整流程或异常场景未完成验收。
- **待实现**：仅建立目录与工作项，没有伪造 CLI 命令、API 路由或 agent 能力。

旧项目源码、运行服务和录像留在原目录。新仓库不提交账号、会话、样片、抓包、Android 安装包、模拟器或调试输出。
协议库采用带本地必要改动的 MIT 源码快照，从锁文件独立安装构建；未来可通过 adapter 换成独立维护的协议包。

## 原脚本到目标目录

| 原脚本 | 新位置 |
|---|---|
| local-eufy-session.cjs / 测试 | capabilities/auth/session.cjs / session.test.cjs |
| 会话中的设备列表与刷新 | capabilities/devices/index.cjs（薄封装，继续复用 session） |
| local-recordings.cjs | capabilities/recordings/events.cjs |
| local-recording-export.cjs | capabilities/recordings/export.cjs |
| local-continuous-recordings.cjs | capabilities/recordings/continuous.cjs |
| mux-continuous-recording.py | capabilities/recordings/mux.py |
| local-recording-routes.cjs | api/legacy-recording-routes.cjs |
| local-login.cjs | interface/server.cjs |
| local-login.html | interface/pages/local-login.html |
| 连续录像协议本地补丁 | vendor/eufy-security-client/src/p2p/ 与 adapters/eufy |

协议库自身的 release/changelog 脚本不属于应用能力，没有迁成 hub 的发布流程。
