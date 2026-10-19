# Links this checkout's bridge plugin into the Hermes home, under its Jarod-OS name (docs/RENAME-PLAN-JAROD-OS.md, phase 5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\link-bridge.ps1 [-HermesHome <dir>] [-Root <checkout>]
#
# scripts\bootstrap.ps1 runs it. Tested by scripts\link-bridge.test.ps1, on throwaway folders.
#
#   plugins\jarod-os-bridge   a junction to <checkout>\plugins\herald-os-bridge (that folder keeps its name: the Linux packages
#                             link it by that name); an older link under this name is replaced, a real folder is left alone.
#   plugins\herald-os-bridge  the link under the name it had before the rename. Hermes would load the bridge twice (two plugins,
#                             the same tools), so it is removed, but only when it is a link that leads to this bridge (its
#                             plugin.yaml names it) or to nothing; never what it points at, and never a real folder.
#   plugins\hermes-os-bridge  the link from before the Herald OS rename, removed when it points into this checkout (as before).
param(
    [string]$HermesHome = $(if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }),
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'

function Write-Note($text) { Write-Host "    $text" }
function Test-Reparse([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Get-LinkTarget([string]$Path) { return [string]((Get-Item -LiteralPath $Path -Force).Target | Select-Object -First 1) }
function Test-OurBridge([string]$Dir) {
    $manifest = Join-Path $Dir 'plugin.yaml'
    if (-not (Test-Path -LiteralPath $manifest)) { return $false }
    return [bool](Select-String -LiteralPath $manifest -Pattern '^name:\s*["'']?(jarod-os-bridge|herald-os-bridge)\b' -Quiet)
}
# Removes the link itself; Delete() on a junction never follows it.
function Remove-Link([string]$Path) { (Get-Item -LiteralPath $Path -Force).Delete() }

$pluginsDir = Join-Path $HermesHome 'plugins'
New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
$source = Join-Path $Root 'plugins\herald-os-bridge'

$hermesOs = Join-Path $pluginsDir 'hermes-os-bridge'
if ((Test-Reparse $hermesOs) -and ((Get-LinkTarget $hermesOs) -like "*$Root*")) {
    Remove-Link $hermesOs
    Write-Note 'removed the pre-rename hermes-os-bridge link'
}

$link = Join-Path $pluginsDir 'jarod-os-bridge'
if (Test-Path -LiteralPath $link) {
    if (Test-Reparse $link) {
        Remove-Link $link
    } else {
        Write-Note "WARNING: $link is a real folder, not a link; leaving it (delete it to link this checkout)"
    }
} elseif (Test-Reparse $link) {
    Remove-Link $link   # a junction whose target is gone: Test-Path says it is not there, but it is.
}
if (-not (Test-Path -LiteralPath $link)) {
    New-Item -ItemType Junction -Path $link -Target $source | Out-Null
    Write-Note "linked $link -> $source"
}

# Only once the new link stands: until then the older one is what keeps the bridge loaded.
$older = Join-Path $pluginsDir 'herald-os-bridge'
if (Test-Reparse $older) {
    $target = Get-LinkTarget $older
    if (-not $target -or -not (Test-Path -LiteralPath $target) -or (Test-OurBridge $target)) {
        Remove-Link $older
        Write-Note "removed the link under the older name herald-os-bridge (it led to $target, left as it was)"
    } else {
        Write-Note "kept $older`: it leads to $target, which is not this bridge"
    }
} elseif (Test-Path -LiteralPath $older) {
    Write-Note "WARNING: $older is a real folder of your own; if it holds the bridge too, Hermes may load it twice"
}
exit 0
