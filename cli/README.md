# CLI（待实现）

此目录预留给常驻服务的命令行客户端，目前没有 `eufy` 可执行命令。不会为每条命令重新登录或独立连接 HomeBase。

第一版命令范围：auth status/login、devices list/capabilities、recordings ranges/export、jobs get/cancel、artifacts get。
命令和 HTTP API 共享输入输出契约；`--json` 的 stdout 只输出结构化结果，进度写 stderr，失败使用稳定错误码和非零退出码。

长时导出立即返回 jobId，可选择等待；终端退出不取消服务中的任务。依赖版本化 API 和 jobs。

实现进度见根目录 [README](../README.md) 的 Issues 表。
