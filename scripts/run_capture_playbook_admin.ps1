param(
  [string]$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,
  [string[]]$Step = @(),
  [string]$FromStep = "",
  [string]$UntilStep = "",
  [switch]$ContinueOnError,
  [switch]$NoErrorCapture,
  [switch]$Probe,
  [switch]$ApplyVariants,
  [switch]$Status,
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

function Expand-StepArguments {
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

function Get-LatestPlaybookManifest {
  param([string]$Root)
  $capturesDir = Join-Path $Root "assets/resource/ShiKong/captures"
  if (-not (Test-Path -LiteralPath $capturesDir)) {
    return $null
  }
  return Get-ChildItem -LiteralPath $capturesDir -Directory -Filter "playbook-*" |
    ForEach-Object {
      $manifest = Join-Path $_.FullName "capture-manifest.json"
      if (Test-Path -LiteralPath $manifest) {
        Get-Item -LiteralPath $manifest
      }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Invoke-LoggedCommand {
  param(
    [string]$Description,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$LogPath
  )
  "Command=$Description" | Tee-Object -FilePath $LogPath -Append
  & $FilePath @Arguments 2>&1 | Tee-Object -FilePath $LogPath -Append
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$Step = Expand-StepArguments $Step
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
  if ($Step.Count -gt 0) {
    $arguments.Add("-Step")
    $arguments.Add(($Step -join ","))
  }
  if ($FromStep) {
    $arguments.Add("-FromStep")
    $arguments.Add($FromStep)
  }
  if ($UntilStep) {
    $arguments.Add("-UntilStep")
    $arguments.Add($UntilStep)
  }
  Add-FlagArgument $arguments "-ContinueOnError" $ContinueOnError.IsPresent
  Add-FlagArgument $arguments "-NoErrorCapture" $NoErrorCapture.IsPresent
  Add-FlagArgument $arguments "-Probe" $Probe.IsPresent
  Add-FlagArgument $arguments "-ApplyVariants" $ApplyVariants.IsPresent
  Add-FlagArgument $arguments "-Status" $Status.IsPresent

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments.ToArray() -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $process.ExitCode
}

Set-Location -LiteralPath $ProjectRoot
$logDir = Join-Path $ProjectRoot "assets/resource/ShiKong/logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "capture-playbook-admin-$stamp.log"

$captureArgs = [System.Collections.Generic.List[string]]::new()
$captureArgs.Add("scripts/capture_playbook.py")
foreach ($item in $Step) {
  $captureArgs.Add("--step")
  $captureArgs.Add($item)
}
if ($FromStep) {
  $captureArgs.Add("--from-step")
  $captureArgs.Add($FromStep)
}
if ($UntilStep) {
  $captureArgs.Add("--until-step")
  $captureArgs.Add($UntilStep)
}
if ($ContinueOnError) {
  $captureArgs.Add("--continue-on-error")
}
if ($NoErrorCapture) {
  $captureArgs.Add("--no-error-capture")
}

"ProjectRoot=$ProjectRoot" | Tee-Object -FilePath $logPath
"Elevated=$(Test-IsAdministrator)" | Tee-Object -FilePath $logPath -Append
"Command=python $($captureArgs -join ' ')" | Tee-Object -FilePath $logPath -Append
& python @captureArgs 2>&1 | Tee-Object -FilePath $logPath -Append
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if ($Probe) {
  $latestManifest = Get-LatestPlaybookManifest $ProjectRoot
  if ($latestManifest) {
    $probeArgs = @(
      "scripts/probe_capture_manifest.py",
      "--manifest",
      $latestManifest.FullName,
      "--preview",
      "--report-name",
      "capture-playbook-admin-$stamp-probe"
    )
    Invoke-LoggedCommand "python $($probeArgs -join ' ')" "python" $probeArgs $logPath
  } else {
    "No latest playbook manifest found for capture-specific probe" | Tee-Object -FilePath $logPath -Append
  }

  $verifiedManifest = Join-Path $ProjectRoot "assets/resource/ShiKong/captures/combined-latest-verified-panels/capture-manifest.json"
  if (Test-Path -LiteralPath $verifiedManifest) {
    $verifiedArgs = @(
      "scripts/probe_capture_manifest.py",
      "--manifest",
      $verifiedManifest,
      "--preview",
      "--report-name",
      "latest-manifest-probe"
    )
    Invoke-LoggedCommand "python $($verifiedArgs -join ' ')" "python" $verifiedArgs $logPath
  } else {
    "Verified combined manifest not found; falling back to npm run probe:manifest" | Tee-Object -FilePath $logPath -Append
    Invoke-LoggedCommand "npm run probe:manifest" "npm" @("run", "probe:manifest") $logPath
  }
}

if ($ApplyVariants) {
  "Command=npm run apply:manifest-variants" | Tee-Object -FilePath $logPath -Append
  & npm run apply:manifest-variants 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

if ($Status) {
  "Command=npm run status:migration" | Tee-Object -FilePath $logPath -Append
  & npm run status:migration 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

"Log=$logPath" | Tee-Object -FilePath $logPath -Append
