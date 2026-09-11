# Agent（待实现）

此目录预留给结构化工具定义、工具适配和智能体编排。尚未安装 agent SDK、选择模型或启动监控。

Agent 使用已有能力与任务 API 完成“找设备 → 查询录像 → 创建导出 → 跟进进度 → 返回文件”。设备 ID、可用范围、任务状态和产物均来自工具结果。
工具不直接暴露未知的 P2P 命令编号，也不接收账号密码作为普通模型参数。

首批工具：get_session_status、list_devices、get_device_capabilities、list_recording_ranges、create_recording_export、get_job、cancel_job、get_artifact。
MCP 可以作为适配入口，但不取代常驻服务。CLI、网页和 agent 共用该服务。

首条验收：自然语言提出设备和时间范围后，产生真实导出任务，完成后返回可播放文件及实际覆盖范围；会话不可用时准确进入登录流程。

实现进度见根目录 [README](../README.md) 的 Issues 表。
