# Native Windows smoke test only. Never registers, stops or changes a Scheduled Task.
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $RepoRoot 'scripts\start-companion-hidden.ps1'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$FixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('icue hidden launcher ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $FixtureDir -Force | Out-Null
try {
    $Entry = Join-Path $FixtureDir 'fixture with spaces.mjs'

    # Child failures must propagate, allowing Task Scheduler to flag exits.
    Set-Content -LiteralPath $Entry -Value 'process.exit(7);' -Encoding Ascii
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Launcher -Node $Node -Entry $Entry
    if ($LASTEXITCODE -ne 7) {
        throw "Hidden launcher exit code mismatch: expected 7, got $LASTEXITCODE"
    }

    # Supervisor must stay alive until Node exits rather than launching detached.
    Set-Content -LiteralPath $Entry -Value 'setTimeout(() => process.exit(0), 850);' -Encoding Ascii
    $Timer = [Diagnostics.Stopwatch]::StartNew()
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Launcher -Node $Node -Entry $Entry
    $Exit = $LASTEXITCODE
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
        $Supervisor = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') `
            -ArgumentList ('-NoLogo -NoProfile -NonInteractive -File "{0}" -Node "{1}" -Entry "{2}"' -f $Launcher, $Node, $Entry) `
            -WindowStyle Hidden -PassThru
        $Deadline = (Get-Date).AddSeconds(15)
        while (-not (Test-Path -LiteralPath $PidFile)) {
            if ($Supervisor.HasExited -or (Get-Date) -gt $Deadline) { throw 'Synthetic child did not start.' }
            Start-Sleep -Milliseconds 100
        }
        $ChildId = [int](Get-Content -LiteralPath $PidFile -Raw)
        if (-not (Get-Process -Id $ChildId -ErrorAction SilentlyContinue)) { throw 'Synthetic child exited early.' }
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
    Write-Host 'Hidden launcher synthetic exit-code, lifetime and termination smoke tests passed.'
} finally {
    Remove-Item -LiteralPath $FixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}
