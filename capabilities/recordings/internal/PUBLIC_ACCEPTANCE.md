# 正式 HTTP playback 验收（维护者内部入口）

固定入口 `public-playback-acceptance.cjs --run-public-speed1` 在一个进程内
restore 已有私有 session，自动唯一选择当前 Drive Way/T8600/T8030 及动态 channel，
用两个12小时只读查询选择最近24小时内最新、完整留存、UTC分钟对齐的60秒。
同一天/分钟对齐来自现有公开窗口契约；工具不改变它，也不需要 root 填 serial、scope、
channel、路径、controls、窗口或 opaque ID。

选择连接确认关闭后，host 在随机 loopback 端口建立真正的
`interface/server.cjs`。临时 repository 是原记录的内存副本，只加这个精确 scope 的
speed1 bootstrap。所有控制都通过原正式 HTTP endpoints：create→pause→等待6秒→
GET仍paused且无推进→resume有新媒体→finally close。测试服务使用独立的临时空jobs目录，
不会恢复已有export任务；它与3190不得同时持有P2P。原生产模块/routes没有验收开关或绕过。

`createServer.start()`会再次restore；host已为选择片段restore一次，因此在该已恢复session
上直接listen，结束时await原server.shutdown并关闭listener。正常关闭不调用logout，
不会主动删除私有session。已有restore失败行为会移除无效session，root的备份/finally仍必要。

## 离线预检（本轮可运行）

```powershell
Set-Location -LiteralPath 'C:\Project\eufy-agent-hub-delivery-20260912\issue-9\worktree'
node --test --test-timeout=15000 capabilities/recordings/internal/public-playback-acceptance.test.cjs capabilities/recordings/internal/public-playback-handoff.test.cjs
node capabilities/recordings/internal/public-playback-acceptance.cjs --dry-run
```

dry-run只使用内置fake设备/会话与模拟6秒时钟，通过自身随机loopback HTTP端口运行真实
routes和PlaybackSessions。它不读取任何真实env路径、不登录、不连接硬件、不写正式验证
或证据文件；只在ignored output下建立并清理空jobs临时目录。原真实adapter的6秒暂停与
15秒首媒体timer另有驻留单元测试。`recorded:false`明确表示dry-run没有持久验证写入。

## 真实切换（仅 root，在新鲜审查后执行）

脚本从3190唯一listener动态取得owner PID，不使用历史PID。先把 `EUFY_SESSION_PATH` 设置成3190正在使用的同一私有session
绝对路径；不要打印其内容。其余路径由下面脚本固定生成。root应先清空活动任务，并在
预检及切换期间阻止新任务提交、手机App或另一个P2P owner。host不管理Windows进程，
不访问3190/3187，不重新登录，不重试，不运行2/4/8/16或其他peer控制。
停止前还核对该PID的 `Win32_Process.CommandLine`：必须直接启动当前 `$taskServerEntry`
绝对路径；不同脚本、wrapper或缺失命令行均停止流程，不仅按node进程名判断。

