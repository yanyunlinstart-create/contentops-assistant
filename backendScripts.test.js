const assert = require('assert');
const { spawnSync } = require('child_process');

const command = `
$ErrorActionPreference = 'Stop'
$files = @(
  'scripts/doctor.ps1',
  'scripts/start-backend.ps1',
  'scripts/status-backend.ps1',
  'scripts/stop-backend.ps1'
)
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $file), [ref]$tokens, [ref]$errors) > $null
  if ($errors -and $errors.Count) {
    $errors | ForEach-Object { Write-Error "$($file): $($_.Message)" }
    exit 1
  }
}
Write-Output 'backend script syntax tests passed'
`;

const result = spawnSync('powershell', [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  command
], { encoding: 'utf8' });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.strictEqual(result.status, 0, 'PowerShell backend scripts should parse without syntax errors');
