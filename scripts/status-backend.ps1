param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 })
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root ".feishu-server.pid"
$HealthUrl = "http://127.0.0.1:$Port/api/feishu/health"

function Get-PortOwnerPid {
  try {
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) {
      return [int]$connection.OwningProcess
    }
  } catch {
  }
  return $null
}

function Test-BackendNodeProcess {
  param([int]$ProcessId)

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (!$process -or $process.ProcessName -notlike "node*") {
    return $false
  }

  try {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    return [string]$cim.CommandLine -match "server\.js"
  } catch {
    return $true
  }
}

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
  $portOwnerPid = Get-PortOwnerPid
  Write-Host "Backend is healthy on $HealthUrl (HTTP $($response.StatusCode))."
  if ($portOwnerPid) {
    Write-Host "Listening pid: $portOwnerPid"
  }
  if ($trackedPid) {
    Write-Host "Tracked pid: $trackedPid"
  }
  if ($portOwnerPid -and $portOwnerPid -ne $trackedPid -and (Test-BackendNodeProcess -ProcessId $portOwnerPid)) {
    Set-Content -LiteralPath $PidFile -Value $portOwnerPid -Encoding ascii
    Write-Host "Pid file updated to listening pid $portOwnerPid."
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
