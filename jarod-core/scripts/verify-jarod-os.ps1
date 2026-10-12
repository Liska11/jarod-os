# Vérification de bout en bout du sélecteur de modèles de Jarod-OS (profil jetable, faux LM Studio local, vrai noyau, passerelle) :
#   passerelle joignable -> model.options (modèles découverts) -> /model fournisseur:modèle -> réglage persistant -> /api/config/raw à jour et sans secret.
#   powershell -ExecutionPolicy Bypass -File scripts\verify-jarod-os.ps1 [-TimeoutSeconds 120]
# N'ouvre PAS le profil réel de Jarod et ne touche pas à Hermes : tout vit dans un dossier temporaire supprimé à la fin. Code de sortie 0 seulement si tout passe.
param([int]$TimeoutSeconds = 120)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$Tsx = Join-Path $Root 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $Tsx)) { Write-Host "[FAIL] dépendances: $Tsx est absent (pnpm install)"; exit 2 }
$Out = Join-Path ([IO.Path]::GetTempPath()) ('verify-jarod-os-' + [guid]::NewGuid().ToString('N') + '.txt')
$p = Start-Process -FilePath $Tsx -ArgumentList 'src/gateway/verify.ts' -WorkingDirectory (Join-Path $Root 'packages\cli') -NoNewWindow -PassThru -RedirectStandardOutput $Out -RedirectStandardError "$Out.err"
$null = $p.Handle # sans cela, ExitCode peut rester vide après WaitForExit(délai)
if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
    Get-Content $Out -Encoding UTF8 -ErrorAction SilentlyContinue
    Write-Host "[FAIL] délai: plus de $TimeoutSeconds s"
    Remove-Item $Out, "$Out.err" -Force -ErrorAction SilentlyContinue
    exit 1
}
Get-Content $Out -Encoding UTF8
$code = $p.ExitCode
if ($null -eq $code) { $code = 1 }
if ($code -ne 0) { Get-Content "$Out.err" -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 15 }
Remove-Item $Out, "$Out.err" -Force -ErrorAction SilentlyContinue
exit $code
