# Windows x64 private-evaluation release / Windows x64 私有验收版

This extract-and-run package is for Windows 11 x64 standard users. It includes Node, Python, PyAV, FFmpeg, production Node dependencies, the built eufy adapter, and the React app. It never runs npm or pip and does not download runtime dependencies. The publication license gate described below is still blocked.

此解压即用包面向 Windows 11 x64 标准用户。包内包含 Node、Python、PyAV、FFmpeg、生产 Node 依赖、已构建的 eufy 适配器和 React 页面。运行时不会调用 npm/pip，也不会下载运行依赖。下述公开发行许可门槛仍未通过。

## Start and stop / 启动与停止

Extract to any directory and double-click `Start.cmd`. The resident listens only on `http://127.0.0.1:3187` and opens the default browser. A second Start talks to the existing resident through its user-specific named pipe and reuses it. If another application owns port 3187, startup reports the conflict and does not open that application's page.

解压到任意目录后双击 `Start.cmd`。常驻服务只监听 `http://127.0.0.1:3187`，并打开默认浏览器。再次启动时，启动器通过当前用户专用命名管道复用现有进程。若 3187 被其他程序占用，启动会明确报错，且不会打开该程序的页面。

Double-click `Stop.cmd` for a graceful stop. It stops new work, waits for Agent work, playback/live sessions, event exports, continuous export jobs, and media child processes, then releases the single-instance owner. It never kills a process by name or PID.

双击 `Stop.cmd` 可正常停止。它会先拒绝新任务，再等待 Agent、播放/实时会话、事件导出、连续导出任务和媒体子进程完成清理，最后释放单实例所有权；不会按进程名或 PID 强杀。

## Data and upgrades / 数据与升级

All mutable state is under `%LOCALAPPDATA%\EufyAgentHub`: login session, event media, continuous jobs/results, device verification, Agent state, control files, and logs. The release directory can be read-only. To upgrade, stop the resident, replace or extract a new release directory, and run its `Start.cmd`; the stable data root and port preserve valid state and browser preferences.

所有可变数据都在 `%LOCALAPPDATA%\EufyAgentHub`：登录会话、事件媒体、连续任务/结果、设备验证记录、Agent 状态、控制文件及日志。发行目录可设为只读。升级时先停止服务，再替换或解压新版目录并运行新版 `Start.cmd`；稳定的数据根目录和端口会保留仍有效的状态与浏览器偏好。

To import an old verification store, stop the resident and run `Import-Verification.cmd C:\path\to\verification.json`. The command validates the existing schema and preserves the exact serial/model/firmware/HomeBase/channel scope. Identical records are skipped. A conflicting record aborts before any import and never silently overwrites current data. It does not import reachability observations.

导入旧验证记录前先停止服务，再运行 `Import-Verification.cmd C:\path\to\verification.json`。命令按现有 schema 校验，并原样保留序列号、型号、固件、HomeBase 和通道范围。完全相同的记录会跳过；冲突记录会在写入前终止，绝不静默覆盖新数据；在线状态观察不会导入。

## Playback and export / 播放与导出

Recordings work without an AI key. Exported event and continuous MP4 files remain playable through resident HTTP. Continuous jobs show progress, cancellation, recovered state, diagnostics, and truthful `complete`, `partial`, or `failed` outcomes. A playable partial file remains `partial`. Missing/broken bundled runtimes or failed full decode cannot register media as successful.

录像功能不需要 AI key。已导出的事件和连续 MP4 可通过常驻 HTTP 播放。连续任务会显示进度、取消、恢复状态、诊断及真实的 `complete`、`partial`、`failed` 结果；可播放的缺失片段仍标为 `partial`。包内运行时缺失/损坏或全片解码失败时，不会把媒体登记为成功。

Historical preview controls are enabled only by an exact verified device/firmware scope in the data store. A fresh data root displays the path as unverified. Historical preview provides decoded video frames only; it does not claim audio, arbitrary duration, or gap-free source footage.

历史预览控制仅在数据目录中存在精确设备/固件范围验证时启用。全新数据目录会明确显示未验证。历史预览只提供解码后的视频画面，不承诺音频、任意时长或无缺口原始录像。

## Audit and publication gate / 审计与公开发行门槛

`release-manifest.json` records the source commit/dirty flag, pinned input URLs and SHA-256 values, shipped file hashes, FFmpeg `-version`/license output, PyAV library versions, and production npm inventory. The package carries the primary license files for Node, Python, PyAV itself, and the Gyan FFmpeg archive. The PyAV wheel does not carry the license/source materials for every DLL under `av.libs`.

`release-manifest.json` 记录源码提交/脏状态、固定输入 URL 与 SHA-256、随包文件哈希、FFmpeg `-version`/许可输出、PyAV 库版本及生产 npm 清单。包内保留 Node、Python、PyAV 自身及 Gyan FFmpeg 归档的主许可证文件；PyAV wheel 未携带 `av.libs` 下每个 DLL 所需的许可/源码材料。

`publicationGate.status` is `BLOCKED`. The Gyan README identifies FFmpeg commit `946fcce07b` and x264 version `v0.165.3223`, but the static build still lacks verified artifact-specific source archives/hashes, reproducible dependency build materials, and required license/source materials for every linked component. The PyAV 18.1.0 wheel's `av.libs` directory contains 25 DLLs; its upstream FFmpeg 8.1.2 build recipe pins many codec sources, but the wheel does not carry every bundled library's license/source materials and the copied MinGW runtime DLLs are not tied to an exact toolchain package in that recipe. Do not publish the ZIP until the actual shipped artifacts have complete license/source/build correspondence. Offline synthetic browser results do not satisfy real-device acceptance; AC-6 remains `NOT_RUN` until separately authorized T8600/T8030 testing is completed.

`publicationGate.status` 当前为 `BLOCKED`。Gyan README 已标明 FFmpeg commit `946fcce07b` 与 x264 版本 `v0.165.3223`，但该静态构建仍缺少每个链接组件与实际产物对应的源码归档/哈希、可重现依赖构建材料及所需许可/源码材料。PyAV 18.1.0 wheel 的 `av.libs` 目录包含 25 个 DLL；其上游 FFmpeg 8.1.2 构建脚本固定了多项 codec 源码，但 wheel 未携带全部内置库的许可/源码材料，脚本复制的 MinGW 运行库也未对应到精确工具链软件包。在实际随包文件的许可、源码和构建对应关系完整前，不得公开发布 ZIP。离线合成浏览器验收不能代替实机验收；在另行授权并完成 T8600/T8030 测试前，AC-6 保持 `NOT_RUN`。
