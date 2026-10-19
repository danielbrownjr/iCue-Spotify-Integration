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

    Write-Host 'Hidden launcher synthetic exit-code and lifetime smoke tests passed.'
} finally {
    Remove-Item -LiteralPath $FixtureDir -Recurse -Force -ErrorAction SilentlyContinue
}
