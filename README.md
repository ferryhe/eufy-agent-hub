# eufy-agent-hub

面向 Agent 的 eufy 能力平台：把登录、设备发现、录像查询与导出封装成独立能力，逐步提供统一 CLI/API，再接入智能体和界面。

**当前版本是可运行的迁移基础。** 已迁入登录、设备列表、事件录像页面与相关能力；连续历史回放仍为实验性。CLI、v1 API、后台任务、Agent 和动态界面尚未实现，对应工作已建立 GitHub Issues。

## 目前可以做什么

| 目录 | 当前内容 | 状态 |
|---|---|---|
| [capabilities/auth](capabilities/auth) | Mega 登录、邮件/图片验证码、会话状态 | 已验证迁入；会话仅在内存 |
| [capabilities/devices](capabilities/devices) | 设备列表快照与刷新，复用登录会话 | 已迁入薄封装；能力矩阵待补 |
| [capabilities/recordings](capabilities/recordings) | 事件查询、下载、MP4 转换及解码验证 | 已验证迁入；依赖 FFmpeg |
| 同上 `continuous.cjs` / `mux.py` | 连续时段查询、按时间回放、带时间戳的原始帧捕获 | 实验性；短片实测，长片完整性待验收 |
| [capabilities/live](capabilities/live) | 实时视频能力归属 | 待封装、待实测 |
| [api](api) | 原页面的登录与事件录像 HTTP 协议 | 已迁入 legacy 协议；不是 v1 Agent API |
| [interface](interface) | 固定登录、设备、事件录像和播放器页面 | 可运行；Agent 侧栏和动态工作区待实现 |
| [cli](cli) / [jobs](jobs) / [agent](agent) | 命令行、任务服务、工具编排的模块边界 | 目录与说明已建立，暂无运行实现 |
| [adapters/eufy](adapters/eufy) | 业务能力访问协议库的统一入口 | 可独立构建 |

“已验证迁入”指原型在当前账号或设备上完成过实际操作，迁移后通过离线回归测试，不表示所有型号都已验证。
当前实际使用范围为 **CA 账号、同一局域网的 HomeBase 3（T8030）及其摄像头**；页面时间使用 **America/Toronto**。连续回放短片证据来自 T8600。

## 快速开始

需要 Node.js **24 或以上**和 npm。在本仓库根目录执行：

```sh
npm ci
npm run setup
npm run build
npm test
npm start
```

打开 **http://127.0.0.1:3187/**，在页面中登录。账号会话不随源码迁移，服务重启后需要重新登录。
`setup` 根据协议库锁文件安装依赖；`build` 编译协议源码并复制必要资源，业务脚本通过适配器加载构建结果。

若旧项目仍占用 3187，可在 PowerShell 中选择另一个端口：

```powershell
$env:EUFY_PORT = '3188'
npm start
```

此时打开 `http://127.0.0.1:3188/`。服务默认仅监听本机，HTTP 工厂也支持随机端口供测试使用。

### 视频依赖

事件导出需要 **FFmpeg**。将它加入 `PATH`，或配置可执行文件：

```powershell
$env:EUFY_FFMPEG = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
npm start
```

没有 FFmpeg 时登录和设备查询仍能运行，导出会返回配置提示。
只有实验性连续录像封装需要 Python/PyAV，安装方式为：

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

连续捕获目前通过能力模块调用，没有网页按钮或 CLI 命令；调用示例、真实报文及限制见 [连续回放说明](capabilities/recordings/CONTINUOUS_PLAYBACK.md)。

## 目录与目标架构

```text
capabilities/               按功能封装，可复用的业务能力
  auth/  devices/  recordings/  live/
adapters/eufy/              Mega/P2P 协议入口
api/                       当前 legacy HTTP；后续 v1 API
cli/                       后续命令行客户端
jobs/                      后续常驻任务执行与状态
agent/                     后续工具定义与智能体编排
interface/
  pages/                   固定功能页面
  components/              后续共享卡片、播放器、时间轴
  agent/                   后续对话与侧栏
  workspace/               后续动态结果组合、固定与恢复
vendor/eufy-security-client/ 带必要本地补丁的协议源码
docs/                      架构、迁移清单与工作项
output/                    运行时导出文件，不提交 Git
```

