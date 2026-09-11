# HomeBase 3 连续历史回放：实验性能力

验证日期：2026-09-10。设备：Drive Way T8600，HomeBase 3 T8030，CA 账号，America/Toronto。
Android App 5.0.10_4569 的运行时代码与局域网通信提供了命令依据；随后已由电脑独立调用成功。

## 验证结果

- 6000 查询 2026-08-27 16:30–16:50，返回完整 `[1787862600,1787863800]` 范围，命令返回码为 0。
- 6001 启动连续回放，收到 VIDEO 传输中的 1300 视频帧和 1301 音频帧。
- 直接提取 16:30:00–16:30:20 样片：267 视频帧、307 音频包。第一帧时间 16:30:00.283，最后一帧 16:30:19.945；结束边界由后续视频帧到达 16:30:20 确认。
- 原始帧为 HEVC/AAC，样片内分辨率从 1920×1080 切换为 1280×720。必须保留逐帧时间，不能简单用固定帧率拼接。
- MP4 已完整解码，首尾画面水印分别为 Aug 27 2026 04:30:00 PM、04:30:19 PM。
- 新接口的整段 20 分钟提取尚未跑完验证。原先交付的 20 分钟手机录制拼接文件保留不变。
- 当前提供本地调用代码；网页尚未接入连续回放时间轴。

验证样片保留在原本地工作区；私人录像及运行数据不随代码迁入新仓库。

## 线上的命令格式

外层 P2P 命令均为 1700，JSON 如下。时间单位为 Unix 秒。

查询（摄像头通道 1）：

```json
{"commandType":6000,"data":{"device_sn":"<camera-serial>","begin_time":1787862600,"end_time":1787863800}}
```

返回通过 1351 通知：

```json
{"cmd":6000,"payload":{"begin_time":1787862600,"end_time":1787863800,"account":"","videos":[{"start_time":1787862600,"stop_time":1787863800}]}}
```

开始连续回放（account_id 来自当前登录会话）：

```json
{"commandType":6001,"data":{"session_id":125,"cmd":0,"begin_time":1787862600,"play_speed":1,"play_type":0,"device_sn":"<camera-serial>","account_id":"<当前账号 ID>","index":0}}
```

停止：

```json
{"commandType":6001,"data":{"session_id":123,"cmd":3,"begin_time":0,"play_speed":1,"play_type":0,"file_path":"","device_sn":"<camera-serial>","index":0}}
```

注意：连续播放开始包省略 `file_path`，事件播放则提供录像文件路径并使用 `play_type:1`。不要用事件文件下载代替连续时间轴。
此设备返回的历史媒体通道为 101；接收仍使用 VIDEO 传输。发送开始命令前必须开启该连接的接收状态，否则库会直接丢弃媒体包。
App 代码中还有 cmd 1 暂停、cmd 2 恢复；这些控制尚未由电脑实测，所以当前没有封装为可用功能。

## 本地调用

先构建项目。使用现有的已登录 `LocalEufySession`，不要把密码或会话写入脚本。

```javascript
const { LocalContinuousRecordings } = require('./capabilities/recordings/continuous.cjs');
const service = new LocalContinuousRecordings(session);
try {
  const ranges = await service.listRange('<camera-serial>', 1787862600, 1787863800);
  await service.captureRange('<camera-serial>', 1787862600, 1787862620, 'output/new-sample');
} finally {
  service.close();
}
```

捕获目录必须没有现存的 `frames.bin`，避免覆盖。成功后产生原始帧和带时间戳的索引；中断、命令失败或未到达结束时间时不产生成功索引。
`reachedEnd` 表示已收到结束时间后的帧，不代表已证明中间完全无丢帧。首次画面从返回的首个可解码关键帧开始。

安装 PyAV 后用 `python capabilities/recordings/mux.py output/new-sample` 生成保留原始时间的 `timed.ts`。
随后用 FFmpeg 将其转换为兼容播放器的 MP4，例如：

```text
ffmpeg -i output/new-sample/timed.ts -vf scale=1920:1080,format=yuv420p -fps_mode vfr -c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart output/new-sample/playback.mp4
ffmpeg -v error -xerror -i output/new-sample/playback.mp4 -f null -
```

在新仓库根目录安装依赖并构建适配器后，执行 `node --test capabilities/recordings/*.test.cjs`。该测试不连接设备；源项目的实机短片验证不等于新仓库的完整时段验收。
