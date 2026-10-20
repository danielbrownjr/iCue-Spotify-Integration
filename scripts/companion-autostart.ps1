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
        if (-not (Test-Path -LiteralPath $Task.Actions[0].Execute -PathType Leaf)) {
            Write-Warning 'The registered task executable is missing. Startup will fail until reinstalled from native PowerShell.'
        }
        if ($Task.Actions[0].Execute -match '(?i)companion-hidden-[a-f0-9]+\.exe$') {
            Write-Host 'Launcher: console-free Windows application supervisor.'
        } elseif ($Task.Actions[0].Execute -match '(?i)powershell\.exe$') {
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
. (Join-Path $PSScriptRoot 'installation-safety.ps1')
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

# Validate source and compile a launcher before touching the installed app files.
# A failed source check/compiler must never poison the already-working task.
Assert-CompanionSourceSyntax -Node $Node -SourceDir $SourceDir
$PrebuiltLauncher = $null
if ($InstallHidden) {
    $NativeSource = Join-Path $PSScriptRoot 'companion-hidden.cs'
    $BuildScript = Join-Path $PSScriptRoot 'build-hidden-launcher.ps1'
    if (-not (Test-Path -LiteralPath $NativeSource -PathType Leaf) -or
        -not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
        throw 'Missing native console-free launcher sources.'
    }
    $PrebuiltLauncher = Join-Path ([IO.Path]::GetTempPath()) ('icue-launcher-' + [guid]::NewGuid().ToString('N') + '.exe')
    try {
        & $BuildScript -Source $NativeSource -Output $PrebuiltLauncher
    } catch {
        Remove-Item -LiteralPath $PrebuiltLauncher -Force -ErrorAction SilentlyContinue
        throw
    }
}

$InstallDir = Join-Path $env:LOCALAPPDATA 'iCueSpotifyIntegration\app'
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# MSIX hosts can transparently redirect AppData into Packages/.../LocalCache.
# Resolve the real filesystem directory before writing or registering a task.
Assert-RealAppDataInstallDirectory -InstallDir $InstallDir | Out-Null
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
    Copy-Item -LiteralPath $NativeSource -Destination $ScriptDir -Force
    $SourceVersion = (Get-FileHash -LiteralPath $NativeSource -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
    # Versioned path permits updating registration without replacing a running EXE.
    $LauncherExecutable = Join-Path $ScriptDir ("companion-hidden-$SourceVersion.exe")
    if (-not (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf)) {
        Copy-Item -LiteralPath $PrebuiltLauncher -Destination $LauncherExecutable -Force
    }
}

$Entry = Join-Path $InstallDir 'companion\server.mjs'
& $Node --check $Entry
if ($LASTEXITCODE -ne 0) { throw 'Copied companion did not pass syntax validation.' }
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($InstallHidden) {
    # A GUI-subsystem executable never allocates a supervisor console, even
    # when Windows Terminal is configured as the default console host.
    $Arguments = '"{0}" "{1}"' -f $Node, $Entry
    $Action = New-ScheduledTaskAction -Execute $LauncherExecutable -Argument $Arguments -WorkingDirectory $InstallDir
} else {
    # Original successful console mode, retained for rollback.
    $Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Entry) -WorkingDirectory $InstallDir
}
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
} finally {
    if ($PrebuiltLauncher) {
        Remove-Item -LiteralPath $PrebuiltLauncher -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Autostart registered for $CurrentUser at the next Windows sign-in."
Write-Host "Program: $Entry"
if ($InstallHidden) { Write-Host 'Mode: console-free (supervised hidden Node child).' }
else { Write-Host 'Mode: original visible console (rollback).' }
Write-Host 'To revert the launcher only, run -Install from this checkout; no credentials are removed.'
$ReinstallMode = if ($InstallHidden) { '-InstallHidden' } else { '-Install' }
Write-Host "Existing running companion was not restarted. For future updates rerun $ReinstallMode from this checkout and restart after saving work."
