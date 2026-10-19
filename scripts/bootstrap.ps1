# One-shot developer bootstrap for Jarod-OS on Windows (twin of bootstrap.sh). Safe to re-run.
#   1. Fetch the pinned upstream snapshot (types for the gateway wire).
#   2. Install Node workspaces.
#   3. Link the system-bridge plugin into the user's Hermes plugins directory (a junction: no
#      administrator rights or Developer Mode needed, unlike a symbolic link).
#   4. Find the Hermes runtime, migrate pre-rename settings, enable the plugin and its toolset.
#   5. Report voice support.
# Variables renamed with Jarod-OS (2026-10-19): an older HERALD_OS_* still counts when JAROD_OS_* is unset (the new name wins).
# HERALD_OS_DEV_UNSIGNED keeps its name (contract c8). Only names are handled here; no value is printed.
Get-ChildItem Env: | Where-Object { $_.Name -like 'HERALD_OS_*' -and $_.Name -ne 'HERALD_OS_DEV_UNSIGNED' } | ForEach-Object {
    $jarodName = 'JAROD_OS_' + $_.Name.Substring('HERALD_OS_'.Length)
    if (-not (Test-Path "Env:$jarodName")) { Set-Item -Path "Env:$jarodName" -Value $_.Value }
}

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$HermesRootOverride = if ($env:JAROD_OS_HERMES_ROOT) { $env:JAROD_OS_HERMES_ROOT } else { $env:HERMES_OS_HERMES_ROOT }

function Write-Step($text) { Write-Host "==> $text" }
function Write-Note($text) { Write-Host "    $text" }

function Invoke-Native {
    # Native commands write progress to stderr; with $ErrorActionPreference = Stop, Windows PowerShell
    # 5.1 would turn that into a terminating error.
    param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $here = (Get-Location).Path
    if ($WorkingDirectory -and (Test-Path $WorkingDirectory)) { Set-Location $WorkingDirectory }
    try {
        $output = $null | & $File @Arguments 2>&1
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output | Out-String).Trim() }
    } finally {
        Set-Location $here
        $ErrorActionPreference = $previous
    }
}

Write-Step 'Syncing upstream snapshot'
& (Join-Path $PSScriptRoot 'sync-upstream.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Step 'Installing Node workspaces'
Push-Location $Root
try {
    # `npm run` re-exports a user-level `allow-scripts` setting as an environment variable, which a
    # nested project-scoped `npm install` rejects (EALLOWSCRIPTS); package.json carries allowScripts.
    Remove-Item Env:npm_config_allow_scripts -ErrorAction SilentlyContinue
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally { Pop-Location }

Write-Step 'Fetching the Electron binary'
Push-Location (Join-Path $Root 'apps/desktop')
try {
    & node -e "require('electron')"
    if ($LASTEXITCODE -ne 0) { Write-Note 'WARNING: could not download Electron; npm run dev will try again' }
} finally { Pop-Location }

Write-Step "Linking the bridge plugin (jarod-os-bridge) into $HermesHome\plugins"
# scripts/link-bridge.ps1 (tested by scripts/link-bridge.test.ps1): the new link, and the older one removed only when it is ours.
& (Join-Path $PSScriptRoot 'link-bridge.ps1') -HermesHome $HermesHome -Root $Root
if ($LASTEXITCODE -ne 0) { throw 'linking the bridge plugin failed' }

Write-Step 'Verifying Hermes runtime'
$HermesPy = $null
$HermesCmd = $null
$runtimeRoot = if ($HermesRootOverride) { $HermesRootOverride } else { Join-Path $HermesHome 'hermes-agent' }
$venvPy = Join-Path $runtimeRoot 'venv/Scripts/python.exe'

if ($HermesRootOverride -and (Test-Path $venvPy)) {
    Write-Note "JAROD_OS_HERMES_ROOT=$HermesRootOverride"
    $HermesPy = $venvPy
} elseif (Test-Path (Join-Path $HermesHome 'hermes-agent/venv/Scripts/python.exe')) {
    Write-Note "managed install: $HermesHome\hermes-agent"
    $HermesPy = Join-Path $HermesHome 'hermes-agent/venv/Scripts/python.exe'
} else {
    $found = Get-Command hermes -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        Write-Note "hermes on PATH: $($found.Source)"
        $HermesCmd = @($found.Source)
    } else {
        Write-Note 'WARNING: no Hermes runtime found. Install it, then re-run this script:'
        Write-Note '  iex (irm https://hermes-agent.nousresearch.com/install.ps1)'
    }
}

if ($HermesPy) { $HermesCmd = @($HermesPy, '-m', 'hermes_cli.main') }

function Invoke-Hermes([string[]]$Arguments) {
    $head = @($HermesCmd | Select-Object -Skip 1)
    return Invoke-Native -File $HermesCmd[0] -Arguments ($head + $Arguments) -WorkingDirectory $runtimeRoot
}

if ($HermesCmd) {
    if ($HermesPy) {
        Write-Step 'Migrating settings from the pre-rename Hermes OS'
        $env:HERMES_HOME = $HermesHome
        $env:PYTHONPATH = $runtimeRoot + $(if ($env:PYTHONPATH) { ";$env:PYTHONPATH" } else { '' })
        $r = Invoke-Native -File $HermesPy -Arguments @((Join-Path $Root 'scripts/migrate-hermes-config.py'))
        if ($r.Output) { Write-Note $r.Output }
    }

    Write-Step 'Enabling the system bridge plugin and its toolset'
    # The override prompt is answered "no" (stdin closed): the bridge never replaces built-in tools.
    $null = Invoke-Hermes @('plugins', 'enable', 'jarod-os-bridge')
    $r = Invoke-Hermes @('tools', 'enable', 'herald_os')
    if ($r.Output) { Write-Note ($r.Output -split "`n" | Select-Object -Last 1) }
    Write-Note 'tools.tool_search.enabled = off (system tools stay directly callable)'
    $null = Invoke-Hermes @('config', 'set', 'tools.tool_search.enabled', 'off')

    Write-Step 'Checking voice support (docs/VOICE.md)'
    if (Test-Path (Join-Path $runtimeRoot 'tools/voice_live.py')) {
        Write-Note 'voice-live routes: available'
    } elseif (Test-Path $runtimeRoot) {
        Write-Note "WARNING: this Hermes has no voice-live routes; run 'hermes update' for the Live voice engine."
    }
    if ($HermesPy) {
        $probe = @'
import importlib
for n, p in (("openwakeword", "wake word"), ("faster_whisper", "local STT"), ("edge_tts", "free TTS")):
    try:
        importlib.import_module(n)
        print(f"    {n}: ok ({p})")
    except Exception:
        print(f"    {n}: missing ({p}); install with: pip install hermes-agent[voice] inside the Hermes venv")
'@
        # A script file, not -c: Windows PowerShell 5.1 drops the double quotes of a native argument.
        $probeFile = Join-Path ([System.IO.Path]::GetTempPath()) ('herald-voice-probe-' + [guid]::NewGuid().ToString('N') + '.py')
        Set-Content -LiteralPath $probeFile -Value $probe -Encoding ascii
        try {
            $r = Invoke-Native -File $HermesPy -Arguments @($probeFile)
            if ($r.Output) { Write-Host $r.Output }
        } finally {
            Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Step 'Done. Start Jarod-OS with: npm run dev'
