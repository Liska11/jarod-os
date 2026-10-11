# Run the herald-os-bridge plugin tests and the Linux CLI tests (Windows twin of test-bridge.sh).
# Prefers the Hermes runtime's venv when it has pytest; otherwise runs in an ephemeral uv
# environment so the user's Hermes venv is never modified. HERALD_OS_PYTHON overrides the interpreter.
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$Py = if ($env:HERALD_OS_PYTHON) { $env:HERALD_OS_PYTHON } else { Join-Path $HermesHome 'hermes-agent/venv/Scripts/python.exe' }

Set-Location (Join-Path $Root 'plugins/herald-os-bridge/tests')
# The Linux CLI tests (linux/tests) import POSIX-only modules and do not run here; with no arguments
# the plugin's own tests run, and arguments (a file, -k) pick tests as in test-bridge.sh.
$suites = if ($args.Count -eq 0) { @('.') } else { @() }

# Native tools write to stderr; do not let that abort the script.
$ErrorActionPreference = 'Continue'

if (Test-Path $Py) {
    & $Py -c 'import pytest' 2>$null
    if ($LASTEXITCODE -eq 0) {
        & $Py -m pytest -q @suites @args
        exit $LASTEXITCODE
    }
}

if (Get-Command uv -ErrorAction SilentlyContinue) {
    & uv run --no-project --python 3.11 --with pytest --with pyyaml python -m pytest -q @suites @args
    exit $LASTEXITCODE
}

[Console]::Error.WriteLine("test-bridge: need either pytest in $Py or uv on PATH")
exit 1
