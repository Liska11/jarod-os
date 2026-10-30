# Ouvre Jarod-OS et démarre en même temps WSL + Qwen3.8-Flash-Next (port 30000). LFM3-Omni (port 8080) est démarré par Jarod lui-même
# (préréglage actif + « démarrage automatique » dans Réglages › Modèles locaux). Raccourci : « Jarod-OS + IA » sur le Bureau.
# Tant que la build de Jarod ne contient pas l'autostart Qwen (bridge/src/main/qwen-flash-autostart.ts), ce lanceur en tient lieu.
$launcher = Join-Path $PSScriptRoot 'start-qwen-flash.ps1'
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`""
if (-not (Get-Process 'Jarod-OS' -ErrorAction SilentlyContinue)) { Start-Process 'C:\Program Files\Jarod-OS\Jarod-OS.exe' }
