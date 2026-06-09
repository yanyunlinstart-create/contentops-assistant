param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 })
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root ".feishu-server.pid"

if (!(Test-Path $PidFile)) {
  Write-Host "No tracked backend process was found."
  exit 0
}

$raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$trackedPid = 0
if (!$raw -or ![int]::TryParse($raw.Trim(), [ref]$trackedPid)) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Removed invalid backend pid file."
  exit 0
}

$process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
if ($process -and $process.ProcessName -like "node*") {
  Stop-Process -Id $trackedPid -Force
  Write-Host "Stopped backend on port $Port (pid $trackedPid)."
} else {
  Write-Host "Tracked backend pid $trackedPid is not running."
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
