#requires -Version 5.1
<#
  strata-iq3xxs.ps1 -- demarrage, arret et diagnostic du serveur Strata local pour JAROD-OS.

  ASCII seulement : un .ps1 accentue doit etre enregistre avec BOM pour que
  PowerShell 5.1 le lise correctement, et ce fichier reste volontairement sans accent.

  Exemples :
    .\strata-iq3xxs.ps1 -Action status
    .\strata-iq3xxs.ps1 -Action start -Context 32k -VramReserveMib 2560 -MmapExperts
    .\strata-iq3xxs.ps1 -Action stop

  Le modele et le runtime restent hors du depot : chemins par defaut ci-dessous,
  surchargeables par parametre. Le serveur n'ecoute que sur 127.0.0.1.
#>
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'logs')]
    [string]$Action = 'status',
    [string]$Context = '32k',
    [int]$VramReserveMib = 2560,
    [switch]$MmapExperts,
    [switch]$Mtp,
    [string]$Port = '8080',
    [string]$ModelPath = 'D:\Jarod-OS\models\Qwen3.8-Flash-Next-Strata\IQ3_XXS',
    [string]$DataDir = 'D:\Jarod-OS\models\Qwen3.8-Flash-Next-Strata',
    [string]$StrataDataDir = 'D:\Jarod-OS\engines\strata',
    [string]$StrataExe = 'D:\Jarod-OS\engines\strata\terminal\current\bin\strata.cmd',
    [string]$Feed = 'https://github.com/Niko1221/Strata/releases/download/v0.2.7'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $StrataExe)) { throw "Strata introuvable : $StrataExe" }

$env:STRATA_DATA_DIR = $StrataDataDir
$env:STRATA_UPDATE_FEED = $Feed
$env:STRATA_FEED = $Feed

function Get-StrataEnv {
    $os = Get-CimInstance Win32_OperatingSystem
    $perf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $gpu = ''
    $free = ''
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $line = (& nvidia-smi --query-gpu=memory.free,memory.used --format=csv,noheader,nounits 2>$null) -join ' '
        $parts = $line -split ','
        if ($parts.Count -ge 2) { $free = $parts[0].Trim(); $gpu = $parts[1].Trim() }
    }
    [pscustomobject]@{
        RAMDisponibleGo     = [math]::Round($perf.AvailableMBytes / 1024, 2)
        EngagementPourcent  = $perf.PercentCommittedBytesInUse
        LecturesPagesParSe  = $perf.PageReadsPersec
        VramLibreMib        = $free
        VramUtiliseeMib     = $gpu
        StrataWsGo          = [math]::Round(((Get-Process strata -ErrorAction SilentlyContinue | Select-Object -First 1).WorkingSet64 / 1GB), 2)
        Ecoute              = [bool](Get-NetTCPConnection -State Listen -LocalPort ([int]$Port) -ErrorAction SilentlyContinue)
    }
}

function Show-Status {
    $s = Get-StrataEnv
    "port $Port en ecoute : $($s.Ecoute)"
    "RAM disponible      : $($s.RAMDisponibleGo) Go  (seuil d'arret : 6 Go)"
    "engagement          : $($s.EngagementPourcent) %  (seuil : 90 %)"
    "lectures de pages   : $($s.LecturesPagesParSe) /s"
    "VRAM libre          : $($s.VramLibreMib) MiB  (seuil d'arret : 2560 MiB)"
    "strata (WS)         : $($s.StrataWsGo) Go"
    if ($s.Ecoute) {
        try {
            $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 10
            "modele              : $($models.data[0].id)  (n_ctx $($models.data[0].meta.n_ctx))"
        } catch { "modele              : /v1/models injoignable ($($_.Exception.Message))" }
    }
}

switch ($Action) {
    'start' {
        $argv = @('launch', '--model-path', $ModelPath, '--context', $Context, '--vision', 'off',
                  '--port', $Port, '--access', 'local', '--data-dir', $DataDir, '--tune', 'skip',
                  '--yes', '--no-tui', '--set', "vram-reserve-mib=$VramReserveMib")
        if ($MmapExperts) { $argv += @('--set', 'mmap-experts=on') }
        if ($Mtp) { $argv += @('--mtp', 'on') } else { $argv += @('--mtp', 'off', '--drafting', 'off') }
        "demarrage : strata $($argv -join ' ')"
        & $StrataExe @argv
        if ($LASTEXITCODE -ne 0) { throw "strata launch a echoue (code $LASTEXITCODE)" }
        Show-Status
    }
    'stop' {
        & $StrataExe launch --stop
        Start-Sleep -Seconds 5
        Show-Status
    }
    'status' { Show-Status }
    'logs' {
        $log = Join-Path $env:LOCALAPPDATA "Strata\launch\iq3_xxs-$Context.engine.log"
        if (-not (Test-Path -LiteralPath $log)) { throw "journal introuvable : $log" }
        Get-Content -LiteralPath $log -Tail 40
    }
}
