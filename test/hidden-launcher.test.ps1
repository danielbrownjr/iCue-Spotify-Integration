# Native Windows smoke test only. Never registers, stops or changes a Scheduled Task.
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LauncherSource = Join-Path $RepoRoot 'scripts\companion-hidden.cs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$FixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('icue hidden launcher ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $FixtureDir -Force | Out-Null
try {
    $Entry = Join-Path $FixtureDir 'fixture with spaces.mjs'
    $Launcher = Join-Path $FixtureDir 'companion hidden.exe'
    & (Join-Path $RepoRoot 'scripts\build-hidden-launcher.ps1') -Source $LauncherSource -Output $Launcher
    # PE subsystem 2 is Windows GUI, not console (3). This catches the
    # PowerShell/Windows Terminal delegation issue without relying on hiding.
    $Binary = [IO.BinaryReader]::new([IO.File]::OpenRead($Launcher))
    try {
        $Binary.BaseStream.Position = 0x3c
        $PeOffset = $Binary.ReadInt32()
        $Binary.BaseStream.Position = $PeOffset + 24 + 68
        if ($Binary.ReadUInt16() -ne 2) { throw 'Supervisor must use the Windows GUI subsystem.' }
    } finally { $Binary.Dispose() }

    # Child failures must propagate, allowing Task Scheduler to flag exits.
    Set-Content -LiteralPath $Entry -Value 'process.exit(7);' -Encoding Ascii
    $Result = Start-Process -FilePath $Launcher -ArgumentList ('"{0}" "{1}"' -f $Node, $Entry) -PassThru -Wait
    if ($Result.ExitCode -ne 7) {
        throw "Hidden launcher exit code mismatch: expected 7, got $($Result.ExitCode)"
    }

    # Supervisor must stay alive until Node exits rather than launching detached.
    Set-Content -LiteralPath $Entry -Value 'setTimeout(() => process.exit(0), 850);' -Encoding Ascii
    $Timer = [Diagnostics.Stopwatch]::StartNew()
    $Result = Start-Process -FilePath $Launcher -ArgumentList ('"{0}" "{1}"' -f $Node, $Entry) -PassThru -Wait
    $Exit = $Result.ExitCode
    $Timer.Stop()
    if ($Exit -ne 0) {
        throw "Hidden launcher successful-child exit mismatch: $Exit"
    }
    if ($Timer.ElapsedMilliseconds -lt 650) {
        throw "Hidden launcher returned before child finished: $($Timer.ElapsedMilliseconds) ms"
    }

    # Task Scheduler can forcibly terminate the supervisor. The child must
    # terminate too, otherwise the next task launch collides with port 8765.
    $PidFile = $Entry + '.pid'
    Set-Content -LiteralPath $Entry -Value "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[1]+'.pid',String(process.pid)); setInterval(()=>{},1000);" -Encoding Ascii
    $Supervisor = $null
    $ChildId = $null
    try {
        $Supervisor = Start-Process -FilePath $Launcher `
            -ArgumentList ('"{0}" "{1}"' -f $Node, $Entry) -PassThru
        $Deadline = (Get-Date).AddSeconds(15)
        while (-not (Test-Path -LiteralPath $PidFile)) {
            if ($Supervisor.HasExited -or (Get-Date) -gt $Deadline) { throw 'Synthetic child did not start.' }
            Start-Sleep -Milliseconds 100
        }
        $ChildId = [int](Get-Content -LiteralPath $PidFile -Raw)
        if (-not (Get-Process -Id $ChildId -ErrorAction SilentlyContinue)) { throw 'Synthetic child exited early.' }
        if ($Supervisor.MainWindowHandle -ne 0) { throw 'Supervisor created a visible window.' }
        Stop-Process -Id $Supervisor.Id -ErrorAction Stop
        $Supervisor.WaitForExit()
        $Deadline = (Get-Date).AddSeconds(5)
        while (Get-Process -Id $ChildId -ErrorAction SilentlyContinue) {
            if ((Get-Date) -gt $Deadline) { throw 'Hidden launcher left an orphan child after supervisor termination.' }
            Start-Sleep -Milliseconds 100
        }
    } finally {
        if ($Supervisor -and -not $Supervisor.HasExited) { Stop-Process -Id $Supervisor.Id -ErrorAction SilentlyContinue }
        if ($ChildId) { Stop-Process -Id $ChildId -ErrorAction SilentlyContinue }
    }
    Write-Host 'Console-free GUI launcher subsystem, exit-code, lifetime and termination tests passed.'
} finally {
    Remove-Item -LiteralPath $FixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}
