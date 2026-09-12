const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('internal README directs hardware acceptance only to the public flow and keeps historical hosts offline', () => {
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  assert.match(readme, /\[PUBLIC_ACCEPTANCE\.md\]\(PUBLIC_ACCEPTANCE\.md\)/);
  assert.doesNotMatch(readme, /\b(?:12372|34340|26364|48296)\b|尚未观察/);
  assert.doesNotMatch(readme, /PID\s*\d+/);
  const runbook = fs.readFileSync(path.join(__dirname, 'PUBLIC_ACCEPTANCE.md'), 'utf8');
  assert.doesNotMatch(runbook, /PID\s*\d+|-Id\s+\d+|OwningProcess\s+-ne\s+\d+/);
  assert.doesNotMatch(readme, /Stop-Process|Start-Process|Invoke-RestMethod|--run\b|--resume-speed/);
  assert.match(readme, /1\/2\/4\/16.*历史内部观察/);
  assert.match(readme, /8.*unconfirmed/);
  assert.match(readme, /不授权公开controls/);
  const blocks = [...readme.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map(row => row[1]);
  assert.ok(blocks.length);
  for (const line of blocks.join('\n').split(/\r?\n/).filter(row => /^node\s/.test(row)))
    assert.match(line, /--test\b|--dry-run\b/, 'README commands must stay offline');
});

function handoff(scenario, ownerPid = 13579) {
  const doc = fs.readFileSync(path.join(__dirname, 'PUBLIC_ACCEPTANCE.md'), 'utf8');
  const script = [...doc.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map(row => row[1]).find(row => row.includes('$taskWorktree ='));
  assert.ok(script);
  const harness = `
    $ErrorActionPreference = 'Stop'
    $script:scenario = '${scenario}'; $script:stopped = $false; $script:started = $false; $script:hostRan = $false
    $script:ownerPid = ${ownerPid}; $script:waitId = $null; $script:checkedIds = @(); $script:commandLineFilter = $null
    $script:sessionReads = 0; $script:legacyReads = 0; $script:launch = $null; $script:backup = $null
    $script:hostArgs = @(); $script:stopId = $null; $script:evidence = $null; $script:hostRecords = $null
    $env:EUFY_SESSION_PATH = 'C:\\fixture\\session.private.json'
    function Get-Command { [pscustomobject]@{ Source = 'Invoke-FakeNode' } }
    function Resolve-Path { param($LiteralPath) [pscustomobject]@{ Path = $LiteralPath } }
    function Test-Path { param($LiteralPath) ($LiteralPath -eq 'C:\\fixture\\session.private.json') -or ($script:scenario -eq 'backup_exists') }
    function Copy-Item { param($LiteralPath, $Destination) $script:backup = $Destination; if ($script:scenario -eq 'backup_failure') { throw 'Synthetic backup failure' } }
    function Set-Location { }; function Start-Sleep { }
    function Wait-Process { param($Id) $script:waitId = $Id }
    function Get-NetTCPConnection {
      if ($script:started) { [pscustomobject]@{ OwningProcess = 24680 } }
      elseif (-not $script:stopped -and $script:scenario -ne 'no_listener') {
        if ($script:scenario -eq 'multiple_listeners') { [pscustomobject]@{ OwningProcess = $script:ownerPid } }
        [pscustomobject]@{ OwningProcess = $script:ownerPid }
      }
    }
    function Get-Process {
      param($Id) $script:checkedIds += $Id
      if (-not $script:stopped) { [pscustomobject]@{ ProcessName = $(if ($script:scenario -eq 'not_node') { 'other' } else { 'node' }) } }
    }
    function Get-CimInstance {
      param($ClassName, $Filter) $script:commandLineFilter = $Filter
      if ($ClassName -ne 'Win32_Process') { throw 'Unexpected process query' }
      if ($script:scenario -eq 'missing_process') { return $null }
      $fixtureEntry = 'C:\\Project\\eufy-agent-hub-delivery-20260912\\issue-9\\worktree\\interface\\server.cjs'
      if ($script:scenario -eq 'wrong_entry') { $fixtureEntry = 'C:\\fixture\\interface\\server.cjs' }
      $fixtureCommand = '"C:\\Program Files\\nodejs\\node.exe" ' + $(if ($script:ownerPid -eq 97531) { $fixtureEntry } else { '"' + $fixtureEntry + '"' })
      if ($script:scenario -eq 'wrapper_entry') { $fixtureCommand = 'node C:\\fixture\\wrapper.cjs "' + $fixtureEntry + '"' }
      [pscustomobject]@{ CommandLine = $fixtureCommand }
    }
    function Stop-Process { param($Id) $script:stopId = $Id; $script:stopped = $true }
    function Invoke-FakeNode {
      $script:hostRan = $true; $script:hostArgs = @($args); $script:evidence = $env:ISSUE9_PROBE_EVIDENCE_PATH
      $script:hostRecords = $env:EUFY_CAPABILITY_RECORDS_PATH
      if ($script:scenario -eq 'host_throw') { throw 'Synthetic startup failure' }
      $global:LASTEXITCODE = $(if ($script:scenario -eq 'host_nonzero') { 1 } else { 0 })
    }
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
      $script:started = $true; $script:launch = @{ entry = $ArgumentList; directory = $WorkingDirectory; style = $WindowStyle
        session = $env:EUFY_SESSION_PATH; records = $env:EUFY_CAPABILITY_RECORDS_PATH; port = $env:EUFY_PORT }
      [pscustomobject]@{ Id = 24680; HasExited = $false }
    }
    function Invoke-RestMethod {
      param($Uri, $Method, $TimeoutSec)
      if ($Uri -eq 'http://127.0.0.1:3190/api/v1/session') {
        $script:sessionReads++
        return [pscustomobject]@{ authenticated = ($script:scenario -ne 'unauthenticated'); busy = ($script:scenario -eq 'export_busy')
          phase = $(if ($script:scenario -eq 'disconnected' -or ($script:scenario -eq 'restart_invalid' -and $script:started)) { 'login_required' } else { 'connected' }) }
      }
      if ($Uri -eq 'http://127.0.0.1:3190/recordings/status') { $script:legacyReads++; return [pscustomobject]@{ busy = ($script:scenario -eq 'legacy_busy') } }
      throw 'Unexpected URL'
    }
    $failed = $false
    try { & { ${script} } } catch { $failed = $true }
    @{ failed = $failed; stopped = $script:stopped; hostRan = $script:hostRan; launch = $script:launch; hostArgs = $script:hostArgs
      sessionReads = $script:sessionReads; legacyReads = $script:legacyReads; backup = $script:backup; evidence = $script:evidence
      stopId = $script:stopId; waitId = $script:waitId; checkedIds = $script:checkedIds; commandLineFilter = $script:commandLineFilter; hostRecords = $script:hostRecords } | ConvertTo-Json -Depth 4 -Compress
  `;
  const child = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}

for (const ownerPid of [13579, 97531]) test(`formal HTTP handoff uses dynamically observed PID ${ownerPid} for validation, stop and wait`, { skip: process.platform !== 'win32' }, () => {
  const result = handoff('idle', ownerPid); assert.equal(result.failed, false); assert.equal(result.stopId, ownerPid);
  assert.equal(result.waitId, ownerPid); assert.deepEqual(result.checkedIds, [ownerPid, ownerPid]);
  assert.equal(result.commandLineFilter, `ProcessId = ${ownerPid}`);
  assert.deepEqual(result.hostArgs, ['capabilities/recordings/internal/public-playback-acceptance.cjs', '--run-public-speed1']);
  assert.match(result.backup, /issue9-public-speed1-session-backup-[a-f0-9]{32}\.private\.json$/);
  assert.match(result.evidence, /hardware-public-speed1-[a-f0-9]{32}\.json$/);
  assert.equal(result.sessionReads, 2); assert.equal(result.legacyReads, 2);
  const root = 'C:\\Project\\eufy-agent-hub-delivery-20260912\\issue-9';
  assert.deepEqual(result.launch, { entry: root + '\\worktree\\interface\\server.cjs', directory: root + '\\hardware-service', style: 'Hidden',
    session: 'C:\\fixture\\session.private.json', records: root + '\\hardware-service\\device-verification.json', port: '3190' });
  assert.equal(result.hostRecords, result.launch.records);
});
for (const scenario of ['unauthenticated', 'disconnected', 'export_busy', 'legacy_busy', 'not_node', 'no_listener', 'multiple_listeners', 'backup_exists', 'wrong_entry', 'wrapper_entry', 'missing_process'])
  test(`formal HTTP handoff does not stop an unready owner: ${scenario}`, { skip: process.platform !== 'win32' }, () => {
    const result = handoff(scenario); assert.equal(result.failed, true); assert.equal(result.stopped, false); assert.equal(result.hostRan, false);
  });
for (const scenario of ['backup_failure', 'host_nonzero', 'host_throw', 'restart_invalid'])
  test(`formal HTTP handoff restores before propagating failure: ${scenario}`, { skip: process.platform !== 'win32' }, () => {
    const result = handoff(scenario); assert.equal(result.failed, true); assert.ok(result.launch); assert.equal(result.sessionReads, 2);
    assert.equal(result.hostRan, scenario !== 'backup_failure');
  });
