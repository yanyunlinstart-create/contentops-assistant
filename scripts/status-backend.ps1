param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 })
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root ".feishu-server.pid"
$HealthUrl = "http://127.0.0.1:$Port/api/feishu/health"

$trackedPid = $null
if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $parsed = 0
  if ($raw -and [int]::TryParse($raw.Trim(), [ref]$parsed)) {
    $trackedPid = $parsed
  }
}

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 3
  Write-Host "Backend is healthy on $HealthUrl (HTTP $($response.StatusCode))."
  if ($trackedPid) {
    Write-Host "Tracked pid: $trackedPid"
  }
  exit 0
} catch {
  if ($trackedPid) {
    $process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Tracked backend pid $trackedPid is running, but health check failed on $HealthUrl."
      exit 1
    }
  }

  Write-Host "Backend is not responding on $HealthUrl."
  exit 1
}
