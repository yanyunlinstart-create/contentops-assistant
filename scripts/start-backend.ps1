param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 }),
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root ".feishu-server.pid"
$OutLog = Join-Path $Root "feishu-server.out.log"
$ErrLog = Join-Path $Root "feishu-server.err.log"
$HealthUrl = "http://127.0.0.1:$Port/api/feishu/health"

function Test-BackendHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 3
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-BackendPid {
  if (!(Test-Path $PidFile)) {
    return $null
  }

  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (!$raw) {
    return $null
  }

  $parsed = 0
  if ([int]::TryParse($raw.Trim(), [ref]$parsed)) {
    return $parsed
  }

  return $null
}

function Stop-TrackedBackend {
  $trackedPid = Get-BackendPid
  if (!$trackedPid) {
    return
  }

  $process = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -like "node*") {
    Stop-Process -Id $trackedPid -Force
    Start-Sleep -Milliseconds 400
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

if ($Restart) {
  Stop-TrackedBackend
} elseif (Test-BackendHealth) {
  $trackedPid = Get-BackendPid
  if ($trackedPid) {
    Write-Host "Backend is already running on $HealthUrl (pid $trackedPid)."
  } else {
    Write-Host "Backend is already responding on $HealthUrl."
  }
  exit 0
}

$existingPid = Get-BackendPid
if ($existingPid -and !(Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (!$nodeCommand) {
  throw "Node.js was not found in PATH. Install Node.js or start this script from a shell where node is available."
}

$process = Start-Process `
  -FilePath $nodeCommand.Source `
  -ArgumentList @("server.js") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog `
  -WindowStyle Hidden `
  -PassThru

Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii

$healthy = $false
for ($i = 0; $i -lt 12; $i += 1) {
  Start-Sleep -Milliseconds 500
  if (Test-BackendHealth) {
    $healthy = $true
    break
  }
}

if ($healthy) {
  Write-Host "Backend started on $HealthUrl (pid $($process.Id))."
  Write-Host "Logs: $OutLog"
  exit 0
}

Write-Error "Backend process started but did not pass health check. See $ErrLog and $OutLog."
exit 1
