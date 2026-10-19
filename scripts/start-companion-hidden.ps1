<#
Hidden process launcher for the iCUE Spotify companion.
Invoked only by the explicitly installed -InstallHidden scheduled task.
The PowerShell host is launched with -WindowStyle Hidden by Task Scheduler;
the child node.exe process is also started with WindowStyle Hidden.
-Wait keeps the scheduled task Running while the Node companion lives.
Never print OAuth credentials, pairing keys, or token file contents.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Entry
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    throw 'Node executable not found for hidden companion.'
}
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
    throw 'Companion entrypoint not found for hidden companion.'
}
$WorkingDirectory = Split-Path -Parent (Split-Path -Parent $Entry)
# Start-Process hides the Node child window. -Wait keeps this PowerShell
# launcher alive so Task Scheduler can track the companion lifecycle.
$Child = Start-Process -FilePath $Node -ArgumentList ('"{0}"' -f $Entry) `
    -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -Wait
exit $Child.ExitCode
