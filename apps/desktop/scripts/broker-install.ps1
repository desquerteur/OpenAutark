# Installs or removes the Autark desktop broker (B-077: computer use on the lock screen and UAC) with one UAC prompt.
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\broker-install.ps1             # install / reinstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\broker-install.ps1 -Uninstall  # remove everything
# Install: AutarkDesktopBroker.exe → %ProgramFiles%\AutarkDesktopBroker (admin-only, the service runs it as SYSTEM);
# %ProgramData%\AutarkDesktopBroker with a fresh 32-byte broker.key and broker.log (SYSTEM + Administrators full, the
# installing user read); the service AutarkDesktopBroker (LocalSystem, automatic start, restart on failure), started.
# Uninstall: stops and deletes the service, ends its worker and removes both folders. The Autark app is not restarted.
param([switch]$Uninstall, [string]$UserSid, [string]$ResultFile, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$name = 'AutarkDesktopBroker'
$programDir = Join-Path $env:ProgramFiles $name
$dataDir = Join-Path $env:ProgramData $name

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  # Not elevated: remember who installs (the pipe opens for this user), ask for elevation once, print the result.
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $result = Join-Path $env:TEMP "autark-broker-install-$PID.txt"
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-UserSid', $sid, '-ResultFile', "`"$result`"")
  if ($Uninstall) { $arguments += '-Uninstall' }
  $process = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if (Test-Path $result) { Get-Content $result; Remove-Item $result -Force }
  exit $process.ExitCode
}

$lines = New-Object System.Collections.Generic.List[string]
function Say([string]$line) { $lines.Add($line); Write-Host $line }

function Remove-Broker {
  if (Get-Service $name -ErrorAction SilentlyContinue) {
    & sc.exe stop $name | Out-Null
    (Get-Service $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
    & sc.exe delete $name | Out-Null
    Say "service $name removed"
  }
  Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($dir in @($programDir, $dataDir)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir; Say "removed $dir" } }
}

$code = 0
try {
  if ($Uninstall) {
    Remove-Broker
    Say 'Autark desktop broker uninstalled.'
  } else {
    if (-not $UserSid) { $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    $null = New-Object Security.Principal.SecurityIdentifier($UserSid)
    $source = Join-Path $PSScriptRoot '..\resources\broker\AutarkDesktopBroker.exe'
    if (-not (Test-Path $source)) { & (Join-Path $PSScriptRoot '..\resources\broker\build.ps1') | Out-Null }
    Remove-Broker

    New-Item -ItemType Directory -Force $programDir | Out-Null
    $exe = Join-Path $programDir "$name.exe"
    Copy-Item $source $exe -Force

    New-Item -ItemType Directory -Force $dataDir | Out-Null
    & icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${UserSid}:(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $dataDir" }
    $key = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
    [IO.File]::WriteAllText((Join-Path $dataDir 'broker.key'), [Convert]::ToBase64String($key))
    [Array]::Clear($key, 0, $key.Length)

    & sc.exe create $name binPath= "`"$exe`" service $UserSid" start= auto obj= LocalSystem DisplayName= 'Autark Desktop Broker' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create failed ($LASTEXITCODE)" }
    & sc.exe description $name 'Lets Autark see and operate the Windows sign-in screen and UAC prompts with its computer tools.' | Out-Null
    & sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
    Start-Service $name
    (Get-Service $name).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    Say "Autark desktop broker installed and running (service $name, user $UserSid)."
  }
} catch {
  Say "FAILED: $($_.Exception.Message)"
  $code = 1
}
if ($ResultFile) { [IO.File]::WriteAllLines($ResultFile, $lines) }
exit $code
