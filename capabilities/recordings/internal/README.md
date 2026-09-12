# Issue #9 内部验收与离线测试

1/2/4/16 均已有历史内部观察，8 保持 completion unconfirmed；这些历史结果全都不授权公开controls。
4/16 的旧artifact缺camera与HomeBase serial，2同样缺独立完整scope证据。缺少验证不能称为
unsupported，接收墙钟上的媒体传输率也不等同App UI倍率。

当前唯一可执行硬件验收入口是 [PUBLIC_ACCEPTANCE.md](PUBLIC_ACCEPTANCE.md) 的
public speed1流程。它从唯一3190 listener动态取得owner，核对进程及启动脚本，并完成空闲检查、GUID备份、正式HTTP验收、
finally恢复及健康检查的完整交接。成功后仅为本次完整scope记录speed1 `[1]`。
现场执行只以该文档为准，本页不保留历史候选的实机命令或服务切换步骤。

`playback-controls-host.cjs` 和 `playback-controls-probe.cjs` 仅保留用于离线回归及历史观察
复核，不是现场runbook，也不是生产HTTP、UI、Agent或普通CLI功能。正式驻留API的验收
由上述public流程完成；不要用历史内部probe替代正式交付。

## 离线预检

```powershell
Set-Location -LiteralPath 'C:\Project\eufy-agent-hub-delivery-20260912\issue-9\worktree'
node --test --test-timeout=15000 capabilities/recordings/internal/playback-controls-probe.test.cjs capabilities/recordings/internal/playback-controls-host.test.cjs capabilities/recordings/internal/public-playback-acceptance.test.cjs capabilities/recordings/internal/public-playback-handoff.test.cjs
node capabilities/recordings/internal/playback-controls-host.cjs --dry-run
node capabilities/recordings/internal/public-playback-acceptance.cjs --dry-run
```

旧host的dry-run使用内置fake，不读取真实会话、不写实机证据、不打开端口或连接设备。
public host的dry-run使用fake设备和随机loopback HTTP端口，经过真实routes后关闭；不读取
真实会话，也不持久化verified记录。设置真实环境变量不会让这两个dry-run访问硬件。

## 历史观察的边界

普通pause/resume及候选1/2/4/16的内部completed结果保留；completed只描述各次关联回包、
媒体和stop观察。8收到返回0和视频，但未满足终点条件，保持unconfirmed，不触发重跑。
历史8的稀疏媒体时间戳既不证明UI倍率，也不提供放宽终点条件的依据。

历史输出中的目标command/media channel匹配仍受Node投影限制。既有peer只读range响应
属于有限历史观察，始终是 `not a playback-isolation proof`；它不授权操作peer，也不证明
isolation verified。当前public speed1验收不执行peer操作。
