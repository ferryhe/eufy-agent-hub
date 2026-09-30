# eufy-agent-hub

[English](#english) | [中文](#中文)

## English

Use a local browser app to browse and export recordings from your eufy cameras. You can use the recording pages without AI; the optional assistant accepts recording requests in plain language.

### 1. Install and start

You need Node.js 24 or later, npm, and an eufy account. From a terminal:

```sh
git clone https://github.com/ferryhe/eufy-agent-hub.git
cd eufy-agent-hub
npm ci
npm run setup
npm run build
npm start
```

Open **http://127.0.0.1:3187/**. The service listens on this computer only. Sign in with your eufy account and select its region; complete any CAPTCHA or email verification in the login form. The saved session normally survives a service restart. Sign out to remove it.

For later sessions, start the app with `npm start` from the project folder.

### 2. Install media tools when needed

FFmpeg is needed for event previews, exports and Live video. Add `ffmpeg` to `PATH` or set `EUFY_FFMPEG` before starting the service. Restart the service after changing these settings. Continuous recording export also needs Python and PyAV:

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

Login and device discovery work without these tools.

### 3. Browse, export and check jobs

1. In **Recordings**, select a camera and date/time range, then search for event clips. **Preview** downloads and prepares a clip, then shows its video under that event. **Export MP4…** on the same row opens a save dialog so you can choose the MP4 name and location.
2. Click **Check continuous availability** to see indexed ranges. Play the sample below when one is available. Click **Export MP4** below the preview to start the continuous export. An empty event list does not mean that continuous footage is unavailable.
3. Follow export progress on its task card or in **Jobs**. When a continuous export finishes, return to **Recordings** and click **Save MP4…** on the task card to choose where to save it. A playable `partial` result is still incomplete.
4. Open **Live** for an on-demand preview. Sessions last 1–60 seconds and show video only.

The interface follows the browser language by default. Change language or theme from the controls in the top bar.

### 4. Set up the AI assistant (optional)

To enable the assistant, add your OpenAI API key to `.env.local` in the project folder:

```dotenv
OPENAI_API_KEY=replace-with-your-key
EUFY_AGENT_MODEL=gpt-6-luna
```

Replace the sample key with your own. The model line is optional; the default is `gpt-6-luna`. Keep the key private.

If the service is already running, stop it with Ctrl+C first. Then start it from the project folder with the file loaded:

```sh
node --env-file=.env.local interface/server.cjs
```

`npm start` does not load `.env.local`. Keep this service running, sign in at `http://127.0.0.1:3187/`, and click the robot button in the lower-right corner. Ask for the camera, date, time range and timezone. For example:

> Export Drive Way on 2026-09-12 from 16:30 to 16:50, America/Toronto.

The assistant asks follow-up questions when details are unclear. Use **Jobs** to check the export. Closing the assistant or refreshing the page does not cancel a job. Enter eufy passwords and verification codes only in the normal login form, never in chat.

**Assistant results** is collapsed by default. Expand it to see camera, recording-time and export results. Pin useful results to keep their links after refresh, then use **Move up** and **Move down** to change their order.

#### Fix “The assistant is not configured. Normal browsing is available.”

This usually means the service started without `OPENAI_API_KEY`. Add the key as shown above, stop the service with Ctrl+C, start it with `node --env-file=.env.local interface/server.cjs`, then refresh the page. The browser's **Settings** page cannot set this key. Manual recording works without AI.

### Your data

Your login session, assistant history, jobs and recordings stay on this computer. Treat downloaded video as private. Live preview lasts 1–60 seconds; it is not continuous monitoring. If a job is marked `partial`, the export is incomplete.

## 中文

通过本地浏览器应用查看和导出 eufy 摄像头录像。手动录像功能不需要 AI；可选助手支持用自然语言提出录像请求。

### 1. 安装并启动

需要 Node.js 24 或更高版本、npm 和 eufy 账号。在终端执行：

```sh
git clone https://github.com/ferryhe/eufy-agent-hub.git
cd eufy-agent-hub
npm ci
npm run setup
npm run build
npm start
```

打开 **http://127.0.0.1:3187/**。服务只监听本机。使用 eufy 账号登录并选择账号所属地区；如遇图片验证码或邮件验证码，请在登录表单中完成。保存的会话通常会在服务重启后继续使用；退出登录会删除该会话。

之后每次启动，在项目目录运行 `npm start`。

### 2. 按需安装媒体工具

事件预览、录像导出和 Live 实时画面需要 FFmpeg。将 `ffmpeg` 加入 `PATH`，或在启动服务前设置 `EUFY_FFMPEG`。修改后请重启服务。连续录像导出还需要 Python 和 PyAV：

```sh
python -m pip install -r capabilities/recordings/requirements.txt
```

没有这些工具时，仍可登录和发现设备。

### 3. 查询录像、导出并查看任务

1. 在**录像**页面选择摄像头和日期/时间范围，然后查询事件录像。点击每条事件下的**预览**会下载并准备片段，再直接在该事件下显示视频。同一行的**导出 MP4…**会打开保存窗口，可选择 MP4 文件名和位置。
2. 点击**检查连续录像范围**查看索引区间；有可用片段时，可在下方预览。点击预览下方的**导出 MP4**开始连续录像导出。事件列表为空不代表没有连续录像。
3. 在任务卡或**任务**页面查看导出进度。连续录像完成后，回到**录像**页面，在任务卡上点击**保存 MP4…**选择保存位置。可播放的 `partial` 文件仍表示录像不完整。
4. 打开**实时预览**查看按需 Live 画面。每次会话为 1–60 秒，只显示视频。

界面默认跟随浏览器语言。可用顶部控件切换语言或主题。

### 4. 配置 AI 助手（可选）

要启用助手，请在项目目录的 `.env.local` 中写入自己的 OpenAI API 密钥：

```dotenv
OPENAI_API_KEY=替换成你自己的密钥
EUFY_AGENT_MODEL=gpt-6-luna
```

请替换示例密钥。模型设置可选；默认使用 `gpt-6-luna`。妥善保管密钥。

启动时显式加载配置文件：

```sh
node --env-file=.env.local interface/server.cjs
```

如果服务已经运行，请先按 Ctrl+C 停止，再从项目目录运行上面的命令。`npm start` 不会读取 `.env.local`。保持服务运行，在浏览器登录后点击右下角的机器人按钮，描述摄像头、日期、时间范围和时区。例如：

> 导出 Drive Way 在 2026-09-12 的 16:30 到 16:50 录像，时区 America/Toronto。

信息不明确时，助手会继续询问。导出后到**任务**页面查看结果。关闭助手或刷新页面不会取消已提交的任务。eufy 密码和验证码只在正常登录表单中填写，不要放进对话。

**助手结果**默认收起。展开后可查看摄像头、录像时段和导出结果。点击**固定**可在刷新后保留入口，再用**上移**和**下移**调整顺序。

#### 解决 “The assistant is not configured. Normal browsing is available.”

通常是因为服务启动时没有加载 `OPENAI_API_KEY`。按上文设置密钥，按 Ctrl+C 停止服务，再运行 `node --env-file=.env.local interface/server.cjs`，然后刷新页面。浏览器的**设置**页面不能填写这个密钥。手动查询和导出录像不需要 AI。

### 数据提示

登录会话、助手记录、任务和录像保存在本机。下载的视频属于私人数据。Live 预览为 1–60 秒，不是持续监控。任务标记为 `partial` 时，录像导出不完整。
