# 后台任务（待实现）

当前 legacy API 只有单进程内存中的 busy 状态，不具备持久化任务、jobId、重启恢复或取消接口。本目录没有可运行的任务服务。

后续服务应管理 queued/running/validating/completed/failed/cancelled 状态，以及录像接收、封装转换、解码校验三个阶段。
同一 HomeBase 的媒体操作由服务排队；重复 requestId 返回同一任务。重启后如无法安全续传，应明确标记中断并提供显式重试，不能静默重复导出。

完成结果记录请求范围、实际首尾帧、覆盖是否已验证、文件地址及校验结果。终端或 agent 轮次结束不应停止后台任务。

实现进度见根目录 [README](../README.md) 的 Issues 表。
