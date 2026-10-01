[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $PackageRoot).Path
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$node = Join-Path $root 'runtime\node\node.exe'
$python = Join-Path $root 'runtime\python\python.exe'
$ffmpeg = Join-Path $root 'runtime\ffmpeg\ffmpeg.exe'
foreach ($file in @($node,$python,$ffmpeg,(Join-Path $root 'interface\app-dist\index.html'))) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing packaged file: $file" } }
$bytecode = @(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.Name -eq '__pycache__' -or $_.Extension -eq '.pyc' })
if ($bytecode) { throw "Python bytecode/cache is forbidden in the package: $($bytecode[0].FullName)" }
$forbidden = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
  $relative = $_.FullName.Substring($root.Length + 1).Replace('\','/')
  $relative -notmatch '(^|/)node_modules/' -and ($relative -match '(^|/)(fixtures?|internal)(/|$)' -or $relative -match '\.test\.')
})
if ($forbidden) { throw "Test, fixture, or internal file is forbidden in the package: $($forbidden[0].FullName)" }
$textExtensions = @('.cjs','.mjs','.js','.json','.py','.cmd','.ps1','.md','.html','.css','.map','.txt','.ts','.tsx')
$developerPath = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() } |
  Select-String -Pattern $sourceRoot -SimpleMatch -List | Select-Object -First 1
if ($developerPath) { throw "Developer path is forbidden in the package: $($developerPath.Path)" }
& $python -B -c "import av; assert av.__version__ == '18.1.0'; print(av.__version__)"
if ($LASTEXITCODE) { throw 'Bundled Python/PyAV probe failed.' }
$formats = (& $ffmpeg -hide_banner -formats 2>&1 | Out-String)
$codecs = (& $ffmpeg -hide_banner -codecs 2>&1 | Out-String)
$filters = (& $ffmpeg -hide_banner -filters 2>&1 | Out-String)
foreach ($required in @(' h264 ',' hevc ',' aac ',' libx264 ',' mjpeg ')) { if (-not $codecs.Contains($required)) { throw "Required codec missing: $required" } }
foreach ($required in @(' mp4 ',' mpegts ',' image2pipe ')) { if (-not $formats.Contains($required)) { throw "Required format missing: $required" } }
foreach ($required in @(' scale ',' pad ',' fps ',' format ')) { if (-not $filters.Contains($required)) { throw "Required filter missing: $required" } }
$media = Join-Path ([IO.Path]::GetTempPath()) "eufy-package-accept-$PID"
$started = $false
New-Item -ItemType Directory -Path $media | Out-Null
try {
  & $ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=10 -t 1 -c:v libx264 -pix_fmt yuv420p (Join-Path $media 'h264.mp4')
  if ($LASTEXITCODE) { throw 'H.264 fixture encode failed.' }
  & $ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x240:rate=10 -t 1 -c:v libx265 -pix_fmt yuv420p (Join-Path $media 'hevc.mp4')
  if ($LASTEXITCODE) { throw 'HEVC fixture encode failed.' }
  & $ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=1000 -t 1 -c:a aac (Join-Path $media 'aac.m4a')
  if ($LASTEXITCODE) { throw 'AAC fixture encode failed.' }
  foreach ($codec in @('h264','hevc')) { & $ffmpeg -hide_banner -loglevel error -i (Join-Path $media "$codec.mp4") -frames:v 1 -c:v mjpeg (Join-Path $media "$codec.jpg"); if ($LASTEXITCODE) { throw "$codec preview JPEG failed." } }
  & $ffmpeg -hide_banner -loglevel error -i (Join-Path $media 'h264.mp4') -i (Join-Path $media 'aac.m4a') -c:v copy -c:a aac (Join-Path $media 'export.mp4')
  if ($LASTEXITCODE) { throw 'AAC MP4 export failed.' }
  & $ffmpeg -hide_banner -loglevel error -xerror -i (Join-Path $media 'export.mp4') -f null -
  if ($LASTEXITCODE) { throw 'Full MP4 decode failed.' }
  $env:LOCALAPPDATA = Join-Path $media 'local'; $env:EUFY_NO_BROWSER = '1'; $env:PATH = "$env:SystemRoot\System32"
  $env:EUFY_PYTHON = $python; $env:EUFY_FFMPEG = $ffmpeg; $env:EUFY_MEDIA_TEST_ROOT = $media; $env:EUFY_PACKAGE_ROOT = $root
  & $node --test (Join-Path $PSScriptRoot 'import-verification.test.cjs')
  if ($LASTEXITCODE) { throw 'Packaged verification import fixture failed.' }
  & $node --test (Join-Path $PSScriptRoot '..\..\capabilities\recordings\continuous-export-media.test.cjs')
  if ($LASTEXITCODE) { throw 'Packaged continuous export fixture failed.' }
  & $node (Join-Path $PSScriptRoot 'package-http-fixture.cjs') $root
  if ($LASTEXITCODE) { throw 'Packaged offline resident HTTP fixture failed.' }
  $portFree = -not (Get-NetTCPConnection -LocalPort 3187 -State Listen -ErrorAction SilentlyContinue)
  if ($portFree) {
    & $node (Join-Path $root 'scripts\release\launcher.cjs') start
    if ($LASTEXITCODE) { throw 'Packaged fixed-port launcher failed.' }
    $started = $true
    & $node (Join-Path $root 'scripts\release\launcher.cjs') stop
    if ($LASTEXITCODE) { throw 'Packaged graceful stop failed.' }
    $started = $false
  } else { Write-Warning 'Fixed-port launcher acceptance NOT_RUN: port 3187 is already occupied; the existing listener was not accessed or stopped.' }
  Write-Host 'OFFLINE_FIXTURE_SUBSET_PASS: bundled runtimes, synthetic media probes, preview JPEGs, AAC MP4 full decode, resident HTTP endpoints, and the React static shell.'
  Write-Warning 'AC-4 NOT_RUN: packaged Chromium/Edge browser playback was not exercised. This run did not play a resident MP4 or exercise exact-scope historical playback controls.'
} finally {
  if ($started) { try { & $node (Join-Path $root 'scripts\release\launcher.cjs') stop | Out-Null } catch {} }
  if (Test-Path -LiteralPath $media) { Remove-Item -LiteralPath $media -Recurse -Force }
}
