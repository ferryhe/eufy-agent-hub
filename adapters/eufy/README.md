# eufy 协议适配

`index.cjs` 是 capabilities 访问协议库的统一入口。已迁移的能力不依赖旧项目目录、全局调试对象或 Android 模拟器。

当前依赖 `vendor/eufy-security-client` 中有来源记录的 MIT 源码快照。保留快照是因为连续回放 6000/6001、事件查询数量与下载确认依赖尚未发布的本地改动，不能直接替换成同版本 npm 包。

构建：在仓库根运行 `npm run setup`、`npm run build`。详细来源见 [PROVENANCE.md](../../vendor/eufy-security-client/PROVENANCE.md)。

这里只提供迁移实际使用的类与枚举。已有上游设备控制方法不代表已作为本项目稳定能力开放；按型号整理能力矩阵后再扩充。
