param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,
  [string]$Title = (-join ([char[]](0x68A6, 0x5E7B, 0x897F, 0x6E38, 0xFF1A, 0x65F6, 0x7A7A))),
  [string[]]$Hwnd = @(),
  [switch]$AllWindows,
  [switch]$MissingOnly,
  [switch]$DryRun,
  [int]$MaxSteps = 2000,
  [ValidateSet("cropCenter4x3", "stretch1280x720")]
  [string]$CoordinateMode = "cropCenter4x3",
  [string]$OptionValues = "",
  [switch]$AlreadyElevated
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Add-FlagArgument {
  param(
    [System.Collections.Generic.List[string]]$Arguments,
    [string]$Name,
    [bool]$Enabled
  )
  if ($Enabled) {
    $Arguments.Add($Name)
  }
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
  $arguments.Add("-Title")
  $arguments.Add($Title)
  if ($Hwnd.Count -gt 0) {
    $arguments.Add("-Hwnd")
    $arguments.Add(($Hwnd -join ","))
  }
  Add-FlagArgument $arguments "-AllWindows" $AllWindows.IsPresent
  Add-FlagArgument $arguments "-MissingOnly" $MissingOnly.IsPresent
  Add-FlagArgument $arguments "-DryRun" $DryRun.IsPresent
  $arguments.Add("-MaxSteps")
  $arguments.Add([string]$MaxSteps)
  $arguments.Add("-CoordinateMode")
  $arguments.Add($CoordinateMode)
  if ($OptionValues) {
    $arguments.Add("-OptionValues")
    $arguments.Add($OptionValues)
  }
  $arguments.Add("-AlreadyElevated")

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments.ToArray() -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $process.ExitCode
}

Set-Location -LiteralPath $ProjectRoot
$exePath = Join-Path $ProjectRoot "src-tauri/target/release/mhxy-shikong-control.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "release exe not found: $exePath; run npm run tauri:build first"
}

$logDir = Join-Path $ProjectRoot "assets/resource/ShiKong/logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "release-acceptance-admin-$stamp.log"

$acceptanceArgs = [System.Collections.Generic.List[string]]::new()
$acceptanceArgs.Add("--headless-acceptance")
$acceptanceArgs.Add("--title")
$acceptanceArgs.Add($Title)
if ($Hwnd.Count -gt 0) {
  $acceptanceArgs.Add("--hwnd")
  $acceptanceArgs.Add(($Hwnd -join ","))
}
Add-FlagArgument $acceptanceArgs "--all-windows" $AllWindows.IsPresent
Add-FlagArgument $acceptanceArgs "--missing-only" $MissingOnly.IsPresent
Add-FlagArgument $acceptanceArgs "--dry-run" $DryRun.IsPresent
if ($MaxSteps -gt 0) {
  $acceptanceArgs.Add("--max-steps")
  $acceptanceArgs.Add([string]$MaxSteps)
}
$acceptanceArgs.Add("--coordinate-mode")
$acceptanceArgs.Add($CoordinateMode)
if ($OptionValues) {
  $acceptanceArgs.Add("--option-values")
  $acceptanceArgs.Add($OptionValues)
}

"ProjectRoot=$ProjectRoot" | Tee-Object -FilePath $logPath
"Elevated=$(Test-IsAdministrator)" | Tee-Object -FilePath $logPath -Append
"Exe=$exePath" | Tee-Object -FilePath $logPath -Append
if ($OptionValues) {
  $validateArgs = @(
    "scripts/validate_headless_options.py",
    "--option-values",
    $OptionValues
  )
  "Command=python $($validateArgs -join ' ')" | Tee-Object -FilePath $logPath -Append
  & python @validateArgs 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
"Command=$exePath $($acceptanceArgs -join ' ')" | Tee-Object -FilePath $logPath -Append
$stdoutPath = Join-Path $logDir "release-acceptance-admin-$stamp.stdout.log"
$stderrPath = Join-Path $logDir "release-acceptance-admin-$stamp.stderr.log"
$acceptanceProcess = Start-Process `
  -FilePath $exePath `
  -ArgumentList $acceptanceArgs.ToArray() `
  -Wait `
  -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath
$acceptanceExit = $acceptanceProcess.ExitCode
"AcceptanceExit=$acceptanceExit" | Tee-Object -FilePath $logPath -Append
if (Test-Path -LiteralPath $stdoutPath) {
  "Command=Get-Content $stdoutPath" | Tee-Object -FilePath $logPath -Append
  Get-Content -Raw -LiteralPath $stdoutPath | Tee-Object -FilePath $logPath -Append
}
if (Test-Path -LiteralPath $stderrPath) {
  "Command=Get-Content $stderrPath" | Tee-Object -FilePath $logPath -Append
  Get-Content -Raw -LiteralPath $stderrPath | Tee-Object -FilePath $logPath -Append
}
$headlessReportPath = Join-Path $ProjectRoot "assets/resource/ShiKong/reports/latest-headless-acceptance.json"
if (Test-Path -LiteralPath $headlessReportPath) {
  "Command=Get-Content $headlessReportPath" | Tee-Object -FilePath $logPath -Append
  Get-Content -Raw -LiteralPath $headlessReportPath | Tee-Object -FilePath $logPath -Append
}

"Command=npm run audit:live-acceptance" | Tee-Object -FilePath $logPath -Append
& npm run audit:live-acceptance 2>&1 | Tee-Object -FilePath $logPath -Append
$liveExit = $LASTEXITCODE

"Command=npm run audit:acceptance-plan" | Tee-Object -FilePath $logPath -Append
& npm run audit:acceptance-plan 2>&1 | Tee-Object -FilePath $logPath -Append
$planExit = $LASTEXITCODE

"Log=$logPath" | Tee-Object -FilePath $logPath -Append
if ($acceptanceExit -ne 0) {
  exit $acceptanceExit
}
if ($liveExit -ne 0) {
  exit $liveExit
}
exit $planExit
