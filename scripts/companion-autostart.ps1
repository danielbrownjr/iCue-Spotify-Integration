<#
Explicit opt-in install/remove of the Windows at-logon companion task.
No credentials are passed to Task Scheduler or stored in this script.
Run from an ordinary PowerShell prompt as the intended Windows user:
  .\scripts\companion-autostart.ps1 -Install
  .\scripts\companion-autostart.ps1 -InstallHidden  # opt-in console-free mode
  .\scripts\companion-autostart.ps1 -Remove
  .\scripts\companion-autostart.ps1 -Status
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$InstallHidden,
    [switch]$Remove,
    [switch]$Status
)
$ErrorActionPreference = 'Stop'
if ([int]$Install.IsPresent + [int]$InstallHidden.IsPresent + [int]$Remove.IsPresent + [int]$Status.IsPresent -ne 1) {
    throw 'Specify exactly one of -Install, -InstallHidden, -Remove, or -Status.'
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
        if ($Task.Actions[0].Execute -match '(?i)powershell\.exe
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
if ($InstallHidden) {
    $LauncherSource = Join-Path $PSScriptRoot 'start-companion-hidden.ps1'
    if (-not (Test-Path -LiteralPath $LauncherSource -PathType Leaf)) {
        throw 'Missing start-companion-hidden.ps1 in checkout.'
    }
    $ScriptDir = Join-Path $InstallDir 'scripts'
    New-Item -ItemType Directory -Path $ScriptDir -Force | Out-Null
    Copy-Item -LiteralPath $LauncherSource -Destination $ScriptDir -Force
}

$Entry = Join-Path $InstallDir 'companion\server.mjs'
& $Node --check $Entry
if ($LASTEXITCODE -ne 0) { throw 'Copied companion did not pass syntax validation.' }
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($InstallHidden) {
    $Launcher = Join-Path $InstallDir 'scripts\start-companion-hidden.ps1'
    $PowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $PowerShell -PathType Leaf)) {
        throw 'Windows PowerShell is required for hidden startup.'
    }
    # Use local per-user script with process-scoped policy, no system policy change.
    $Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Node "{1}" -Entry "{2}"' -f $Launcher, $Node, $Entry
    $Action = New-ScheduledTaskAction -Execute $PowerShell -Argument $Arguments -WorkingDirectory $InstallDir
} else {
    # Original successful console mode, retained for rollback.
    $Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Entry) -WorkingDirectory $InstallDir
}
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "Autostart registered for $CurrentUser at the next Windows sign-in."
Write-Host "Program: $Entry"
if ($InstallHidden) { Write-Host 'Mode: console-free (supervised hidden Node child).' }
else { Write-Host 'Mode: original visible console (rollback).' }
Write-Host 'To revert the launcher only, run -Install from this checkout; no credentials are removed.'
Write-Host 'Existing running companion was not restarted. To apply updates, rerun -Install and restart after saving work.'
) {
            Write-Host 'Launcher: hidden PowerShell supervisor.'
        } else {
            Write-Host 'Launcher: visible Node console.'
        }
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
