<#
Explicit opt-in install/remove of the Windows at-logon companion task.
No credentials are passed to Task Scheduler or stored in this script.
Run from an ordinary PowerShell prompt as the intended Windows user:
  .\scripts\companion-autostart.ps1 -Install
  .\scripts\companion-autostart.ps1 -Remove
  .\scripts\companion-autostart.ps1 -Status
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Remove,
    [switch]$Status
)
$ErrorActionPreference = 'Stop'
if ([int]$Install.IsPresent + [int]$Remove.IsPresent + [int]$Status.IsPresent -ne 1) {
    throw 'Specify exactly one of -Install, -Remove, or -Status.'
}
if (-not $env:LOCALAPPDATA) {
    throw 'LOCALAPPDATA is required for per-user installation.'
}
$TaskName = 'iCUE Spotify Companion'
if ($Status) {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $Task) {
        Write-Host 'Autostart is not registered for this user.'
    } else {
        Write-Host "Autostart task status: $($Task.State)"
        Write-Host "Task principal: $($Task.Principal.UserId)"
        Write-Host "Configured executable: $($Task.Actions[0].Execute)"
    }
    return
}
if ($Remove) {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($Task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host 'Autostart task removed.'
    } else {
        Write-Host 'No autostart task was registered.'
    }
    Write-Host 'Local credentials and installed program files remain unchanged.'
    return
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceDir = Join-Path $RepoRoot 'companion'
foreach ($File in @('server.mjs', 'queue-jump.mjs', 'token-store.mjs')) {
    if (-not (Test-Path (Join-Path $SourceDir $File))) {
        throw "Missing companion file: $File. Use the integrated v0.1.3 branch."
    }
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
& $Node --check $Entry
if ($LASTEXITCODE -ne 0) { throw 'Copied companion did not pass syntax validation.' }
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Entry) -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "Autostart registered for $CurrentUser at the next Windows sign-in."
Write-Host "Program: $Entry"
Write-Host 'Existing running companion was not restarted. To apply updates, rerun -Install and restart after saving work.'
