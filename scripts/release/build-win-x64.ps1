[CmdletBinding()]
param([switch]$AllowDirty)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$buildRoot = Join-Path $repo 'build\release'
$cache = Join-Path $buildRoot 'cache'
$inputs = Get-Content (Join-Path $PSScriptRoot 'release-inputs.json') -Raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$name = "eufy-agent-hub-win-x64-$version"
$stage = Join-Path $buildRoot $name
$zip = Join-Path $buildRoot "$name.zip"

if (-not $AllowDirty -and (git -C $repo status --porcelain)) {
  throw 'Build requires a clean checkout. Use -AllowDirty only for local private evaluation.'
}
function Reset-BuildDirectory([string]$target) {
  $full = [IO.Path]::GetFullPath($target)
  if (-not $full.StartsWith([IO.Path]::GetFullPath($buildRoot) + [IO.Path]::DirectorySeparatorChar)) { throw "Refusing to clear $full" }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
  New-Item -ItemType Directory -Path $full | Out-Null
}
function Download-Verified($component) {
  $file = Join-Path $cache ([IO.Path]::GetFileName($component.url))
  if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -UseBasicParsing $component.url -OutFile $file }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $component.sha256) { throw "SHA-256 mismatch for $($component.url): $actual" }
  return $file
}
function Invoke-Npm([string[]]$Arguments, [string]$Stage) {
  & npm @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Stage failed with exit code $LASTEXITCODE." }
}
function Copy-ControlledFile([string]$relative) {
  $source = Join-Path $repo $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing controlled runtime file: $relative" }
  $destination = Join-Path $stage $relative
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}

New-Item -ItemType Directory -Path $cache -Force | Out-Null
$nodeZip = Download-Verified $inputs.components.node
$pythonZip = Download-Verified $inputs.components.python
$pyavWheel = Download-Verified $inputs.components.pyav
$ffmpegZip = Download-Verified $inputs.components.ffmpeg

Push-Location $repo
try {
  foreach ($output in @('interface\app-dist','vendor\eufy-security-client\build')) {
    $path = Join-Path $repo $output
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
  Invoke-Npm -Arguments @('ci') -Stage 'Root npm ci'
  Invoke-Npm -Arguments @('run','setup') -Stage 'Vendor npm ci'
  Invoke-Npm -Arguments @('run','build') -Stage 'Production build'
} finally { Pop-Location }
foreach ($output in @('interface\app-dist\index.html','vendor\eufy-security-client\build')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repo $output))) { throw "Production build did not create $output" }
}

Reset-BuildDirectory $stage
foreach ($file in @(
  'adapters\eufy\index.cjs','adapters\eufy\package.json',
  'agent\runtime.cjs','agent\tools.cjs',
  'api\legacy-recording-routes.cjs','api\messages.cjs','api\v1-contract.cjs','api\v1-routes.cjs',
  'capabilities\auth\session.cjs',
  'capabilities\devices\capabilities.cjs','capabilities\devices\continuous-mapping.cjs','capabilities\devices\discovery.cjs',
  'capabilities\devices\index.cjs','capabilities\devices\recording-support.cjs','capabilities\devices\schemas.cjs','capabilities\devices\verification-store.cjs',
  'capabilities\live\connection.cjs','capabilities\live\decoder.cjs','capabilities\live\session.cjs',
  'capabilities\recordings\continuous-completeness.cjs','capabilities\recordings\continuous-export.cjs','capabilities\recordings\continuous.cjs',
  'capabilities\recordings\events.cjs','capabilities\recordings\export.cjs','capabilities\recordings\media-timeline.py',
  'capabilities\recordings\mux.py','capabilities\recordings\playback-session.cjs','capabilities\recordings\time-window.cjs',
  'interface\agent\http.cjs','interface\agent\sidebar.mjs','interface\components\results.mjs',
  'interface\i18n\i18n.mjs','interface\i18n\service.en.json','interface\i18n\service.zh-CN.json',
  'interface\i18n\ui.en.json','interface\i18n\ui.zh-CN.json','interface\pages\local-login.html','interface\pages\local-login.mjs',
  'interface\server.cjs','interface\workspace\contract.mjs','interface\workspace\workspace.mjs','jobs\service.cjs'
)) {
  Copy-ControlledFile $file
}
New-Item -ItemType Directory -Path (Join-Path $stage 'scripts\release') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'scripts\release\launcher.cjs'),(Join-Path $repo 'scripts\release\import-verification.cjs') -Destination (Join-Path $stage 'scripts\release')
Copy-Item -LiteralPath (Join-Path $repo 'Start.cmd'),(Join-Path $repo 'Stop.cmd'),(Join-Path $repo 'Import-Verification.cmd'),(Join-Path $repo 'package.json'),(Join-Path $repo 'package-lock.json'),(Join-Path $repo 'LICENSE'),(Join-Path $repo 'THIRD_PARTY_NOTICES.md') -Destination $stage
New-Item -ItemType Directory -Path (Join-Path $stage 'interface') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'interface\app-dist') -Destination (Join-Path $stage 'interface') -Recurse

Push-Location $stage
try { Invoke-Npm -Arguments @('ci','--omit=dev','--ignore-scripts') -Stage 'Production root npm ci' } finally { Pop-Location }
New-Item -ItemType Directory -Path (Join-Path $stage 'vendor\eufy-security-client') -Force | Out-Null
foreach ($entry in @('build','package.json','package-lock.json','LICENSE','PROVENANCE.md')) {
  Copy-Item -LiteralPath (Join-Path $repo "vendor\eufy-security-client\$entry") -Destination (Join-Path $stage 'vendor\eufy-security-client') -Recurse
}
Push-Location (Join-Path $stage 'vendor\eufy-security-client')
try { Invoke-Npm -Arguments @('ci','--omit=dev','--ignore-scripts') -Stage 'Production vendor npm ci' } finally { Pop-Location }

