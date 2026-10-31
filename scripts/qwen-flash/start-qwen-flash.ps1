# Qwen3.8-Flash-Next (lean-qwenflash) dans WSL2 : démarre / arrête / interroge le serveur OpenAI sur 127.0.0.1:30000.
# Fournisseur Jarod : « qwen-flash-wsl » (jarod-core/packages/plugins/llm/src/catalog.ts). Rapport : D:\lqf-wsl\RAPPORT.md
#   .\start-qwen-flash.ps1            démarre (si besoin) et attend que l'API réponde
#   .\start-qwen-flash.ps1 -Stop      arrête le serveur (libère la VRAM)
#   .\start-qwen-flash.ps1 -Status    état + VRAM
#   .\start-qwen-flash.ps1 -Remount   rattache le disque virtuel du store sur D: (invite UAC : droits administrateur requis par WSL)
[CmdletBinding()]
param([switch]$Stop, [switch]$Status, [switch]$Remount, [int]$TimeoutSec = 420)

$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu-24.04'
$Api = 'http://127.0.0.1:30000/v1/models'
$Admin = 'D:\lqf-wsl\admin\remount-store.ps1'

function Test-Api { try { Invoke-RestMethod -Uri $Api -TimeoutSec 3 | Out-Null; $true } catch { $false } }
function Get-VramMiB { (& nvidia-smi --query-gpu=memory.used '--format=csv,noheader,nounits' | Select-Object -First 1).Trim() }
function Test-Store { (& wsl.exe -d $Distro -e bash -c 'test -f /mnt/wsl/lqfstore/qwen.bin || test -f /mnt/lqfstore/qwen.bin; echo $?') -eq '0' }

if ($Status) {
    "API       : $(if (Test-Api) { 'répond' } else { 'éteinte' })"
    "Store (D:): $(if (Test-Store) { 'attaché' } else { 'détaché (utiliser -Remount)' })"
    "VRAM      : $(Get-VramMiB) MiB utilisés"
    return
}
if ($Remount) {
    Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Admin
    "Store (D:): $(if (Test-Store) { 'attaché' } else { 'toujours détaché' })"
    return
}
if ($Stop) {
    & wsl.exe -d $Distro -e bash -c 'pkill -INT -f qwen_server.py; sleep 3; pgrep -f qwen_server.py >/dev/null && pkill -KILL -f qwen_server.py; true'
    "Serveur arrêté. VRAM : $(Get-VramMiB) MiB utilisés"
    return
}

if (Test-Api) { 'Déjà démarré : http://127.0.0.1:30000/v1'; return }

# Qwen prend ~17 Go sur 20 : un autre modèle sur la RTX ferait échouer le chargement.
$used = [int](Get-VramMiB)
if ($used -gt 4500) { Write-Warning "La RTX utilise déjà $used MiB (bureau seul : ~2 600). Déchargez le modèle llama.cpp / LM Studio avant de continuer." }
if (-not (Test-Store)) { throw "Le store des experts (disque virtuel sur D:) n'est pas attaché à WSL. Lancez : .\start-qwen-flash.ps1 -Remount" }

$log = Join-Path $env:TEMP 'qwen-flash-server.log'
Start-Process -FilePath wsl.exe -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
    -ArgumentList '-d', $Distro, '-e', 'bash', '-lc', '"exec bash ~/lean-qwenflash-patch/wsl/serve.sh"'
$t0 = Get-Date
while (-not (Test-Api)) {
    if (((Get-Date) - $t0).TotalSeconds -gt $TimeoutSec) { throw "Le serveur ne répond pas après $TimeoutSec s. Journal : $log (et $log.err)" }
    Start-Sleep -Seconds 3
}
"Prêt en $([int]((Get-Date) - $t0).TotalSeconds) s : http://127.0.0.1:30000/v1 (modèle qwen3.8-flash-next). VRAM : $(Get-VramMiB) MiB"
