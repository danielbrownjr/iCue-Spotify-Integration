<#
Explicit opt-in install/remove of the Windows at-logon companion task.
No credentials are passed to Task Scheduler or stored in this script.
Run from an ordinary PowerShell prompt as the intended Windows user:
  .\scripts\companion-autostart.ps1 -Install
  .\scripts\companion-autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Install.IsPresent -eq $Remove.IsPresent) {
    throw 'Specify exactly one of -Install or -Remove.'
}
if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is required for per-user installation.'
}
$TaskName = 'iCUE Spotify Companion'
if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Autostart removed. Existing local credentials and program files were preserved.'
    return
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceDir = Join-Path $RepoRoot 'companion'
if (-not (Test-Path (Join-Path $SourceDir 'server.mjs'))) {
    throw 'Could not locate companion/server.mjs in the repository.'
}
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$VersionText = & $Node --version
$NodeMajor = [int]($VersionText -replace '^v(\d+).*$','$1')
if ($NodeMajor -lt 22) {
    throw 'Node.js 22 or newer is required.'
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'iCueSpotifyIntegration\app'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -LiteralPath $SourceDir -Destination $InstallDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'package.json') -Destination $InstallDir -Force

$Entry = Join-Path $InstallDir 'companion\server.mjs'
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Entry) -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "Autostart registered for $CurrentUser at the next Windows sign-in."
Write-Host "Program: $Entry"
Write-Host 'Existing running companion was not restarted. To apply updates, rerun -Install and restart after saving work.'