$scratch = Join-Path $buildRoot 'scratch'
Reset-BuildDirectory $scratch
Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $scratch 'node')
$nodeRoot = Get-ChildItem (Join-Path $scratch 'node') -Directory | Select-Object -First 1
New-Item -ItemType Directory -Path (Join-Path $stage 'runtime\node') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $nodeRoot.FullName 'node.exe'),(Join-Path $nodeRoot.FullName 'LICENSE') -Destination (Join-Path $stage 'runtime\node')

New-Item -ItemType Directory -Path (Join-Path $stage 'runtime\python') -Force | Out-Null
Expand-Archive -LiteralPath $pythonZip -DestinationPath (Join-Path $stage 'runtime\python')
$wheelZip = Join-Path $scratch 'pyav.zip'; Copy-Item -LiteralPath $pyavWheel -Destination $wheelZip
Expand-Archive -LiteralPath $wheelZip -DestinationPath (Join-Path $stage 'runtime\python')

Expand-Archive -LiteralPath $ffmpegZip -DestinationPath (Join-Path $scratch 'ffmpeg')
$ffmpegRoot = Get-ChildItem (Join-Path $scratch 'ffmpeg') -Directory | Select-Object -First 1
New-Item -ItemType Directory -Path (Join-Path $stage 'runtime\ffmpeg') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ffmpegRoot.FullName 'bin\ffmpeg.exe'),(Join-Path $ffmpegRoot.FullName 'LICENSE'),(Join-Path $ffmpegRoot.FullName 'README.txt') -Destination (Join-Path $stage 'runtime\ffmpeg')

$previousErrorActionPreference = $ErrorActionPreference
try {
  # FFmpeg writes its banner to stderr even on success. Windows PowerShell turns
  # redirected native stderr into error records, so capture it without Stop.
  $ErrorActionPreference = 'Continue'
  $ffmpegVersion = & (Join-Path $stage 'runtime\ffmpeg\ffmpeg.exe') -version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Bundled FFmpeg version probe failed with exit code $LASTEXITCODE." }
  $ffmpegLicense = & (Join-Path $stage 'runtime\ffmpeg\ffmpeg.exe') -L 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "Bundled FFmpeg license probe failed with exit code $LASTEXITCODE." }
} finally { $ErrorActionPreference = $previousErrorActionPreference }
$pythonInfo = & (Join-Path $stage 'runtime\python\python.exe') -B -c "import av,json;print(json.dumps({'version':av.__version__,'libraries':av.library_versions},sort_keys=True))"
if ($LASTEXITCODE -ne 0) { throw "Bundled Python/PyAV probe failed with exit code $LASTEXITCODE." }
$npmComponents = Get-ChildItem -LiteralPath $stage -Filter package.json -Recurse -File | Where-Object { $_.FullName -match '[\\/]node_modules[\\/]' } | ForEach-Object {
  try { $package = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json; if ($package.name -and $package.version) {
    [ordered]@{ name = $package.name; version = $package.version; license = $package.license; path = $_.Directory.FullName.Substring($stage.Length + 1).Replace('\','/') }
  }} catch {}
} | Sort-Object name,version,path
$windowsReadme = Join-Path $stage 'README-WINDOWS.md'
Copy-Item -LiteralPath (Join-Path $repo 'docs\WINDOWS_RELEASE.md') -Destination $windowsReadme
$bytecodeDirectories = @(Get-ChildItem -LiteralPath $stage -Recurse -Directory -Filter '__pycache__')
foreach ($directory in $bytecodeDirectories) { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.pyc' | Remove-Item -Force
$forbidden = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
  $relative = $_.FullName.Substring($stage.Length + 1).Replace('\','/')
  $relative -notmatch '(^|/)node_modules/' -and ($relative -match '(^|/)(fixtures?|internal)(/|$)' -or $relative -match '\.test\.')
})
if ($forbidden) { throw "Forbidden test, fixture, or internal file staged: $($forbidden[0].FullName)" }
$textExtensions = @('.cjs','.mjs','.js','.json','.py','.cmd','.ps1','.md','.html','.css','.map','.txt','.ts','.tsx')
$developerPath = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() } |
  Select-String -SimpleMatch -Pattern $repo -List | Select-Object -First 1
if ($developerPath) { throw "Developer checkout path staged in $($developerPath.Path)" }
$sourceDirty = [bool](git -C $repo status --porcelain)
$files = Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\','/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{
  schemaVersion = 1; application = 'eufy-agent-hub'; version = $version; target = 'win-x64'
  sourceCommit = (git -C $repo rev-parse HEAD); sourceDirty = $sourceDirty
  generatedAt = (Get-Date).ToUniversalTime().ToString('o'); inputs = $inputs.components
  publicationGate = $inputs.publicationGate; ffmpegVersion = $ffmpegVersion.Trim(); ffmpegLicense = $ffmpegLicense.Trim()
  pyav = ($pythonInfo | ConvertFrom-Json); npmComponents = $npmComponents; files = $files
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding utf8

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zip.sha256" -Value "$zipHash  $name.zip" -Encoding ascii
Write-Host "Private evaluation package: $zip"
Write-Warning $inputs.publicationGate.reason