目标调用关系：**界面 / Agent / CLI → 统一 API → 常驻任务服务 → 能力模块 → eufy**。
长时录像提取由服务执行；Agent 负责理解需求、选择工具、跟进任务和展示真实结果。固定页面与 Agent 模式共用组件，播放器和任务卡可以在主区域组合呈现。

当前固定页面只查询事件索引，**没有事件不等于没有连续录像**；连续回放已取得独立调用证据，但不能把收到结束帧等同于整段无丢失。
目前没有持续监控、自然语言执行或视频内容识别功能。

## 已建立的后续工作

| 模块 | GitHub Issues |
|---|---|
| jobs | [#1 持久化任务、排队、取消与重试](https://github.com/ferryhe/eufy-agent-hub/issues/1) |
| api | [#2 常驻服务与 v1 协议](https://github.com/ferryhe/eufy-agent-hub/issues/2) |
| auth | [#3 会话生命周期与恢复](https://github.com/ferryhe/eufy-agent-hub/issues/3) |
| devices | [#4 设备关联与能力矩阵](https://github.com/ferryhe/eufy-agent-hub/issues/4)、[#5 分页完整性](https://github.com/ferryhe/eufy-agent-hub/issues/5) |
| recordings | [#6 连续 20 分钟验收](https://github.com/ferryhe/eufy-agent-hub/issues/6)、[#7 完整导出任务](https://github.com/ferryhe/eufy-agent-hub/issues/7)、[#8 时区契约](https://github.com/ferryhe/eufy-agent-hub/issues/8)、[#9 暂停/恢复/倍速](https://github.com/ferryhe/eufy-agent-hub/issues/9) |
| live | [#10 实时视频与连接生命周期](https://github.com/ferryhe/eufy-agent-hub/issues/10) |
| cli | [#11 命令行客户端](https://github.com/ferryhe/eufy-agent-hub/issues/11) |
| agent | [#12 工具接入与自然语言导出](https://github.com/ferryhe/eufy-agent-hub/issues/12) |
| interface | [#13 固定页面与 Agent 侧栏](https://github.com/ferryhe/eufy-agent-hub/issues/13)、[#14 动态工作区](https://github.com/ferryhe/eufy-agent-hub/issues/14) |

每项包含已有证据、缺口、验收条件和依赖。建议先推进任务契约与 v1 API，同时完成连续长片验证，再接 CLI 和 Agent，最后完善两种交互界面。

## 开发与验证

测试与能力、API、界面代码放在同一目录。`npm test` 不需要真实账号或 HomeBase；覆盖登录挑战、设备发现失败、查询分页限制、下载完成确认、连续帧时间、HTTP Range 和服务端口。
本次迁移还做了独立审查、空 npm 缓存下的离线构建，以及使用合成视频的导出/完整解码检查。没有通过自动测试声称完成新的实机长片验收。

- [架构与逐脚本迁移清单](docs/ARCHITECTURE.md)
- [当前 HTTP 接口](api/README.md)
- [事件与连续录像能力](capabilities/recordings/README.md)
- [协议源码来源与本地改动](vendor/eufy-security-client/PROVENANCE.md)

旧目录中的运行状态、账号会话、私人录像及诊断工具未迁入本仓库。原项目继续保留；新仓库构建和运行不依赖旧目录。

## 来源与许可证

基于 [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client) 的 MIT 协议源码。暂时使用带明确来源的源码快照，保留历史回放等尚未发布的本地补丁；后续可通过 adapter 替换为独立协议包。
上游已公告旧云 API 退役及向 Mega 迁移，因此上游列出的所有功能不自动视为本项目可用能力。

本项目采用 [MIT License](LICENSE)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这是社区项目，与 eufy/Anker 官方没有隶属关系。
