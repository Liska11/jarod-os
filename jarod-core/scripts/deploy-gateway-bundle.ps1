<#
.SYNOPSIS
  Met la passerelle de Jarod-OS construite depuis ce depot dans une installation existante.

.DESCRIPTION
  Sert quand l'installateur utilise ne contient pas encore le code du depot (par exemple l'envoi de la
  liste d'adresses au telephone : `addresses`, nom MagicDNS). Un installateur construit depuis cette
  branche (`npm run dist:win`) l'embarque deja : dans ce cas le script le dit et ne fait rien.

  Il ne tue JAMAIS Jarod : si l'application tourne, il s'arrete. Il sauvegarde avant de remplacer, et
  `-Rollback` remet la sauvegarde. Il ne remplace que `gateway.mjs` et `BUNDLE.json`.

.PARAMETER InstallDir
  Dossier d'installation. Par defaut : celui trouve parmi `C:\Program Files\Jarod-OS` et
  `%LOCALAPPDATA%\Programs\Jarod-OS`.

.PARAMETER Check
  Ne modifie rien : construit le bundle dans un dossier temporaire, le verifie, et dit ce qui serait fait.

.PARAMETER Rollback
  Remet la derniere sauvegarde (`gateway.mjs.bak-*`).

.PARAMETER Force
  Continue malgre une difference de plugins ou de version de Node entre l'installation et le depot.

.EXAMPLE
  # 1. Jarod ferme. 2. Verifier :
  powershell -ExecutionPolicy Bypass -File jarod-core\scripts\deploy-gateway-bundle.ps1 -Check
  # 3. Deployer (PowerShell en administrateur si l'installation est sous Program Files) :
  powershell -ExecutionPolicy Bypass -File jarod-core\scripts\deploy-gateway-bundle.ps1
  # Retour arriere :
  powershell -ExecutionPolicy Bypass -File jarod-core\scripts\deploy-gateway-bundle.ps1 -Rollback
#>
[CmdletBinding()]
param(
  [string]$InstallDir,
  [switch]$Check,
  [switch]$Rollback,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$markers = @('announceAddresses', 'hostAddresses', 'magicDnsNameFrom')
$coreRoot = Split-Path -Parent $PSScriptRoot   # ...\jarod-core

function Say([string]$m) { Write-Host $m }
function Stop-Here([string]$m) { Write-Host "ARRET : $m" -ForegroundColor Red; exit 1 }

# --- 1. L'installation -------------------------------------------------------------------------
if (-not $InstallDir) {
  $candidates = @('C:\Program Files\Jarod-OS', (Join-Path $env:LOCALAPPDATA 'Programs\Jarod-OS'))
  $InstallDir = $candidates | Where-Object { Test-Path (Join-Path $_ 'Jarod-OS.exe') } | Select-Object -First 1
}
if (-not $InstallDir -or -not (Test-Path (Join-Path $InstallDir 'Jarod-OS.exe'))) {
  Stop-Here "Jarod-OS introuvable. Indiquez le dossier avec -InstallDir 'C:\...\Jarod-OS'."
}
$target = Join-Path $InstallDir 'resources\jarod-core'
$gateway = Join-Path $target 'gateway.mjs'
$inventory = Join-Path $target 'BUNDLE.json'
if (-not (Test-Path $gateway)) { Stop-Here "gateway.mjs absent de $target." }
Say "Installation : $InstallDir"

# --- 2. Jarod ne doit pas tourner (on ne le ferme jamais a sa place) ----------------------------
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
}
if ($running -and -not $Check) {
  Stop-Here ("Jarod-OS tourne ({0} processus). Fermez-le completement (Gestionnaire des taches : plus aucun Jarod-OS.exe), puis relancez ce script." -f @($running).Count)
}
if ($running) { Say ("(Jarod tourne : -Check ne modifie rien, on continue.)") }

# --- Retour arriere ----------------------------------------------------------------------------
if ($Rollback) {
  $bak = Get-ChildItem $target -Filter 'gateway.mjs.bak-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $bak) { Stop-Here "Aucune sauvegarde gateway.mjs.bak-* dans $target." }
  $stamp = $bak.Name -replace '^gateway\.mjs\.bak-', ''
  Copy-Item $bak.FullName $gateway -Force
  $invBak = Join-Path $target "BUNDLE.json.bak-$stamp"
  if (Test-Path $invBak) { Copy-Item $invBak $inventory -Force }
  Say "Sauvegarde remise en place ($($bak.Name)). Relancez Jarod."
  exit 0
}

