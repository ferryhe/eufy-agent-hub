# 录像能力

本目录从本地 eufy 原型迁入，协议依赖统一通过 `../../adapters/eufy`。
调用者传入已登录的会话；模块不保存密码，不接管其他服务的登录状态。

| 文件 | 功能 | 成熟度 |
|---|---|---|
| `events.cjs` | 事件日期索引、设备筛选、下载完成确认 | 已验证迁入；当前限同一局域网的 HomeBase 3 |
| `export.cjs` | 将确认下载完成的原始流导出 MP4，并完整解码验证 | 已验证迁入；依赖 FFmpeg |
| `continuous.cjs` | 6000 查询连续时段、6001 回放、保存带时间戳的原始帧 | 实验性；仅短片完成实机验证 |
| `mux.py` | 使用逐帧时间戳生成 MPEG-TS | 实验性；依赖 Python 与 PyAV，尚未接入后台任务 |

## 事件录像

在仓库根目录执行的示例；`session` 是通过 auth 能力获得的已登录会话。

```javascript
const path = require('node:path');
const { LocalRecordings } = require('./capabilities/recordings/events.cjs');
const { exportRecording } = require('./capabilities/recordings/export.cjs');
const service = new LocalRecordings(session);
try {
  const records = await service.listDay(cameraSerial, '2026-08-27');
  if (!records.length) throw new Error('当天没有事件索引；这不代表没有连续录像。');
  const directory = path.resolve('output', 'my-export');
  const download = await service.download(records[0].record_id, directory);
  const result = await exportRecording(download.prefix, path.join(directory, 'event.mp4'));
} finally {
  service.close();
}
```

输出目录由调用者指定，CLI/API 应选择本仓库 `output/` 下的目录。
原始视频、音频和元数据会保留；收到设备完成通知且写入结束才登记下载成功。
导出还需通过完整解码检查。事件下载目前有 90 秒超时；不要把事件列表当成连续回放时间轴。

FFmpeg 优先使用环境变量 `EUFY_FFMPEG` 指定的可执行文件，否则从 `PATH` 查找 `ffmpeg`。
缺少 FFmpeg 会返回明确的安装/配置提示，不依赖旧仓库的私有运行时。
当前导出元数据时区仍为 `America/Toronto`，通用时区支持另行跟踪。

## 连续录像

已获得 6000/6001 的真实调用和短片结果；不再依赖早期 1025/1026 的猜测。
完整命令、调用方法和限制见 [CONTINUOUS_PLAYBACK.md](CONTINUOUS_PLAYBACK.md)。
长片、中途断线、时间缺口、自动转换和任务恢复尚未完成验收，见 [Issue 草案](../../docs/issues/recordings.md)。

测试：在仓库根目录执行 `node --test capabilities/recordings/*.test.cjs`，需先构建协议适配依赖。
