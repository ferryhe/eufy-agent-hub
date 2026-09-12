# eufy-agent-hub

[English](#english) | [中文](#中文)

## English

An eufy capability platform for agents: account access, device discovery, recording queries, and exports are organized into reusable modules, with a shared CLI/API and local Agent integration. Additional interfaces are planned.

**This release includes a resident recording API.** Account access, device listing and event-recording pages remain available. The [v1 API](api/v1.md) connects the supported continuous recording path to durable jobs, full media validation and explicit complete/partial/failed results. The [CLI](cli/README.md) uses that same resident API for authentication, devices, continuous recording jobs and artifact downloads. The [Recording Agent](agent/README.md) adds one local OpenAI Agents SDK runtime and structured HTTP tools; a [new real hardware record](agent/VALIDATION.md) produced a playable partial video with passed media validation and incomplete coverage. The [Agent sidebar](interface/agent/README.md) now shares device/timeline/player/job results with fixed browsing; [the dynamic workspace](interface/workspace/README.md) supports Agent composition, pinning, ordering and restoration from current API data.

### Available capabilities

| Directory | Contents | Status |
|---|---|---|
| [capabilities/auth](capabilities/auth) | Mega login, email/image verification, session state | Validated migration; sessions are in memory only |
| [capabilities/devices](capabilities/devices) | Device snapshots and refresh using the shared session | Thin wrapper migrated; capability matrix pending |
| [capabilities/recordings](capabilities/recordings) | Event queries, downloads, MP4 conversion, and decode validation | Validated migration; requires FFmpeg |
| Same directory: `continuous.cjs` / `mux.py` | Continuous ranges, playback by time, timestamped raw-frame capture | Experimental; short clip tested, long-clip completeness pending |
| [capabilities/live](capabilities/live) | Scoped live video and media ownership | v1 start/status/stop/media; offline tested, hardware acceptance pending |
| [api](api) | Resident v1 recording jobs and the original page protocol | Device/range/job/artifact contract; legacy page preserved |
| [interface](interface) | Fixed login, device, event-recording, and player page | Runnable fixed browsing, Agent sidebar and persistent dynamic workspace |
| [jobs](jobs) | Durable job identity, state, per-HomeBase queue, and output ownership | Phase A module with offline tests; service/recording integration and Phase B recovery pending |
| [cli](cli) | HTTP command-line client for the resident service | Runnable auth, devices, ranges/exports, jobs and artifacts |
| [agent](agent) | Single SDK Agent with structured resident HTTP tools | New real model-to-hardware run recorded; playable partial, incomplete coverage |
| [adapters/eufy](adapters/eufy) | Shared entry point to the protocol library | Builds independently |

“Validated migration” means the prototype performed real operations on the current account or device and passed offline regression tests after migration. It does not mean every device model has been validated.
The practical scope is a **CA account and HomeBase 3 (T8030) cameras on the same LAN**. The page uses **America/Toronto** time. Short-clip continuous-playback evidence comes from a T8600.

### Quick start

Install Node.js **24 or later** and npm, then run from the repository root:

```sh
npm ci
npm run setup
npm run build
npm test
npm start
```

Open **http://127.0.0.1:3187/** and sign in on the page. Account sessions are not migrated with the source and must be re-established after a service restart.
The interface follows the browser's preferred language (English or Simplified Chinese, with English fallback). A language selector remembers manual overrides. Recording queries still use `America/Toronto`; see the [interface localization contract](interface/i18n/README.md).
API callers may supply an IANA `timezone`; omitted values use `EUFY_RECORDING_TIMEZONE` or `America/Toronto`. The fixed page explicitly keeps Toronto time. See the [recording time-window contract](docs/recording-time-window.md) for DST handling, persisted export context and actual-coverage limits.
`setup` installs the protocol library's locked dependencies. `build` compiles its source and copies required assets; capability scripts load the result through the adapter.

If the old project still occupies port 3187, select another port in PowerShell:

```powershell
$env:EUFY_PORT = '3188'
npm start
```

Then open `http://127.0.0.1:3188/`. The service listens on loopback only; its HTTP factory also supports ephemeral ports for tests.

#### Command-line client

In another terminal, use the same running service:

```sh
node cli/eufy.cjs help
node cli/eufy.cjs auth login
node cli/eufy.cjs --json devices list
```

Install the executable with `npm install --global .`, then use `eufy`. Select another resident with `--url http://127.0.0.1:3188`. Export returns `job.jobId` immediately; `jobs get`, `jobs wait` and `artifacts list/get` follow that durable job. JSON results preserve the shared API's time, capability and completeness fields. See the [CLI command and exit-code guide](cli/README.md) for login challenges and the full recording workflow.

#### Video dependencies

Event export requires **FFmpeg**. Add it to `PATH` or specify its executable:

```powershell
$env:EUFY_FFMPEG = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
npm start
```

Login and device queries work without FFmpeg; exporting reports a configuration error if it is unavailable.
Only the experimental continuous-recording muxer requires Python/PyAV:

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

Continuous export is available through the resident API and CLI; the fixed page has no continuous-export button. See [continuous playback](capabilities/recordings/CONTINUOUS_PLAYBACK.md) for examples, observed messages, and limitations.

### Layout and target architecture

```text
capabilities/                Reusable business capabilities
  auth/  devices/  recordings/  live/
adapters/eufy/               Mega/P2P protocol entry point
api/                        Resident recording v1 API and legacy page HTTP
cli/                        HTTP client for the resident v1 service
jobs/                       Phase A durable job execution and state contract
agent/                      Recording tools and single SDK Agent runtime
interface/
  pages/                    Fixed feature pages
  components/               Shared device/job cards, players, and timelines
  agent/                    Resident conversation adapter and sidebar
  workspace/                Registered result composition, pinning, and restoration
vendor/eufy-security-client/ Protocol source with required local patches
docs/                       Architecture, migration mapping, and work items
output/                     Runtime exports; excluded from Git
```

Target flow: **interface / agent / CLI → shared API → persistent job service → capabilities → eufy**.
The service executes long-running exports. The agent interprets requests, selects tools, follows jobs, and presents actual results. Fixed pages and Agent mode share registered components and operations, with reference-based views composed in the main workspace.

The current fixed page queries event indexes only: **no events does not mean no continuous footage**. Continuous playback has been independently exercised, but receiving an end frame does not prove gap-free coverage.
Natural-language export is available through the local [Agent entry](agent/README.md), separately from the fixed page. Continuous monitoring and video-content recognition are not implemented.

### Tracked follow-up work

| Module | GitHub Issues |
|---|---|
| jobs | [#1 Persistent jobs, queuing, cancellation, and retries](https://github.com/ferryhe/eufy-agent-hub/issues/1) |
| api | [#2 Persistent service and v1 API](https://github.com/ferryhe/eufy-agent-hub/issues/2) |
| auth | [#3 Session lifecycle and recovery](https://github.com/ferryhe/eufy-agent-hub/issues/3) |
| devices | [#4 Device associations and capability matrix](https://github.com/ferryhe/eufy-agent-hub/issues/4), [#5 Pagination completeness](https://github.com/ferryhe/eufy-agent-hub/issues/5) |
| recordings | [#6 Continuous 20-minute acceptance test](https://github.com/ferryhe/eufy-agent-hub/issues/6), [#7 Complete export jobs](https://github.com/ferryhe/eufy-agent-hub/issues/7), [#8 Timezone contract](https://github.com/ferryhe/eufy-agent-hub/issues/8), [#9 Pause/resume/speed](https://github.com/ferryhe/eufy-agent-hub/issues/9) |
| live | [#10 Live video and connection lifecycle](https://github.com/ferryhe/eufy-agent-hub/issues/10) |
| cli | [#11 Command-line client](https://github.com/ferryhe/eufy-agent-hub/issues/11) |
| agent | [#12 Tool integration and natural-language export](https://github.com/ferryhe/eufy-agent-hub/issues/12) |
| interface | [#13 Fixed pages and agent sidebar](https://github.com/ferryhe/eufy-agent-hub/issues/13), [#14 Dynamic workspace](https://github.com/ferryhe/eufy-agent-hub/issues/14) |

Each item records evidence, gaps, acceptance criteria, and dependencies. Start with the job contract and v1 API while validating long continuous clips, then add agent integration before expanding the two interface modes.

### Development and validation

Documentation convention: this root README is bilingual (English and Chinese); all other project documentation, including module READMEs, is written in English.

Tests live alongside capabilities, API, CLI, interface, and jobs code. Job tests cover durable identity, queuing, validation gates, and execution after a separate submitting client exits. `npm test` does not require a real account or HomeBase. It covers login challenges, device-discovery failures, query limits, download-completion confirmation, continuous frame timestamps, HTTP Range, and service ports.
Migration also received independent review, an offline build with an empty npm cache, and synthetic-video export/full-decode checks. Automated tests do not establish new long-clip hardware acceptance.

- [Architecture and script migration mapping](docs/ARCHITECTURE.md)
- [Current HTTP API](api/README.md)
- [Event and continuous recording capabilities](capabilities/recordings/README.md)
- [Protocol source provenance and local changes](vendor/eufy-security-client/PROVENANCE.md)

Runtime state, account sessions, private footage, and debugging tools were not migrated from the old directory. The original project remains available; this repository builds and runs without depending on it.

### Credits and license

Based on the MIT-licensed protocol source from [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client). A source snapshot with explicit provenance temporarily retains unpublished local patches, including historical playback; the adapter can later switch to a separate protocol package.
Upstream has announced retirement of legacy cloud APIs and migration toward Mega, so its full feature list is not automatically supported by this hub.

This project uses the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is a community project and is not affiliated with eufy or Anker.

---

## 中文

面向 Agent 的 eufy 能力平台：把登录、设备发现、录像查询与导出封装成独立能力，提供统一 CLI/API 和本地 Agent；更多界面待实现。

**当前版本已提供常驻录像 API。** 登录、设备列表与事件录像页面继续可用。[v1 API](api/v1.md) 将已支持的连续录像路径接入持久化任务和完整媒体校验，明确区分完整、部分与失败结果。[CLI](cli/README.md) 已通过同一常驻 API 提供登录、设备、连续录像任务和产物下载。[录像 Agent](agent/README.md) 已加入本地单 Agent SDK 运行时和结构化 HTTP 工具；[新的实机记录](agent/VALIDATION.md) 已产出可播放的 partial 视频，媒体校验通过，但录像覆盖不完整。[Agent 侧栏](interface/agent/README.md) 已与固定浏览共用设备、时间轴、播放器和任务结果；[动态工作区](interface/workspace/README.md) 已支持 Agent 组合、固定、排序和从当前 API 数据恢复。

### 目前可以做什么

| 目录 | 当前内容 | 状态 |
|---|---|---|
| [capabilities/auth](capabilities/auth) | Mega 登录、邮件/图片验证码、会话状态 | 已验证迁入；会话仅在内存 |
| [capabilities/devices](capabilities/devices) | 设备列表快照与刷新，复用登录会话 | 已迁入薄封装；能力矩阵待补 |
| [capabilities/recordings](capabilities/recordings) | 事件查询、下载、MP4 转换及解码验证 | 已验证迁入；依赖 FFmpeg |
| 同上 `continuous.cjs` / `mux.py` | 连续时段查询、按时间回放、带时间戳的原始帧捕获 | 实验性；短片实测，长片完整性待验收 |
| [capabilities/live](capabilities/live) | 实时视频会话与媒体归属 | v1 启动/状态/停止/媒体接口；离线测试完成，实机验证待完成 |
| [api](api) | 常驻 v1 录像任务与原页面协议 | 设备/范围/任务/产物契约；保留旧页面 |
| [interface](interface) | 固定登录、设备、事件录像和播放器页面 | 固定浏览、Agent 侧栏和可恢复动态工作区可运行 |
| [jobs](jobs) | 持久化任务标识、状态、HomeBase 排队与独立产物目录 | Phase A 模块已通过离线测试；服务和录像接入、Phase B 恢复能力待完成 |
| [cli](cli) | 常驻服务的 HTTP 命令行客户端 | 可运行登录、设备、录像范围/导出、任务与产物命令 |
| [agent](agent) | 单 Agent SDK 与常驻 HTTP 结构化工具 | 已记录新的真实模型到实机流程；视频可播放，结果为覆盖不完整的 partial |
| [adapters/eufy](adapters/eufy) | 业务能力访问协议库的统一入口 | 可独立构建 |

“已验证迁入”指原型在当前账号或设备上完成过实际操作，迁移后通过离线回归测试，不表示所有型号都已验证。
当前实际使用范围为 **CA 账号、同一局域网的 HomeBase 3（T8030）及其摄像头**；页面时间使用 **America/Toronto**。连续回放短片证据来自 T8600。

### 快速开始

需要 Node.js **24 或以上**和 npm。在本仓库根目录执行：

```sh
npm ci
npm run setup
npm run build
npm test
npm start
```

打开 **http://127.0.0.1:3187/**，在页面中登录。账号会话不随源码迁移，服务重启后需要重新登录。
界面默认跟随浏览器语言，支持英文和简体中文，其他语言回退到英文；可手动切换并记住选择。录像查询仍使用 `America/Toronto`，详见 [界面多语言约定](interface/i18n/README.md)。
API 调用方可明确提供 IANA `timezone`；省略时使用 `EUFY_RECORDING_TIMEZONE`，未配置则使用 `America/Toronto`。固定页面仍明确使用 Toronto 时间。夏令时处理、导出时间上下文与实际覆盖范围的区别见 [录像时间窗口约定](docs/recording-time-window.md)。
`setup` 根据协议库锁文件安装依赖；`build` 编译协议源码并复制必要资源，业务脚本通过适配器加载构建结果。

若旧项目仍占用 3187，可在 PowerShell 中选择另一个端口：

```powershell
$env:EUFY_PORT = '3188'
npm start
```

此时打开 `http://127.0.0.1:3188/`。服务默认仅监听本机，HTTP 工厂也支持随机端口供测试使用。

#### 命令行客户端

在另一个终端使用同一个正在运行的服务：

```sh
node cli/eufy.cjs help
node cli/eufy.cjs auth login
node cli/eufy.cjs --json devices list
```

执行 `npm install --global .` 安装后可直接使用 `eufy`。用 `--url http://127.0.0.1:3188` 选择其他常驻服务。导出立即返回 `job.jobId`，再用 `jobs get`、`jobs wait` 和 `artifacts list/get` 查看任务和下载产物。JSON 结果保留统一 API 的时间、能力和完整性字段。登录挑战、完整录像流程及退出码见 [CLI 使用说明](cli/README.md)。

#### 视频依赖

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

连续导出已可通过常驻 API 和 CLI 调用，固定页面暂无连续导出按钮；调用示例、真实报文及限制见 [连续回放说明](capabilities/recordings/CONTINUOUS_PLAYBACK.md)。

### 目录与目标架构

```text
capabilities/               按功能封装，可复用的业务能力
  auth/  devices/  recordings/  live/
adapters/eufy/              Mega/P2P 协议入口
api/                       常驻录像 v1 API 与旧页面 HTTP
cli/                       常驻 v1 服务的 HTTP 客户端
jobs/                      Phase A 持久化任务执行与状态契约
agent/                     录像工具与单 Agent SDK 运行时
interface/
  pages/                   固定功能页面
  components/              共享设备/任务卡片、播放器、时间轴
  agent/                   常驻对话接口与侧栏
  workspace/               注册组件结果组合、固定与恢复
vendor/eufy-security-client/ 带必要本地补丁的协议源码
docs/                      架构、迁移清单与工作项
output/                    运行时导出文件，不提交 Git
```

目标调用关系：**界面 / Agent / CLI → 统一 API → 常驻任务服务 → 能力模块 → eufy**。
长时录像提取由服务执行；Agent 负责理解需求、选择工具、跟进任务和展示真实结果。固定页面与 Agent 模式共用组件，播放器和任务卡可以在主区域组合呈现。

当前固定页面只查询事件索引，**没有事件不等于没有连续录像**；连续回放已取得独立调用证据，但不能把收到结束帧等同于整段无丢失。
自然语言导出可通过本地 [Agent 入口](agent/README.md) 或固定页面的 [Agent 侧栏](interface/agent/README.md) 使用。持续监控和视频内容识别功能仍未实现。

### 已建立的后续工作

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

每项包含已有证据、缺口、验收条件和依赖。建议先推进任务契约与 v1 API，同时完成连续长片验证，再接 Agent，最后完善两种交互界面。

### 开发与验证

文档约定：根 README 使用中英文双语；其他项目文档（包括模块 README）统一使用英文。

测试与能力、API、CLI、界面、任务代码放在同一目录。任务测试覆盖持久化标识、排队、校验门槛，以及独立提交客户端退出后继续执行。`npm test` 不需要真实账号或 HomeBase；覆盖登录挑战、设备发现失败、查询分页限制、下载完成确认、连续帧时间、HTTP Range 和服务端口。
本次迁移还做了独立审查、空 npm 缓存下的离线构建，以及使用合成视频的导出/完整解码检查。没有通过自动测试声称完成新的实机长片验收。

- [架构与逐脚本迁移清单](docs/ARCHITECTURE.md)
- [当前 HTTP 接口](api/README.md)
- [事件与连续录像能力](capabilities/recordings/README.md)
- [协议源码来源与本地改动](vendor/eufy-security-client/PROVENANCE.md)

旧目录中的运行状态、账号会话、私人录像及诊断工具未迁入本仓库。原项目继续保留；新仓库构建和运行不依赖旧目录。

### 来源与许可证

基于 [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client) 的 MIT 协议源码。暂时使用带明确来源的源码快照，保留历史回放等尚未发布的本地补丁；后续可通过 adapter 替换为独立协议包。
上游已公告旧云 API 退役及向 Mega 迁移，因此上游列出的所有功能不自动视为本项目可用能力。

本项目采用 [MIT License](LICENSE)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这是社区项目，与 eufy/Anker 官方没有隶属关系。
