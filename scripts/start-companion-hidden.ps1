<#
Compatibility/manual PowerShell entrypoint. The scheduled task uses the GUI
executable directly, so Windows Terminal cannot open for its supervisor.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Entry
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or
    -not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
    throw 'Node executable or companion entrypoint not found.'
}
Add-Type -Path (Join-Path $PSScriptRoot 'companion-hidden.cs')
exit [CompanionHiddenProcess]::Run($Node, $Entry, (Split-Path -Parent (Split-Path -Parent $Entry)))
