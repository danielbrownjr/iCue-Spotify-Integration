# Read-only safety tests with synthetic temporary files. No tasks, OAuth or real AppData touched.
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $RepoRoot 'scripts\installation-safety.ps1')
$Virtualized = 'C:\Users\test\AppData\Local\Packages\OpenAI.Codex_xyz\LocalCache\Local\iCueSpotifyIntegration\app'
if (-not (Test-VirtualizedAppDataPath $Virtualized)) {
    throw 'Failed to recognize the recorded MSIX AppData virtualization pattern.'
}
if (-not (Test-VirtualizedAppDataPath ($Virtualized.Replace('\', '/')))) {
    throw 'Virtualized-path normalization failed.'
}
foreach ($Path in @('C:\Users\test\AppData\Local\iCueSpotifyIntegration\app', 'C:\Temp\Packages\normal')) {
    if (Test-VirtualizedAppDataPath $Path) {
        throw "Incorrectly rejected a normal path: $Path"
    }
}
$Fixture = Join-Path ([IO.Path]::GetTempPath()) ('icue install safety ' + [guid]::NewGuid().ToString('N'))
$SourceDir = Join-Path $Fixture 'companion'
New-Item -ItemType Directory -Path $SourceDir -Force | Out-Null
try {
    $NativePath = Get-PhysicalInstallDirectory -Path $Fixture
    if (-not $NativePath -or (Test-VirtualizedAppDataPath $NativePath)) {
        throw "Unexpected physical path: $NativePath"
    }
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $Entry = Join-Path $SourceDir 'server.mjs'
    Set-Content -LiteralPath $Entry -Value 'const fine = 1;' -Encoding Ascii
    Assert-CompanionSourceSyntax -Node $Node -SourceDir $SourceDir
    Set-Content -LiteralPath $Entry -Value 'const =' -Encoding Ascii
    $Failed = $false
    try { Assert-CompanionSourceSyntax -Node $Node -SourceDir $SourceDir }
    catch { $Failed = $true }
    if (-not $Failed) {
        throw 'Invalid companion syntax was accepted during install preflight.'
    }
    # The helpers must never copy the bad source into an installed directory.
    if (Test-Path -LiteralPath (Join-Path $Fixture 'app')) {
        throw 'Source preflight unexpectedly modified an app directory.'
    }
    # Node's deliberate nonzero syntax-check exit can otherwise survive as the
    # pwsh step's last native process code despite our expected-error assertion.
    & $Node --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Node did not recover after the negative fixture.' }
    Write-Host 'AppData virtualization, physical path and source preflight tests passed.'
} finally {
    Remove-Item -LiteralPath $Fixture -Recurse -Force -ErrorAction SilentlyContinue
}
