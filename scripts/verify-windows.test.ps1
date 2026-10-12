# Checks the one piece of verify-windows.ps1 that decides its exit code by accident: the final cleanup.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.test.ps1
#
# A taskkill that fails while the script runs with $ErrorActionPreference = 'Stop' must not escape Stop-Tree
# (it used to end the script with exit code 1 after six passing steps). Exit code 0 only when every check holds.
$ErrorActionPreference = 'Stop'

$Target = Join-Path $PSScriptRoot 'verify-windows.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$null, [ref]$null)
$def = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-Tree' }, $true)
if (-not $def) { Write-Host '[FAIL] Stop-Tree is not defined in verify-windows.ps1'; exit 1 }
. ([scriptblock]::Create($def.Extent.Text))

$failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if (-not $Ok) { $script:failures++ }
    Write-Host ("[{0}] {1}{2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name, $(if ($Detail) { ": $Detail" } else { '' }))
}

# This very process stands in for the server: it has not exited, and the fake taskkill below never touches it.
$running = [System.Diagnostics.Process]::GetCurrentProcess()

foreach ($mode in 'throws', 'writes-error') {
    $script:calls = 0
    $script:mode = $mode
    # A function named like the tool wins over the executable in command resolution.
    function taskkill.exe {
        $script:calls++
        if ($script:mode -eq 'throws') { throw 'taskkill: the process was not found' }
        Write-Error 'ERROR: The process "1234" not found.'
    }

    $ErrorActionPreference = 'Stop'
    $escaped = $null
    try { Stop-Tree $running } catch { $escaped = $_.Exception.Message }

    Check "taskkill $mode`: Stop-Tree stays quiet" ($null -eq $escaped) $escaped
    Check "taskkill $mode`: it did try to stop the tree" ($script:calls -eq 1) "calls=$($script:calls)"
    Check "taskkill $mode`: the caller's ErrorActionPreference is back" ($ErrorActionPreference -eq 'Stop') $ErrorActionPreference
    Remove-Item function:taskkill.exe
}

# No process, or one that already exited: nothing to call.
$script:calls = 0
function taskkill.exe { $script:calls++ }
Stop-Tree $null
Check 'no process: taskkill is not called' ($script:calls -eq 0) "calls=$($script:calls)"
Remove-Item function:taskkill.exe

if ($failures -gt 0) { Write-Host "$failures check(s) failed."; exit 1 }
Write-Host 'All checks passed.'
exit 0
