param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 })
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root ".feishu-server.pid"

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

$trackedPid = 0
if (Test-Path $PidFile) {
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (!$raw -or ![int]::TryParse($raw.Trim(), [ref]$trackedPid)) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Removed invalid backend pid file."
  }
}

$portOwnerPid = Get-PortOwnerPid
$targetPid = if ($trackedPid) { $trackedPid } elseif ($portOwnerPid) { $portOwnerPid } else { 0 }

if (!$targetPid) {
  Write-Host "No tracked backend process was found."
  exit 0
}

if (!(Test-BackendNodeProcess -ProcessId $targetPid) -and $portOwnerPid -and (Test-BackendNodeProcess -ProcessId $portOwnerPid)) {
  $targetPid = $portOwnerPid
}

if (Test-BackendNodeProcess -ProcessId $targetPid) {
  Stop-Process -Id $targetPid -Force
  Write-Host "Stopped backend on port $Port (pid $targetPid)."
} else {
  Write-Host "Tracked backend pid $targetPid is not running or does not look like this backend."
}

Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