# --- 3. Deja a jour ? --------------------------------------------------------------------------
$installedText = [IO.File]::ReadAllText($gateway)
$missing = $markers | Where-Object { -not $installedText.Contains($_) }
if (-not $missing) {
  Say "Cette installation contient deja le code des adresses : rien a faire."
  exit 0
}
Say ("Installation sans : {0}" -f ($missing -join ', '))

# --- 4. Construction dans un dossier temporaire, et verification --------------------------------
$out = Join-Path $env:TEMP ('jarod-gateway-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
Say "Construction du bundle depuis $coreRoot ..."
Push-Location $coreRoot
try { & node scripts/bundle-gateway.mjs --out $out; if ($LASTEXITCODE -ne 0) { Stop-Here "La construction a echoue (code $LASTEXITCODE)." } }
finally { Pop-Location }
$newGateway = Join-Path $out 'gateway.mjs'
$newInventory = Join-Path $out 'BUNDLE.json'
if (-not (Test-Path $newGateway)) { Stop-Here "Bundle non produit : $newGateway." }
$newText = [IO.File]::ReadAllText($newGateway)
$absent = $markers | Where-Object { -not $newText.Contains($_) }
if ($absent) { Stop-Here ("Le bundle construit ne contient pas : {0}. Le depot n'est pas sur la bonne branche (attendu : ui-m3 ou plus recent)." -f ($absent -join ', ')) }
Say ("Bundle OK : {0:N0} octets, contient {1}." -f (Get-Item $newGateway).Length, ($markers -join ', '))

# --- 5. Meme famille de composants que l'installation ? -----------------------------------------
if ((Test-Path $inventory) -and (Test-Path $newInventory)) {
  $old = Get-Content $inventory -Raw | ConvertFrom-Json
  $new = Get-Content $newInventory -Raw | ConvertFrom-Json
  $diffs = @()
  # Le Node de BUNDLE.json est celui qui a lance la construction, pas celui de l'execution (celui d'Electron) :
  # a titre d'information seulement.
  if ($old.node -ne $new.node) { Say "  (information : construit avec Node $($new.node) ; l'installation l'avait ete avec $($old.node))" }
  $onlyOld = @($old.plugins | Where-Object { $new.plugins -notcontains $_ })
  $onlyNew = @($new.plugins | Where-Object { $old.plugins -notcontains $_ })
  if ($onlyOld) { $diffs += "plugins absents du depot : $($onlyOld -join ', ')" }
  if ($onlyNew) { $diffs += "plugins en plus dans le depot : $($onlyNew -join ', ')" }
  if ($diffs -and -not $Force) {
    $diffs | ForEach-Object { Say "  difference : $_" }
    Stop-Here "L'installation n'a pas les memes composants que le depot : le remplacement pourrait la casser. Reinstallez depuis ce depot (npm run dist:win), ou relancez avec -Force si vous savez ce que vous faites."
  }
}

if ($Check) {
  Say "-Check : rien n'a ete modifie. Pour deployer : relancez sans -Check (Jarod ferme)."
  Say "Bundle de verification : $out"
  exit 0
}

# --- 6. Sauvegarde, puis remplacement de gateway.mjs et BUNDLE.json -----------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
try {
  Copy-Item $gateway (Join-Path $target "gateway.mjs.bak-$stamp") -ErrorAction Stop
  if (Test-Path $inventory) { Copy-Item $inventory (Join-Path $target "BUNDLE.json.bak-$stamp") }
  Copy-Item $newGateway $gateway -Force -ErrorAction Stop
  if (Test-Path $newInventory) { Copy-Item $newInventory $inventory -Force }
} catch {
  Stop-Here ("Ecriture impossible dans $target ({0}). Relancez PowerShell en administrateur. Rien n'a ete casse : l'ancien fichier est intact ou sauvegarde." -f $_.Exception.Message)
}
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
Say ""
Say "Fait. Sauvegarde : gateway.mjs.bak-$stamp"
Say "Relancez Jarod, affichez un nouveau QR (le nom .ts.net y figure), puis ouvrez l'appli Android : Reglages > Diagnostic montre la liste mise a jour."
Say "Retour arriere : .\deploy-gateway-bundle.ps1 -Rollback"
