[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $PackageRoot).Path
$node = Join-Path $root 'runtime\node\node.exe'
$python = Join-Path $root 'runtime\python\python.exe'
$ffmpeg = Join-Path $root 'runtime\ffmpeg\ffmpeg.exe'
foreach ($file in @($node,$python,$ffmpeg,(Join-Path $root 'interface\app-dist\index.html'))) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing packaged file: $file" } }
$env:EUFY_PACKAGE_ROOT = $root
$env:EUFY_PYTHON = $python
$env:EUFY_FFMPEG = $ffmpeg
$env:PATH = "$env:SystemRoot\System32"
& $node --test (Join-Path $PSScriptRoot 'ac4-browser.test.cjs')
if ($LASTEXITCODE) { throw 'Packaged event/continuous browser fixture failed.' }
& $node --test --test-name-pattern 'clearly disables historical preview|never recovers historical media|closes visible historical media|clears a saved playback after initial inventory settles|resolves request-only playback cleanup|waits for pending request-only playback|keeps same-scope playback through refresh|resolves a saved playback serial|fails closed when pause or resume|retains playback while refresh is pending|real FFmpeg playback reaches Chromium canvas|recovery rejects a playback scope' (Join-Path $PSScriptRoot '..\..\interface\react\browser.cjs')
if ($LASTEXITCODE) { throw 'Packaged exact-scope historical browser fixture failed.' }
Write-Host 'AC-4_OFFLINE_SYNTHETIC_PASS: packaged Node/Python/PyAV/FFmpeg and React assets served synthetic event/continuous MP4s to Chromium; exact-scope synthetic historical playback covered first frame, pause, resume, bounded seek, close, and explicit unverified state.'
Write-Warning 'Synthetic boundary: all device identities, firmware, verification evidence, P2P packets, event manifests, export jobs, and media were generated offline. Chromium was supplied by the Playwright acceptance environment, not bundled in the package.'
Write-Warning 'AC-6 NOT_RUN: no real device, credential, resident user session, or user media was accessed.'
