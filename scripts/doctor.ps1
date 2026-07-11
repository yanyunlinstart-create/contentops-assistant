param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 }),
  [int]$LogLines = 30
)

$ErrorActionPreference = "Continue"

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root ".env"
$OutLog = Join-Path $Root "feishu-server.out.log"
$ErrLog = Join-Path $Root "feishu-server.err.log"
$HealthUrl = "http://127.0.0.1:$Port/api/feishu/health"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title =="
}

function Get-EnvValue {
  param(
    [string]$EnvText,
    [string]$Name
  )

  $pattern = "(?m)^\s*$([regex]::Escape($Name))\s*=\s*(.+?)\s*$"
  $match = [regex]::Match($EnvText, $pattern)
  if (!$match.Success) {
    return $null
  }

  return $match.Groups[1].Value.Trim()
}

function Test-UsableEnvValue {
  param(
    [string]$Value,
    [string[]]$Placeholders
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }

  foreach ($placeholder in $Placeholders) {
    if ($Value -eq $placeholder) {
      return $false
    }
  }

  return $true
}

Write-Section "Runtime"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodeVersion = & $nodeCommand.Source --version
  Write-Host "Node: $nodeVersion"
} else {
  Write-Host "Node: not found in PATH"
}
Write-Host "Project: $Root"
Write-Host "Port: $Port"

Write-Section "Local config"
if (Test-Path $EnvFile) {
  $envText = Get-Content -LiteralPath $EnvFile -Raw -ErrorAction SilentlyContinue
  $appId = Get-EnvValue -EnvText $envText -Name "FEISHU_APP_ID"
  $appSecret = Get-EnvValue -EnvText $envText -Name "FEISHU_APP_SECRET"
  $hasAppId = Test-UsableEnvValue -Value $appId -Placeholders @("cli_xxxxxxxxxxxxx")
  $hasAppSecret = Test-UsableEnvValue -Value $appSecret -Placeholders @("your_feishu_app_secret")
  Write-Host ".env: found"
  Write-Host "FEISHU_APP_ID: $hasAppId"
  Write-Host "FEISHU_APP_SECRET: $hasAppSecret"
} else {
  Write-Host ".env: missing"
  Write-Host "Create it from .env.example and fill in the real Feishu credentials."
}

Write-Section "Backend status"
$statusScript = Join-Path $PSScriptRoot "status-backend.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $statusScript -Port $Port
$statusCode = $LASTEXITCODE
if ($statusCode -ne 0) {
  Write-Host "Backend status check did not pass. Start or restart it with npm.cmd run backend:restart."
}

Write-Section "Health payload"
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
  Write-Host $response.Content
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)"
}

Write-Section "Recent error log"
if (Test-Path $ErrLog) {
  $errLines = Get-Content -LiteralPath $ErrLog -Tail $LogLines -ErrorAction SilentlyContinue
  if ($errLines) {
    $errLines | ForEach-Object { Write-Host $_ }
  } else {
    Write-Host "No recent error log lines."
  }
} else {
  Write-Host "No error log file yet."
}

Write-Section "Next Feishu check"
Write-Host "Open the page, run the Feishu connection test, then copy the field audit report if any table or field warning remains."

if ($statusCode -ne 0) {
  exit $statusCode
}