```powershell
$taskWorktree = 'C:\Project\eufy-agent-hub-delivery-20260912\issue-9\worktree'
$taskServerRoot = 'C:\Project\eufy-agent-hub-delivery-20260912\issue-9\hardware-service'
$taskServerEntry = Join-Path $taskWorktree 'interface\server.cjs'
$taskCapabilityRecords = Join-Path $taskServerRoot 'device-verification.json'
$taskEvidence = 'C:\Project\eufy-agent-hub-delivery-20260912\issue-9\evidence'
$taskNode = (Get-Command node -ErrorAction Stop).Source
if (-not $env:EUFY_SESSION_PATH) { throw 'Set EUFY_SESSION_PATH to the existing 3190 session file first.' }
$taskSession = (Resolve-Path -LiteralPath $env:EUFY_SESSION_PATH -ErrorAction Stop).Path
$taskRunId = [guid]::NewGuid().ToString('N')
$taskBackup = Join-Path $taskEvidence ('issue9-public-speed1-session-backup-' + $taskRunId + '.private.json')
if (Test-Path -LiteralPath $taskBackup) { throw 'Use a fresh private backup filename.' }

$taskBeforeSession = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3190/api/v1/session' -TimeoutSec 10 -ErrorAction Stop
if ($taskBeforeSession.authenticated -ne $true -or $taskBeforeSession.phase -ne 'connected' -or $taskBeforeSession.busy -ne $false) {
    throw '3190 must have an authenticated, connected, idle session with no queued/running exporter.'
}
$taskBeforeRecordings = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3190/recordings/status' -TimeoutSec 10 -ErrorAction Stop
if ($taskBeforeRecordings.busy -ne $false) { throw 'The legacy recording service must be idle.' }
$taskListener = @(Get-NetTCPConnection -LocalPort 3190 -State Listen -ErrorAction SilentlyContinue)
if ($taskListener.Count -ne 1) { throw '3190 must have exactly one listening owner.' }
$taskServerPid = $taskListener[0].OwningProcess
$taskServer = Get-Process -Id $taskServerPid -ErrorAction Stop
if ($taskServer.ProcessName -ne 'node') { throw 'The original server process must be checked again.' }
$taskProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $taskServerPid" -ErrorAction Stop
$taskEntryPattern = [regex]::Escape($taskServerEntry)
$taskCommandPattern = '^\s*(?:"[^"]+"|\S+)\s+(?:"' + $taskEntryPattern + '"|' + $taskEntryPattern + ')\s*$'
if (-not $taskProcess -or $taskProcess.CommandLine -notmatch $taskCommandPattern) { throw 'The listening process must use the expected server entry.' }
try {
    Stop-Process -Id $taskServerPid -Force -ErrorAction Stop
    Wait-Process -Id $taskServerPid -Timeout 30 -ErrorAction SilentlyContinue
    if (Get-Process -Id $taskServerPid -ErrorAction SilentlyContinue) { throw 'The original server has not stopped.' }
    if (Get-NetTCPConnection -LocalPort 3190 -State Listen -ErrorAction SilentlyContinue) { throw '3190 is still listening.' }
    Copy-Item -LiteralPath $taskSession -Destination $taskBackup -ErrorAction Stop
    $env:EUFY_SESSION_PATH = $taskSession
    $env:EUFY_CAPABILITY_RECORDS_PATH = $taskCapabilityRecords
    $env:ISSUE9_PROBE_EVIDENCE_PATH = Join-Path $taskEvidence ('hardware-public-speed1-' + $taskRunId + '.json')
    Set-Location -LiteralPath $taskWorktree
    & $taskNode capabilities/recordings/internal/public-playback-acceptance.cjs --run-public-speed1
    $taskProbeExit = $LASTEXITCODE
} finally {
    if (-not (Test-Path -LiteralPath $taskSession)) {
        Copy-Item -LiteralPath $taskBackup -Destination $taskSession -ErrorAction Stop
    }
    if (Get-NetTCPConnection -LocalPort 3190 -State Listen -ErrorAction SilentlyContinue) { throw 'Unexpected 3190 owner; do not start another.' }
    $env:EUFY_SESSION_PATH = $taskSession
    $env:EUFY_CAPABILITY_RECORDS_PATH = $taskCapabilityRecords
    $env:EUFY_PORT = '3190'
    $taskRestart = Start-Process -FilePath $taskNode -ArgumentList $taskServerEntry -WorkingDirectory $taskServerRoot -WindowStyle Hidden -PassThru
    $taskDeadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 250
        $taskReady = @(Get-NetTCPConnection -LocalPort 3190 -State Listen -ErrorAction SilentlyContinue)
    } until ($taskReady.Count -gt 0 -or (Get-Date) -ge $taskDeadline -or $taskRestart.HasExited)
    if ($taskReady.Count -ne 1 -or $taskReady[0].OwningProcess -ne $taskRestart.Id) { throw '3190 did not restart under the expected owner.' }
    $taskRestoredSession = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3190/api/v1/session' -TimeoutSec 10 -ErrorAction Stop
    if ($taskRestoredSession.authenticated -ne $true -or $taskRestoredSession.phase -ne 'connected' -or $taskRestoredSession.busy -ne $false) {
        throw '3190 restored session is not authenticated, connected and idle.'
    }
    $taskRestoredRecordings = Invoke-RestMethod -Method Get -Uri 'http://127.0.0.1:3190/recordings/status' -TimeoutSec 10 -ErrorAction Stop
    if ($taskRestoredRecordings.busy -ne $false) { throw 'The restored legacy service is not idle.' }
}
if ($taskProbeExit -ne 0) { throw 'The public playback acceptance failed; 3190 has been restored.' }
```

新GUID备份和结果不覆盖之前任何文件。停止后的备份也位于try/finally内；备份失败、host
启动异常、非零退出均先恢复并健康检查3190，再传播失败。保留原媒体环境变量。这个脚本
没有修改dirty checkout或3187；`Stop-Process -Force`仅用于已核对且空闲、无控制终端的owner。

## 验证写入与证据边界

只有start/pause/resume/stop四次关联返回0、实际媒体推进、6秒quiet pause、同一owner确认
关闭及test server关闭都成功，才写正式record。临时bootstrap从未进入磁盘；失败不留下
临时verified提升。scratch关闭和脱敏证据落盘都在最终record之前完成；最后调用既有
`DeviceVerificationRepository.record()`，沿用同目录唯一临时文件、flush、rename的原子路径，
保留其他capability和其他scope。没有新增公共evidence-write路由。

证据文件只描述这次HTTP观察，`verificationWrite: separate_following_atomic_step`说明
持久record是随后独立的最后一步。stdout的 `recorded:true`及exit0才说明record写入完成；
若record写失败，stdout/退出明确失败，已有HTTP证据仍可保留为completed，不把磁盘错误
说成设备失败。没有再写一个会导致“record已晋级、尾部写文件失败”的验证状态文件。

本次HTTP只实测speed1，成功后的typed allowlist严格为 `[1]`，只引用本次正式验收证据。
历史4/16虽有已完成的内部观察，但artifact缺camera与HomeBase serial，不能绑定完整
设备scope；相同型号、固件和channel不证明同一设备。2同样缺独立完整scope证据。这些
历史结果均不作为本host的授权或晋级依据，8仍completion unconfirmed；它们均不能称
unsupported。公共2/4/16的start/close仍需另行取得完整scope的typed验证记录，本host不
创建这种记录，也不开放这些速度下的pause/resume。

输出只包含固定状态/错误、模型/固件/channel、命令返回及墙钟、实际媒体时间、窗口和匹配
计数，不保存serial、账号、IP、路径、payload、raw session或媒体。`channelIsolation`始终
unverified；本次没有peer操作，历史peer只读range仍不是playback-isolation proof。30秒
公开pause租期和15秒首媒体预算保持不变，6秒验收不是无限暂停或UI呈现倍率证明。
