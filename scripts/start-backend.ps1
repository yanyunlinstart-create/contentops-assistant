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

function Stop-BackendPid {
  param([int]$ProcessId)

  if (!$ProcessId) {
    return
  }

  if (Test-BackendNodeProcess -ProcessId $ProcessId) {
    Stop-Process -Id $ProcessId -Force
    Start-Sleep -Milliseconds 400
  }
}

function Stop-TrackedBackend {
  $trackedPid = Get-BackendPid
  if ($trackedPid) {
    Stop-BackendPid -ProcessId $trackedPid
  }

  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

if ($Restart) {
  Stop-TrackedBackend
  $portOwnerPid = Get-PortOwnerPid
  if ($portOwnerPid) {
    if (Test-BackendNodeProcess -ProcessId $portOwnerPid) {
      Stop-BackendPid -ProcessId $portOwnerPid
    } else {
      throw "Port $Port is already in use by process $portOwnerPid, and it does not look like this backend."
    }
  }
} elseif (Test-BackendHealth) {
  $trackedPid = Get-BackendPid
  $portOwnerPid = Get-PortOwnerPid
  if ($portOwnerPid -and (Test-BackendNodeProcess -ProcessId $portOwnerPid)) {
    Set-Content -LiteralPath $PidFile -Value $portOwnerPid -Encoding ascii
    Write-Host "Backend is already running on $HealthUrl (pid $portOwnerPid)."
  } elseif ($trackedPid) {
    Write-Host "Backend is already responding on $HealthUrl, but the listening process could not be verified (tracked pid $trackedPid)."
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
  $portOwnerPid = Get-PortOwnerPid
  if ((Test-BackendHealth) -and $portOwnerPid -eq $process.Id) {
    $healthy = $true
    break
  }
  if ($process.HasExited) {
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
