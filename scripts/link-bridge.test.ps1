# Checks scripts\link-bridge.ps1 on throwaway folders (never the real Hermes home): the bridge is linked under its Jarod-OS name,
# and the link under its older name goes only when it leads to this bridge or nowhere (docs/RENAME-PLAN-JAROD-OS.md, phase 5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\link-bridge.test.ps1
#
# Exit code 0 only when every check holds.
$ErrorActionPreference = 'Stop'
$Script = Join-Path $PSScriptRoot 'link-bridge.ps1'

$failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if (-not $Ok) { $script:failures++ }
    Write-Host ("[{0}] {1}{2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { ": $Detail" } else { '' }))
}
function Is-Junction([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item) -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Target-Of([string]$Path) { return [string]((Get-Item -LiteralPath $Path -Force).Target | Select-Object -First 1) }
function New-Bridge([string]$Dir, [string]$Name) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Set-Content -LiteralPath (Join-Path $Dir 'plugin.yaml') -Value "name: $Name" -Encoding utf8
    return $Dir
}

$base = Join-Path ([IO.Path]::GetTempPath()) ("link-bridge-test-" + [guid]::NewGuid().ToString('N'))
try {
    $root = Join-Path $base 'repo'
    $source = New-Bridge (Join-Path $root 'plugins\herald-os-bridge') 'jarod-os-bridge'

    function Run-Case([string]$Name, [scriptblock]$Arrange) {
        $hermes = Join-Path $base $Name
        $plugins = Join-Path $hermes 'plugins'
        New-Item -ItemType Directory -Force -Path $plugins | Out-Null
        & $Arrange $plugins
        & $Script -HermesHome $hermes -Root $root | Out-Null
        return $plugins
    }

    # 1. Nothing there yet: the bridge is linked under its new name, to this checkout.
    $p = Run-Case 'fresh' { param($plugins) }
    $new = Join-Path $p 'jarod-os-bridge'
    Check 'fresh: linked under jarod-os-bridge' ((Is-Junction $new) -and ((Target-Of $new).TrimEnd('\') -eq $source.TrimEnd('\'))) (Target-Of $new)

    # 2. The older link to an older checkout of the bridge (the C: copy, say): removed, and the checkout is left as it was.
    $old = New-Bridge (Join-Path $base 'old-checkout\plugins\herald-os-bridge') 'herald-os-bridge'
    $p = Run-Case 'older-link' { param($plugins) New-Item -ItemType Junction -Path (Join-Path $plugins 'herald-os-bridge') -Target $old | Out-Null }
    Check 'older link to the bridge: removed' (-not (Test-Path -LiteralPath (Join-Path $p 'herald-os-bridge')))
    Check 'older link to the bridge: its target is untouched' (Test-Path -LiteralPath (Join-Path $old 'plugin.yaml'))
    Check 'older link to the bridge: the new link stands' (Is-Junction (Join-Path $p 'jarod-os-bridge'))

    # 3. An older link that leads nowhere: removed.
    $gone = New-Bridge (Join-Path $base 'gone\herald-os-bridge') 'herald-os-bridge'
    $p = Run-Case 'dead-link' { param($plugins) New-Item -ItemType Junction -Path (Join-Path $plugins 'herald-os-bridge') -Target $gone | Out-Null; Remove-Item -LiteralPath $gone -Recurse -Force }
    Check 'older link leading nowhere: removed' (-not (Test-Path -LiteralPath (Join-Path $p 'herald-os-bridge')) -and -not (Is-Junction (Join-Path $p 'herald-os-bridge')))

    # 4. An older link to something that is not this bridge: not ours to remove.
    $other = New-Bridge (Join-Path $base 'other\plugin') 'somebody-elses-plugin'
    $p = Run-Case 'other-link' { param($plugins) New-Item -ItemType Junction -Path (Join-Path $plugins 'herald-os-bridge') -Target $other | Out-Null }
    Check 'older link to another plugin: kept' (Is-Junction (Join-Path $p 'herald-os-bridge'))

    # 5. A real folder under the older name: the person's own.
    $p = Run-Case 'older-folder' { param($plugins) New-Bridge (Join-Path $plugins 'herald-os-bridge') 'herald-os-bridge' | Out-Null }
    Check 'older real folder: kept' ((Test-Path -LiteralPath (Join-Path $p 'herald-os-bridge\plugin.yaml')) -and -not (Is-Junction (Join-Path $p 'herald-os-bridge')))

    # 6. A link under the new name to somewhere else (a moved checkout): relinked to this one.
    $elsewhere = New-Bridge (Join-Path $base 'elsewhere\herald-os-bridge') 'jarod-os-bridge'
    $p = Run-Case 'relink' { param($plugins) New-Item -ItemType Junction -Path (Join-Path $plugins 'jarod-os-bridge') -Target $elsewhere | Out-Null }
    Check 'link under the new name elsewhere: relinked here' ((Target-Of (Join-Path $p 'jarod-os-bridge')).TrimEnd('\') -eq $source.TrimEnd('\'))
    Check 'link under the new name elsewhere: what it pointed at is untouched' (Test-Path -LiteralPath (Join-Path $elsewhere 'plugin.yaml'))

    # 7. Twice in a row: the same result, nothing broken.
    $p = Join-Path $base 'fresh\plugins'
    & $Script -HermesHome (Join-Path $base 'fresh') -Root $root | Out-Null
    Check 'second run: still linked once, under the new name' ((Is-Junction (Join-Path $p 'jarod-os-bridge')) -and -not (Test-Path -LiteralPath (Join-Path $p 'herald-os-bridge')))
} finally {
    # Junctions first (Remove-Item -Recurse could follow one), then the rest.
    Get-ChildItem -LiteralPath $base -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { $_.Delete() }
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures) { Write-Host "$failures check(s) failed"; exit 1 }
Write-Host 'all checks passed'
exit 0
