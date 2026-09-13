# eufy-agent-hub

[English](#english) | [中文](#中文)

## English

A local eufy recording application with reusable capabilities, a resident HTTP API, a CLI, and an optional recording Agent. The browser provides event-recording browsing, an Agent sidebar, shared result components and a persistent workspace, with English and Simplified Chinese interfaces.

**Phase 1 and Phase 2 delivery is merged through PR #32.** The original 15 issues (#1–#14 and #16) are closed as of 2026-09-13. Completion means their scoped acceptance criteria were met; it does not establish gap-free exports or support for every device. See [delivery history](#delivery-history) and [hardware evidence and limits](#hardware-evidence-and-limits).

### What is available, and where

| Capability | Current entry point | Boundary |
|---|---|---|
| Login, verification, logout and session restoration | Browser, CLI, v1 session API | One resident account; expired or invalid saved sessions require login |
| Device discovery and capability matrix | Browser inventory, CLI, v1 devices API | Camera/HomeBase/channel/firmware scope; discovery completeness remains unknown |
| Event search, download and saved MP4 playback | **Browse recordings**, legacy HTTP routes | An empty event index does not prove there is no continuous footage |
| Continuous recording ranges and export | CLI, v1 API, recording Agent | Durable jobs, conversion and full decode/coverage checks; results can be partial |
| Job recovery, cancellation and explicit retry | Resident job service; cancel/retry via v1 API | Interrupted capture is not resumed; no dedicated CLI cancel/retry commands or full browser task center |
| Historical playback pause/resume | v1 playback-session control API | Accepted public hardware evidence is for 1× pause/resume; no browser media URL or playback-control UI |
| Live video | v1 live-session API and MJPEG media URL | Video-only bounded preview; no dedicated Live page or CLI/Agent Live command |
| Natural-language export | **Ask assistant** sidebar or terminal Agent | Requires model configuration; ordinary browsing does not |
| Shared results and dynamic workspace | Both browser views | Device/timeline/job/player components; pin, reorder and restore references |

The fixed event-search form has no direct continuous-export control. The Agent can submit continuous exports, and a workspace timeline backed by an Agent range receipt has an export action. The public [v1 contract](api/v1.md) and [legacy page routes](api/README.md) are separate interfaces.

### Quick start

Install **Node.js 24 or later** and npm. From the repository root:

```sh
npm ci
npm run setup
npm run build
npm test
npm start
```

`setup` installs the bundled protocol library's locked dependencies; `build` compiles its source and copies assets. Automated tests do not need a real account/HomeBase; optional media tests depend on local tool configuration.

Open **http://127.0.0.1:3187/**. On first use, sign in with your eufy account region (the tested account uses `CA`) and complete any image/email challenge. Keep the resident service running while using the page, CLI or Agent. The service listens on `127.0.0.1` only and checks the actual Host and browser Origin.

Completed login sessions are saved to ignored `output/auth/session.json` by default and validated on restart. **A normal restart does not always require another login.** Expired, malformed or unusable saved sessions do. Passwords and pending challenges are not saved. **Sign out** clears the saved session. `EUFY_SESSION_PATH` selects a private durable session-file location; treat that file as a credential. See [session lifecycle](capabilities/auth/README.md).

If port 3187 is occupied, choose another port in PowerShell:

```powershell
$env:EUFY_PORT = '3188'
npm start
```

Then open `http://127.0.0.1:3188/`; CLI callers select it with `--url http://127.0.0.1:3188`. Do not run multiple resident processes against the same job/state directories.

#### Media dependencies

**FFmpeg** is required for event conversion/validation, continuous export and Live preview. Add it to `PATH` or set `EUFY_FFMPEG` to the executable. Continuous export also requires **Python with PyAV**:

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

For example, in PowerShell before starting the service:

```powershell
$env:EUFY_FFMPEG = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:EUFY_PYTHON = 'C:\Path\To\python.exe'
npm start
```

Replace these example paths with your installed executables. Login and device discovery work without media tools. Use the same Python executable for dependency installation and `EUFY_PYTHON`.

#### Browser workflow

1. Sign in, then choose **Browse recordings**. Select a camera, date and time interval to find event recordings, download a result and play the saved MP4.
2. To request a continuous interval, configure the Agent below and choose **Ask assistant**, or use the CLI/API. Specify the camera, calendar date, start/end and timezone; ambiguous requests require clarification.
3. Follow the shared job card and inspect the actual coverage and validation result. A playable `partial` output remains incomplete.
4. Pin useful workspace results and reorder them. Browser refresh restores references and observes existing resident work without another model call.

The interface follows browser language with English fallback and remembers manual English/Chinese selection. The fixed event form uses **America/Toronto**. API callers may provide an IANA `timezone`; otherwise the service uses `EUFY_RECORDING_TIMEZONE` or `America/Toronto`. DST gaps/ambiguous times and cross-midnight windows are rejected; split a cross-midnight request into supported windows. See [time-window semantics](docs/recording-time-window.md).

#### CLI workflow

Use another terminal with the resident already running. Replace `CAMERA_SERIAL`, the example date and returned IDs with your own inventory, retained footage and response values:

```sh
node cli/eufy.cjs auth status
node cli/eufy.cjs --json devices list
node cli/eufy.cjs --json recordings ranges CAMERA_SERIAL --day 2026-09-12 --start 16:30 --end 16:50 --timezone America/Toronto
node cli/eufy.cjs --json recordings export --request-id camera-20260912-1630-01 --serial CAMERA_SERIAL --day 2026-09-12 --start 16:30 --end 16:50 --timezone America/Toronto
node cli/eufy.cjs --json jobs get JOB_ID
node cli/eufy.cjs --json jobs wait JOB_ID
node cli/eufy.cjs --json artifacts list JOB_ID
node cli/eufy.cjs --json artifacts get JOB_ID ARTIFACT_ID --output recording.mp4
```

Export returns `job.jobId` after durable acceptance. Exiting the submitting client or timing out a wait does not stop resident work. Reusing the same request ID returns the original job, not a retry. A new intended execution needs a new request ID. `artifacts get` writes to the specified file, replacing it if present. Inspect the artifact's outcome, playable and validated fields; a successful file download does not prove complete coverage. `npm install --global .` exposes the same CLI as `eufy`. See [commands and exit codes](cli/README.md).

#### Optional recording Agent

Set `OPENAI_API_KEY` in the resident process environment for the browser sidebar; `EUFY_AGENT_MODEL` optionally selects the model (default `gpt-4.1-mini`). For an ignored `.env.local` file containing that configuration, start the browser service with:

```sh
node --env-file=.env.local interface/server.cjs
```

`npm start` does not automatically load `.env.local`. Run only one resident on the chosen port. The terminal Agent is a separate client of that service:

```sh
node --env-file=.env.local agent/main.cjs --url http://127.0.0.1:3187
```

Example request: “Export Drive Way on 2026-09-12 from 16:30 to 16:50, America/Toronto.” Substitute your camera and retained date. Enter account passwords and verification codes only in the normal login flow, not chat. Agent polling observes HTTP state without paid model calls. See [Agent setup](agent/README.md) and [sidebar behavior](interface/agent/README.md).

### Jobs, recovery and API-only controls

The resident owns exports independently of clients. Jobs on one HomeBase execute in FIFO order. Cancellation retains ownership until media/process cleanup finishes. Live and historical playback share resident media-admission guards and do not preempt ongoing recording work.

| Operation | v1 endpoint / behavior |
|---|---|
| Inspect a known job | `GET /api/v1/jobs/:jobId` |
| Cancel queued/running work | `POST /api/v1/jobs/:jobId/cancel` with `{}`; active cancellation completes after cleanup |
| Explicitly retry failed/cancelled work | `POST /api/v1/jobs/:jobId/retry` with `{"requestId":"NEW_UNIQUE_ID"}`; creates a new job and preserves the old one |
| Start Live | `POST /api/v1/live-sessions` with `{"requestId":"NEW_UNIQUE_ID","serial":"CAMERA_SERIAL","maxDurationMs":60000}` |
| Observe / view / stop Live | `GET /api/v1/live-sessions/:sessionId`, `GET /api/v1/live-sessions/:sessionId/media`, `POST /api/v1/live-sessions/:sessionId/stop` with `{}` |

POSTs use `Content-Type: application/json` and browser callers must use the resident's matching Origin. There is currently no public endpoint to list all jobs; retain returned job IDs.

On restart, safely queued jobs retain identity and order; execution still requires a valid session. Previously running capture becomes `failed` with `JOB_INTERRUPTED`, or `cancelled` if cancellation intent was saved. It is not automatically replayed or resumed. Inspect retained evidence and explicitly retry where appropriate. Existing job/artifact reads remain available after logout. Partial media is represented by `result.outcome: "partial"` with job `state: "failed"`; only affirmative coverage and validation can yield complete success. See [job lifecycle and recovery](jobs/README.md).

Runtime files under ignored `output/` include session credentials, jobs, recordings and Agent history. Keep them private and retain them if you need restoration; they are not part of the source checkout. A browser refresh, client exit and resident-process restart have different effects.

### Hardware evidence and limits

Evidence is for a **CA account, T8030 HomeBase 3 and specific T8600 cameras on the same LAN**. Verification binds camera, HomeBase, channel and firmware; it does not transfer to a different device or firmware.

| Area | Recorded acceptance | Remaining limit |
|---|---|---|
| Continuous 20-minute export | A real 2026-08-27 16:30–16:50 Toronto export and a later Agent-to-hardware run produced playable, fully decodable media | **PARTIAL**: 51 video gaps over 250 ms, largest 4.067 s; no gap-free/lossless claim ([record](agent/VALIDATION.md)) |
| Playback controls | Real 1× start, six-second stationary pause, resume progress and stop ([PR #31](https://github.com/ferryhe/eufy-agent-hub/pull/31)) | Accepted public scope authorizes speed 1; no verified public 2×/4×/8×/16× claim. Control API drains media; it provides no browser playback stream ([contract](capabilities/recordings/PLAYBACK_SESSIONS.md)) |
| Live video | 2026-09-12 acceptance on one exact T8600/T8030 scope: 29 sampled frames fully decoded, confirmed stop, resource cleanup and same-HomeBase export conflict | Video-only MJPEG, up to 5 fps and 960 px wide, 1–60 s sessions; not continuous surveillance. Other devices/firmware, talkback and RTSP remain unverified ([record and lifecycle](capabilities/live/README.md)) |
| Device discovery | Structured inventory, associations, capability evidence and explicit failure/retry state | Mega continuation remains unverified; successful discovery still reports `completeness: "unknown"` ([discovery contract](capabilities/devices/DISCOVERY.md)) |

A protocol hint permits only the bounded operations allowed by that capability's contract. Unknown/unsupported Live refuses execution; playback controls require an exact persisted verified record. Installing this repository does not create private hardware evidence or automatically promote a device to verified. Event indexes, end frames, file existence and successful decoding alone do not establish continuous coverage. Video-content recognition is not implemented.

### Architecture and development

The browser, Agent and CLI call the resident HTTP service; the service owns account state, jobs, capability checks and protocol connections. Fixed pages also retain their legacy event routes. Long-running hardware work stays in the resident, not in a browser or model call.

| Directory | Responsibility |
|---|---|
| `capabilities/auth`, `devices`, `recordings`, `live` | Account, inventory and media capabilities |
| `api/`, `jobs/` | v1/legacy contracts, durable recording execution and recovery |
| `cli/`, `agent/` | HTTP CLI and single SDK recording Agent |
| `interface/pages`, `components`, `agent`, `workspace`, `i18n` | Native HTML/ES-module interface, shared results, conversation adapter, layout references and localization |
| `adapters/eufy`, `vendor/eufy-security-client` | Shared protocol entry point and patched vendor source |
| `docs/` | Architecture, evidence contracts and issue planning history |

`npm test` covers capability/API/CLI/Agent/interface/job behavior using isolated fixtures. Configured media tests exercise real Python/PyAV/FFmpeg with synthetic inputs; these are not new hardware acceptance. Follow module documentation for opt-in hardware validation and never promote unreviewed evidence.

Documentation convention: this root README is bilingual; other project documents are English. Additional references: [architecture](docs/ARCHITECTURE.md), [interface](interface/README.md), [recording capabilities](capabilities/recordings/README.md), [protocol provenance](vendor/eufy-security-client/PROVENANCE.md).

### Delivery history

The original issues are completed scoped deliveries, not an outstanding implementation list:

| Delivery | Closed issues |
|---|---|
| Durable jobs, v1 service and session lifecycle | [#1](https://github.com/ferryhe/eufy-agent-hub/issues/1), [#2](https://github.com/ferryhe/eufy-agent-hub/issues/2), [#3](https://github.com/ferryhe/eufy-agent-hub/issues/3) |
| Device association, evidence and discovery completeness reporting | [#4](https://github.com/ferryhe/eufy-agent-hub/issues/4), [#5](https://github.com/ferryhe/eufy-agent-hub/issues/5) |
| Continuous export acceptance/pipeline, time contract and playback controls | [#6](https://github.com/ferryhe/eufy-agent-hub/issues/6), [#7](https://github.com/ferryhe/eufy-agent-hub/issues/7), [#8](https://github.com/ferryhe/eufy-agent-hub/issues/8), [#9](https://github.com/ferryhe/eufy-agent-hub/issues/9) |
| Live-session lifecycle | [#10](https://github.com/ferryhe/eufy-agent-hub/issues/10) |
| CLI and recording Agent | [#11](https://github.com/ferryhe/eufy-agent-hub/issues/11), [#12](https://github.com/ferryhe/eufy-agent-hub/issues/12) |
| Shared browser results, workspace and English/Chinese localization | [#13](https://github.com/ferryhe/eufy-agent-hub/issues/13), [#14](https://github.com/ferryhe/eufy-agent-hub/issues/14), [#16](https://github.com/ferryhe/eufy-agent-hub/issues/16) |

Phase 2 includes job recovery/cancel/retry ([PR #29](https://github.com/ferryhe/eufy-agent-hub/pull/29)), discovery reporting ([PR #30](https://github.com/ferryhe/eufy-agent-hub/pull/30)), playback controls ([PR #31](https://github.com/ferryhe/eufy-agent-hub/pull/31)) and Live ([PR #32](https://github.com/ferryhe/eufy-agent-hub/pull/32)). Hardware and interface limits above remain explicit after issue closure.

### Credits and license

Based on the MIT-licensed [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client), with a source snapshot retaining documented local patches. Upstream features are not automatically supported by this hub. See [MIT License](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md) and [source provenance](vendor/eufy-security-client/PROVENANCE.md). This community project is not affiliated with eufy or Anker.

---

## 中文

本地运行的 eufy 录像应用，包含可复用能力、常驻 HTTP API、CLI 和可选的录像 Agent。浏览器已提供事件录像查询、Agent 侧栏、共享结果组件和可恢复工作区，支持英文和简体中文。

**Phase 1、Phase 2 已交付，代码合并至 PR #32。** 截至 2026-09-13，原有 15 个 Issue（#1–#14、#16）均已关闭。这表示完成各项约定范围的验收，不代表已实现无缺口导出或验证所有设备。交付记录见下方，实机限制单独列明。

### 现在能做什么，从哪里操作

| 功能 | 当前入口 | 边界 |
|---|---|---|
| 登录、验证码、退出和会话恢复 | 页面、CLI、v1 会话 API | 单账号常驻会话；保存的会话失效时需要登录 |
| 设备发现与能力矩阵 | 页面设备列表、CLI、v1 设备 API | 按摄像头/HomeBase/通道/固件记录；设备发现完整性仍未知 |
| 事件查询、下载、已保存 MP4 播放 | **浏览录像**及旧版 HTTP 路由 | 没有事件不等于没有连续录像 |
| 连续录像范围查询与导出 | CLI、v1 API、录像 Agent | 持久化任务、转换、全片解码及覆盖校验；结果可能为 partial |
| 任务恢复、取消、显式重试 | 常驻任务服务；取消/重试使用 v1 API | 中断捕获不能续传；CLI 尚无取消/重试子命令，页面尚无完整任务中心 |
| 历史回放暂停/恢复 | v1 回放会话控制 API | 公开验收为 1× 暂停/恢复；没有浏览器媒体地址或回放控制页面 |
| 实时视频 | v1 Live 会话 API 和 MJPEG 地址 | 有时限的纯视频预览；暂无专用 Live 页面或 CLI/Agent Live 命令 |
| 自然语言导出 | **询问助手**侧栏或终端 Agent | 需要配置模型；普通浏览不需要 |
| 共享结果与动态工作区 | 两种页面模式 | 设备、时间轴、任务、播放器组件；支持固定、排序和引用恢复 |

固定事件查询表单没有直接导出连续录像的按钮。Agent 可以提交连续导出；工作区中由 Agent 范围查询凭据生成的时间轴也提供导出操作。[v1 契约](api/v1.md)与[旧页面路由](api/README.md)是不同接口。

### 快速开始

安装 **Node.js 24 或以上**及 npm，在仓库根目录执行：

```sh
npm ci
npm run setup
npm run build
npm test
npm start
```

`setup` 按锁文件安装协议库依赖，`build` 编译协议库并复制资源。自动测试不需要真实账号/HomeBase；部分媒体测试需要配置本机工具。

打开 **http://127.0.0.1:3187/**。首次使用时填写账号所属地区（已测试账号为 `CA`），完成登录和可能出现的图片/邮件验证码。页面、CLI 和 Agent 使用期间保持常驻服务运行。服务仅监听 `127.0.0.1`，并检查实际 Host 和浏览器 Origin。

登录成功后，会话默认保存到不进入 Git 的 `output/auth/session.json`，重启时会验证并尝试恢复。**正常重启不一定需要重新登录。** 保存的会话过期、损坏或不可用时才需要重新登录。密码和未完成的验证码流程不会保存；**退出登录**会清除保存的会话。可通过 `EUFY_SESSION_PATH` 指定私有、持久的位置，该文件应按登录凭据保管。详见[会话生命周期](capabilities/auth/README.md)。

如果 3187 被占用，可在 PowerShell 中设置：

```powershell
$env:EUFY_PORT = '3188'
npm start
```

然后打开 `http://127.0.0.1:3188/`，CLI 使用 `--url http://127.0.0.1:3188`。不要让多个常驻进程共用同一任务/状态目录。

#### 媒体依赖

事件转换与验证、连续导出、Live 预览都需要 **FFmpeg**。将它放入 `PATH`，或通过 `EUFY_FFMPEG` 指定可执行文件。连续导出还需要 **Python 和 PyAV**：

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

PowerShell 配置示例：

```powershell
$env:EUFY_FFMPEG = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
$env:EUFY_PYTHON = 'C:\Path\To\python.exe'
npm start
```

请替换为实际安装路径，并保证安装 PyAV 与 `EUFY_PYTHON` 使用同一个 Python。没有媒体工具时，登录和设备发现仍可运行。

#### 页面操作

1. 登录后选择**浏览录像**，选择摄像头、日期和时间范围，查询事件、下载片段并播放已保存的 MP4。
2. 要导出连续时段，先按下方说明配置 Agent，再选择**询问助手**；也可使用 CLI/API。明确摄像头、日期、起止时间和时区，不明确时由 Agent 追问。
3. 查看共享任务卡上的进度、实际覆盖和校验结果。可播放的 `partial` 文件仍是覆盖不完整的结果。
4. 将常用结果固定到工作区并调整顺序。刷新页面会恢复引用、查询已有任务，不会再次调用模型。

界面跟随浏览器语言，默认回退英文，也可手动选择并记住英文/中文。固定事件查询使用 **America/Toronto**。API 可指定 IANA `timezone`；省略时使用 `EUFY_RECORDING_TIMEZONE` 或 `America/Toronto`。夏令时不存在/重复的本地时间以及跨午夜窗口会被拒绝；跨午夜需求需拆为支持的窗口。详见[时间窗口约定](docs/recording-time-window.md)。

#### CLI 操作

保持常驻服务运行，在另一终端执行。将 `CAMERA_SERIAL`、示例日期和返回的 ID 替换为自己的设备、仍有录像的日期和接口返回值：

```sh
node cli/eufy.cjs auth status
node cli/eufy.cjs --json devices list
node cli/eufy.cjs --json recordings ranges CAMERA_SERIAL --day 2026-09-12 --start 16:30 --end 16:50 --timezone America/Toronto
node cli/eufy.cjs --json recordings export --request-id camera-20260912-1630-01 --serial CAMERA_SERIAL --day 2026-09-12 --start 16:30 --end 16:50 --timezone America/Toronto
node cli/eufy.cjs --json jobs get JOB_ID
node cli/eufy.cjs --json jobs wait JOB_ID
node cli/eufy.cjs --json artifacts list JOB_ID
node cli/eufy.cjs --json artifacts get JOB_ID ARTIFACT_ID --output recording.mp4
```

导出持久化受理后立即返回 `job.jobId`。提交客户端退出或等待超时，不会停止服务中的任务。重复请求 ID 返回原任务，不会重试；新的执行需要新的请求 ID。产物下载会写入并覆盖指定文件，应检查产物的 outcome、playable、validated 字段；下载成功不代表覆盖完整。可用 `npm install --global .` 安装为 `eufy` 命令。详见[CLI 命令和退出码](cli/README.md)。

#### 可选的录像 Agent

页面侧栏需要在**常驻服务进程**中配置 `OPENAI_API_KEY`；`EUFY_AGENT_MODEL` 可指定模型，默认 `gpt-4.1-mini`。若使用不进入 Git 的 `.env.local` 文件，可这样启动页面服务：

```sh
node --env-file=.env.local interface/server.cjs
```

`npm start` 不会自动读取 `.env.local`。同一端口只运行一个常驻服务。终端 Agent 是该服务的另一个客户端：

```sh
node --env-file=.env.local agent/main.cjs --url http://127.0.0.1:3187
```

请求示例：“导出 Drive Way 在 2026-09-12 的 16:30 到 16:50 录像，时区 America/Toronto。”请替换实际摄像头和仍有录像的日期。账号密码、验证码只在正常登录流程填写，不要放进对话。任务状态轮询只查询 HTTP，不消耗模型调用。详见 [Agent 配置](agent/README.md)及[侧栏说明](interface/agent/README.md)。

### 任务恢复与仅 API 提供的操作

录像由常驻服务执行，同一 HomeBase 的任务按先后排队。取消操作要等媒体和进程资源清理完才释放占用。Live、历史回放和其他录像操作共用媒体占用检查，不会抢占正在执行的工作。

| 操作 | v1 接口及行为 |
|---|---|
| 查看已知任务 | `GET /api/v1/jobs/:jobId` |
| 取消排队/运行中的任务 | `POST /api/v1/jobs/:jobId/cancel`，正文 `{}`；运行中的任务等清理完成后才成为 cancelled |
| 显式重试失败/取消任务 | `POST /api/v1/jobs/:jobId/retry`，正文 `{"requestId":"NEW_UNIQUE_ID"}`；创建新任务并保留原任务 |
| 启动 Live | `POST /api/v1/live-sessions`，正文 `{"requestId":"NEW_UNIQUE_ID","serial":"CAMERA_SERIAL","maxDurationMs":60000}` |
| 查看/播放/停止 Live | `GET /api/v1/live-sessions/:sessionId`、`GET /api/v1/live-sessions/:sessionId/media`、`POST /api/v1/live-sessions/:sessionId/stop`（正文 `{}`） |

POST 使用 `Content-Type: application/json`；浏览器请求的 Origin 必须匹配常驻服务。目前没有公开的全部任务列表接口，请保留返回的任务 ID。

重启后，安全排队的任务保留标识与顺序，执行仍要求有效登录。原先运行中的捕获标记为 `failed` / `JOB_INTERRUPTED`；若已保存取消意图，则标记为 `cancelled`。不会自动重放或续传，应先检查保留的证据，再按需显式重试。退出登录后仍可读取已有任务及产物。部分录像使用 `result.outcome: "partial"`、任务状态 `state: "failed"`；只有覆盖和媒体验证均明确通过才算完整成功。详见[任务生命周期](jobs/README.md)。

不进入 Git 的 `output/` 包含会话凭据、任务、录像和 Agent 历史。需要恢复时应保留这些私有文件；源码本身不包含它们。页面刷新、客户端退出和服务进程重启的影响不同。

### 实机验收与限制

已有证据来自 **CA 账号、同局域网的 T8030 HomeBase 3 和指定 T8600 摄像头**。验证绑定摄像头、HomeBase、通道和固件，不自动适用于其他设备或固件。

| 项目 | 已有验收 | 仍保留的限制 |
|---|---|---|
| 连续 20 分钟导出 | 2026-08-27 多伦多时间 16:30–16:50 的实机导出，以及后续 Agent 到实机流程，产出可播放且全片解码通过的视频 | **PARTIAL**：51 处超过 250 ms 的视频缺口，最大 4.067 秒；不声称无缺口或无损（[记录](agent/VALIDATION.md)） |
| 历史回放控制 | 实机完成 1× 启动、6 秒静止暂停、恢复推进和停止（[PR #31](https://github.com/ferryhe/eufy-agent-hub/pull/31)） | 已接受的公开范围仅授权 speed 1；不声称 2×/4×/8×/16× 已公开验证。控制 API 消费媒体但不提供浏览器播放流（[契约](capabilities/recordings/PLAYBACK_SESSIONS.md)） |
| 实时视频 | 2026-09-12 验收一个精确 T8600/T8030 范围：29 个采样帧全解码、确认停止、资源清理及同 HomeBase 导出冲突处理 | 纯视频 MJPEG，最高 5 fps、宽 960 px、会话 1–60 秒；不是持续监控。其他设备/固件、talkback、RTSP 未验证（[记录与生命周期](capabilities/live/README.md)） |
| 设备发现 | 已提供结构化设备、关联、能力证据及明确的失败/重试状态 | Mega 后续分页未验证；成功查询仍报告 `completeness: "unknown"`（[发现契约](capabilities/devices/DISCOVERY.md)） |

协议提示仅允许对应契约规定的有限尝试。Live 为 unknown/unsupported 时拒绝执行；回放控制要求精确匹配的持久化验证记录。安装仓库不会创建私人实机证据，也不会自动把设备提升为 verified。事件索引、结束帧、文件存在或解码成功，都不能单独证明连续录像完整。视频内容识别尚未实现。

### 架构与开发

浏览器、Agent 和 CLI 调用常驻 HTTP 服务，由服务统一管理账号、任务、能力检查及协议连接；固定页面的事件功能仍使用旧路由。长时间的实机工作留在服务进程中执行。

| 目录 | 职责 |
|---|---|
| `capabilities/auth`、`devices`、`recordings`、`live` | 账号、设备和媒体能力 |
| `api/`、`jobs/` | v1/旧接口、持久化录像任务及恢复 |
| `cli/`、`agent/` | HTTP CLI 与单 SDK 录像 Agent |
| `interface/pages`、`components`、`agent`、`workspace`、`i18n` | 原生 HTML/ES 模块页面、共享结果、对话适配、布局引用及多语言 |
| `adapters/eufy`、`vendor/eufy-security-client` | 统一协议入口及带本地补丁的协议源码 |
| `docs/` | 架构、证据契约和任务规划历史 |

`npm test` 使用隔离夹具覆盖能力、API、CLI、Agent、界面与任务行为。配置好媒体工具后，相关测试使用合成输入运行真实 Python/PyAV/FFmpeg；这不等于新增实机验收。实机验证按模块文档执行，未经审核的证据不提升能力状态。

文档约定：根 README 中英双语，其他项目文档使用英文。参考：[架构](docs/ARCHITECTURE.md)、[界面](interface/README.md)、[录像能力](capabilities/recordings/README.md)、[协议来源](vendor/eufy-security-client/PROVENANCE.md)。

### 交付记录

原有 Issue 是已完成的阶段交付记录，不是仍待开发的清单：

| 交付 | 已关闭 Issue |
|---|---|
| 持久化任务、v1 服务、会话生命周期 | [#1](https://github.com/ferryhe/eufy-agent-hub/issues/1)、[#2](https://github.com/ferryhe/eufy-agent-hub/issues/2)、[#3](https://github.com/ferryhe/eufy-agent-hub/issues/3) |
| 设备关联、能力证据、发现完整性报告 | [#4](https://github.com/ferryhe/eufy-agent-hub/issues/4)、[#5](https://github.com/ferryhe/eufy-agent-hub/issues/5) |
| 连续导出验收/流水线、时区、回放控制 | [#6](https://github.com/ferryhe/eufy-agent-hub/issues/6)、[#7](https://github.com/ferryhe/eufy-agent-hub/issues/7)、[#8](https://github.com/ferryhe/eufy-agent-hub/issues/8)、[#9](https://github.com/ferryhe/eufy-agent-hub/issues/9) |
| Live 会话生命周期 | [#10](https://github.com/ferryhe/eufy-agent-hub/issues/10) |
| CLI 和录像 Agent | [#11](https://github.com/ferryhe/eufy-agent-hub/issues/11)、[#12](https://github.com/ferryhe/eufy-agent-hub/issues/12) |
| 页面共享结果、工作区、中英多语言 | [#13](https://github.com/ferryhe/eufy-agent-hub/issues/13)、[#14](https://github.com/ferryhe/eufy-agent-hub/issues/14)、[#16](https://github.com/ferryhe/eufy-agent-hub/issues/16) |

Phase 2 包括任务恢复/取消/重试（[PR #29](https://github.com/ferryhe/eufy-agent-hub/pull/29)）、设备发现报告（[PR #30](https://github.com/ferryhe/eufy-agent-hub/pull/30)）、回放控制（[PR #31](https://github.com/ferryhe/eufy-agent-hub/pull/31)）和 Live（[PR #32](https://github.com/ferryhe/eufy-agent-hub/pull/32)）。Issue 关闭后，上述实机和页面限制仍然保留。

### 来源与许可证

基于 MIT 许可的 [bropat/eufy-security-client](https://github.com/bropat/eufy-security-client)，源码快照保留有记录的本地补丁。上游功能不自动等于本应用支持的能力。见 [MIT License](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)和[源码来源](vendor/eufy-security-client/PROVENANCE.md)。这是社区项目，与 eufy 或 Anker 官方没有隶属关系。
