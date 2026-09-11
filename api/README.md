# 本地 HTTP API

`legacy-recording-routes.cjs` 迁移原页面协议。这些路由已供固定页面使用，**不是稳定的 v1 Agent API**。默认通过 `node interface/server.cjs` 启动，仅服务本机。

| 方法 | 路径 | 用途 / 请求 |
| --- | --- | --- |
| GET | `/` | 固定登录与录像页面 |
| GET | `/status` | 登录状态、设备列表、`busy` |
| POST | `/login` | `{email,password,country}`，例如地区 `CA` |
| POST | `/verify` | `{code}`，邮件验证码或图片验证码 |
| POST | `/refresh` | `{}`，刷新设备 |
| GET | `/recordings/status` | 查询状态、事件片段、已保存文件 |
| POST | `/recordings/query` | `{serial,day,start,end}`，日期 `YYYY-MM-DD`，时间 `HH:mm` |
| POST | `/recordings/download` | `{recordId}`，须来自最近一次查询 |
| GET / HEAD | `/recordings/media/:id` | 已保存 MP4，支持 HTTP Range；`?download` 为附件下载 |

POST 要求 `Content-Type: application/json`，以及与实际本地端口一致的 `Origin`。Host 同样必须匹配。查询与下载需要先登录；查询时间目前固定为 `America/Toronto`，正确处理夏令时并拒绝不存在或重复的时间，要求开始和结束在同一天。

异步操作返回 `202 {ok:true}`，代表已接受；调用方继续轮询状态判断是否完成。`busy` 为当前进程的互斥标志，冲突返回 409。参数错误返回 400，未登录的录像操作返回 401。现有协议没有独立任务 ID、持久队列、取消或自动重试，重启不会恢复进行中的任务。

导出写入仓库根目录 `output/`。启动时会读取其中的事件导出 manifest，恢复可播放文件清单。只有注册的已导出文件能通过媒体路由访问。此迁移不复制原仓库的私人录像、账号或会话。

`createServer({port, session, recordings, outputRoot})` 可注入测试依赖；`port:0` 使用系统分配的空闲端口。测试用例不需要账号或 HomeBase。

连续录像能力属于 `capabilities/recordings/continuous.cjs`，尚未接入这些 HTTP 路由。后续 v1 API 需要统一能力描述、结构化错误、任务 ID 和进度契约，供 CLI 与 Agent 共同调用。
