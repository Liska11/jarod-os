# End-to-end check of Jarod-OS on Windows:
#   Hermes reachable -> bridge plugin enabled -> gateway answers (hermes serve + JSON-RPC over the
#   WebSocket lists the herald_os tools) -> a bridge tool is called the way the agent calls it
#   (Hermes's own tool registry, with the plugin loaded by Hermes) -> an audit entry exists.
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 [-SkipGateway] [-Tool system_info]
#
# It starts its own `hermes serve` on a free loopback port and stops it afterwards; it writes one
# audit entry (a read-only tool) and changes nothing else. Exit code 0 only when every step passed.
param(
    [switch]$SkipGateway,
    [string]$Tool = 'system_info',
    [int]$TimeoutSeconds = 90
)

# Variables renamed with Jarod-OS (2026-10-19): an older HERALD_OS_* still counts when JAROD_OS_* is unset (the new name wins).
# HERALD_OS_DEV_UNSIGNED keeps its name (contract c8). Only names are handled here; no value is printed.
Get-ChildItem Env: | Where-Object { $_.Name -like 'HERALD_OS_*' -and $_.Name -ne 'HERALD_OS_DEV_UNSIGNED' } | ForEach-Object {
    $jarodName = 'JAROD_OS_' + $_.Name.Substring('HERALD_OS_'.Length)
    if (-not (Test-Path "Env:$jarodName")) { Set-Item -Path "Env:$jarodName" -Value $_.Value }
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$HermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
$RuntimeRoot = if ($env:JAROD_OS_HERMES_ROOT) { $env:JAROD_OS_HERMES_ROOT } else { Join-Path $HermesHome 'hermes-agent' }
$Py = Join-Path $RuntimeRoot 'venv\Scripts\python.exe'
$AuditFile = Join-Path $HermesHome 'herald-os\audit.jsonl'
$Results = New-Object System.Collections.Generic.List[object]
$Server = $null
$Scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('herald-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Scratch | Out-Null

function Add-Result([string]$Name, [bool]$Ok, [string]$Detail) {
    $Results.Add([pscustomobject]@{ Step = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1}: {2}" -f $mark, $Name, $Detail)
}

function Invoke-Python([string[]]$Arguments) {
    # Native tools write to stderr; with $ErrorActionPreference = Stop that would abort the script.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $here = (Get-Location).Path
    Set-Location $RuntimeRoot
    try {
        $env:HERMES_HOME = $HermesHome
        # A script file puts its own folder on sys.path, not the checkout: an editable install does not map every top-level module.
        $env:PYTHONPATH = $RuntimeRoot
        $out = & $Py @Arguments 2>&1
        return [pscustomobject]@{ Code = $LASTEXITCODE; Output = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
    } finally {
        Set-Location $here
        $ErrorActionPreference = $previous
    }
}

function Stop-Tree([System.Diagnostics.Process]$Process) {
    # Cleanup only: a taskkill that fails (the tree is already gone, access denied) must never change the verdict.
    # With $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns the native tool's stderr into a terminating error,
    # and thrown from the finally block it ended the script with exit code 1 after six passing steps.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Process -and -not $Process.HasExited) {
            & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
        }
    } catch {
        # The process is gone or cannot be stopped; nothing more to do here.
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Receive-Frame($Socket, [int]$Milliseconds) {
    $buffer = New-Object byte[] 65536
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList (, $buffer)
    $cts = New-Object System.Threading.CancellationTokenSource($Milliseconds)
    $text = New-Object System.Text.StringBuilder
    do {
        $result = $Socket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
        [void]$text.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
    } until ($result.EndOfMessage)
    return $text.ToString()
}

try {
    # 1. Hermes reachable.
    if (-not (Test-Path $Py)) {
        Add-Result 'Hermes runtime' $false "no Hermes at $RuntimeRoot (install: iex (irm https://hermes-agent.nousresearch.com/install.ps1))"
        throw 'stop'
    }
    $version = Invoke-Python @('-m', 'hermes_cli.main', '--version')
    $versionLine = ($version.Output -split "`n" | Select-Object -First 1)
    Add-Result 'Hermes runtime' ($version.Code -eq 0 -and $versionLine -match 'Hermes') ("{0}  [{1}]" -f $versionLine, $RuntimeRoot)

    # 2. The bridge is linked and enabled.
    $link = Join-Path $HermesHome 'plugins\jarod-os-bridge'
    $config = Join-Path $HermesHome 'config.yaml'
    $linked = Test-Path (Join-Path $link 'plugin.yaml')
    $enabled = (Test-Path $config) -and ((Get-Content -Raw $config) -match 'jarod-os-bridge')
    Add-Result 'Bridge plugin' ($linked -and $enabled) ("linked={0} enabled={1} ({2}); run npm run bootstrap if not" -f $linked, $enabled, $link)

    # 3. Gateway: hermes serve, then tools.list over the JSON-RPC WebSocket.
    if ($SkipGateway) {
        Add-Result 'Gateway' $true 'skipped (-SkipGateway)'
    } else {
        $token = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 } | ForEach-Object { [byte]$_ })).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $out = Join-Path $Scratch 'serve-out.txt'
        $err = Join-Path $Scratch 'serve-err.txt'
        $env:HERMES_HOME = $HermesHome
        $env:HERMES_DASHBOARD_SESSION_TOKEN = $token
        $env:HERMES_DESKTOP = '1'
        $env:HERALD_OS = '1'
        $env:PYTHONUNBUFFERED = '1'
        $Server = Start-Process -FilePath $Py -ArgumentList @('-m', 'hermes_cli.main', 'serve', '--host', '127.0.0.1', '--port', '0') -WorkingDirectory $RuntimeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null = $Server.Handle  # keeps ExitCode readable after the process ends

        $port = $null
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while ((Get-Date) -lt $deadline -and -not $port) {
            if ($Server.HasExited) { break }
            $seen = if (Test-Path $out) { Get-Content -Raw $out } else { $null }
            if ($seen) {
                $m = [regex]::Match($seen, '(?m)^(?:HERMES_BACKEND_READY|HERMES_DASHBOARD_READY)\s+port=(\d+)')
                if ($m.Success) { $port = [int]$m.Groups[1].Value }
            }
            Start-Sleep -Milliseconds 300
        }
        if (-not $port) {
            $why = ((Get-Content $out, $err -ErrorAction SilentlyContinue | Where-Object { $_ } | Select-Object -Last 3) -join ' | ')
            Add-Result 'Gateway' $false ("hermes serve did not become ready (exit {0}): {1}" -f $(if ($Server.HasExited) { $Server.ExitCode } else { 'running' }), $why)
            throw 'stop'
        }

        $status = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/status" -Headers @{ 'X-Hermes-Session-Token' = $token } -TimeoutSec 15
        Add-Result 'Gateway status' ($status.StatusCode -eq 200) "GET /api/status on 127.0.0.1:$port"

        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        $socket.ConnectAsync([Uri]"ws://127.0.0.1:$port/api/ws?token=$token", [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
        $request = '{"jsonrpc":"2.0","id":"verify-1","method":"tools.list","params":{}}'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
        $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList (, $bytes)
        $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
        $reply = $null
        $until = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $until -and -not $reply) {
            $frame = Receive-Frame $socket 30000 | ConvertFrom-Json
            if ($frame.id -eq 'verify-1') { $reply = $frame }
        }
        $socket.Dispose()
        $herald = $null
        if ($reply -and $reply.result) { $herald = @($reply.result.toolsets) | Where-Object { $_.name -eq 'herald_os' } | Select-Object -First 1 }
        $listed = $herald -and ((-not $herald.tools) -or (@($herald.tools) -contains $Tool))
        Add-Result 'Gateway tools.list' ([bool]$listed) $(if ($herald) { "toolset herald_os: $($herald.tool_count) tools, enabled=$($herald.enabled)" } else { 'the herald_os toolset is not in the gateway reply' })
    }

    # 4 + 5. A bridge tool through Hermes's registry, then its audit entry.
    $before = if (Test-Path $AuditFile) { @(Get-Content $AuditFile).Count } else { 0 }
    $script = Join-Path $Scratch 'call-tool.py'
    @"
import json
from hermes_cli.plugins import discover_plugins

discover_plugins()
from tools.registry import registry

out = registry.dispatch("$Tool", {})
print(out if isinstance(out, str) else json.dumps(out))
"@ | Set-Content -Path $script -Encoding ascii
    $call = Invoke-Python @($script)
    $payload = $null
    try { $payload = ($call.Output -split "`n" | Select-Object -Last 1) | ConvertFrom-Json } catch { }
    Add-Result "Tool call ($Tool)" ($call.Code -eq 0 -and $payload -and $payload.success -eq $true) $(if ($payload -and $payload.success) { 'the registry ran the bridge handler' } else { ($call.Output -split "`n" | Select-Object -Last 2) -join ' | ' })

    # @() around the whole expression: a one-line file would otherwise come back as a string, not a list.
    $after = @(if (Test-Path $AuditFile) { Get-Content $AuditFile })
    $entry = $null
    if ($after.Count -gt $before) { try { $entry = $after[-1] | ConvertFrom-Json } catch { } }
    $expected = @('ts', 'tool', 'tier', 'action', 'decision', 'ok', 'summary', 'error', 'args')
    $shape = $entry -and ((@($entry.PSObject.Properties.Name) -join ',') -eq ($expected -join ','))
    Add-Result 'Audit entry' ([bool]($entry -and $entry.tool -eq $Tool -and $entry.ok -eq $true -and $shape)) $(if ($entry) { "$AuditFile -> tool=$($entry.tool) tier=$($entry.tier) decision=$($entry.decision) ok=$($entry.ok)" } else { "no new line in $AuditFile" })
} catch {
    if ($_.Exception.Message -ne 'stop') {
        Add-Result 'Unexpected error' $false $_.Exception.Message
    }
} finally {
    Stop-Tree $Server
    Remove-Item -Recurse -Force $Scratch -ErrorAction SilentlyContinue
}

Write-Host ''
$failed = @($Results | Where-Object { -not $_.Ok }).Count
if ($failed -eq 0 -and $Results.Count -gt 0) {
    Write-Host ("All {0} steps passed." -f $Results.Count)
    exit 0
}
Write-Host ("{0} of {1} steps failed." -f $failed, $Results.Count)
exit 1
