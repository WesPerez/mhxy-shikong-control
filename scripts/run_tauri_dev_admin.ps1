param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,
  [switch]$AlreadyElevated,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path

if (-not (Test-IsAdministrator) -and -not $AlreadyElevated) {
  $arguments = [System.Collections.Generic.List[string]]::new()
  $arguments.Add("-NoProfile")
  $arguments.Add("-ExecutionPolicy")
  $arguments.Add("Bypass")
  $arguments.Add("-File")
  $arguments.Add($PSCommandPath)
  $arguments.Add("-ProjectRoot")
  $arguments.Add($ProjectRoot)
  $arguments.Add("-AlreadyElevated")

  if ($DryRun) {
    [pscustomobject]@{
      status = "dry-run"
      elevated = $false
      action = "Start-Process powershell.exe -Verb RunAs"
      arguments = $arguments.ToArray()
      projectRoot = $ProjectRoot
    } | ConvertTo-Json -Depth 4
    exit 0
  }

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments.ToArray() -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $process.ExitCode
}

Set-Location -LiteralPath $ProjectRoot
$logDir = Join-Path $ProjectRoot "assets/resource/ShiKong/logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "tauri-dev-admin-$stamp.log"

if ($DryRun) {
  [pscustomobject]@{
    status = "dry-run"
    elevated = (Test-IsAdministrator)
    action = "npm run tauri:dev"
    projectRoot = $ProjectRoot
    logPath = $logPath
  } | ConvertTo-Json -Depth 4
  exit 0
}

"ProjectRoot=$ProjectRoot" | Tee-Object -FilePath $logPath
"Elevated=$(Test-IsAdministrator)" | Tee-Object -FilePath $logPath -Append
"Command=npm run tauri:dev" | Tee-Object -FilePath $logPath -Append
& npm run tauri:dev 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
