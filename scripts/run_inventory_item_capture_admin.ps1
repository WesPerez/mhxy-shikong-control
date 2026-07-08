param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,
  [string[]]$Target = @(),
  [switch]$Apply,
  [switch]$Overwrite,
  [switch]$SaveFrames,
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

function Expand-TargetArguments {
  param([string[]]$Items)
  $expanded = [System.Collections.Generic.List[string]]::new()
  foreach ($item in $Items) {
    foreach ($part in ($item -split ",")) {
      $name = $part.Trim()
      if ($name) {
        $expanded.Add($name)
      }
    }
  }
  return $expanded.ToArray()
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$Target = Expand-TargetArguments $Target

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
  if ($Target.Count -gt 0) {
    $arguments.Add("-Target")
    $arguments.Add(($Target -join ","))
  }
  Add-FlagArgument $arguments "-Apply" $Apply.IsPresent
  Add-FlagArgument $arguments "-Overwrite" $Overwrite.IsPresent
  Add-FlagArgument $arguments "-SaveFrames" $SaveFrames.IsPresent

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments.ToArray() -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $process.ExitCode
}

Set-Location -LiteralPath $ProjectRoot
$logDir = Join-Path $ProjectRoot "assets/resource/ShiKong/logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "inventory-item-capture-admin-$stamp.log"

$captureArgs = [System.Collections.Generic.List[string]]::new()
$captureArgs.Add("scripts/capture_inventory_items_by_name.py")
foreach ($item in $Target) {
  $captureArgs.Add("--target")
  $captureArgs.Add($item)
}
if ($Apply) {
  $captureArgs.Add("--apply")
}
if ($Overwrite) {
  $captureArgs.Add("--overwrite")
}
if ($SaveFrames) {
  $captureArgs.Add("--save-frames")
}

"ProjectRoot=$ProjectRoot" | Tee-Object -FilePath $logPath
"Elevated=$(Test-IsAdministrator)" | Tee-Object -FilePath $logPath -Append
"Command=python $($captureArgs -join ' ')" | Tee-Object -FilePath $logPath -Append
& python @captureArgs 2>&1 | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

"Log=$logPath" | Tee-Object -FilePath $logPath -Append
