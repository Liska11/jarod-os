# Portage des Phases 1 à 4 dans le monorepo (option A)

Contexte : deux dépôts coexistent et **aucun n'est inclus dans l'autre**.

- `D:\Jarod-OS\repo` (branche `main`, racine `7aeec37`, sans remote) : reconstruction depuis les
  artefacts publiés (asar + bundle) plus le travail des Phases 1 à 4 — registre de confiance,
  garde anti-injection en blocage, mode test des plugins, moteur de capacités, gestionnaire de
  dépendances, page « Capacités & Évolution » du renderer. Il produit un **payload** (asar +
  `jarod-core`), pas un installeur NSIS. C'est lui qui correspond **exactement** à l'installation
  actuelle (`app.asar` `4914bae9…`, `gateway.mjs` `443dc0bb…`).
- `S:\A0-Save\Jarod-0S-Dev\Jarod-OS` (branche `ui-m3`, remote GitHub) : le monorepo réel
  (`apps/desktop`, `jarod-core/packages/*` en TypeScript, `mobile/android`), `npm run dist:win`,
  mobile 1.1.1 (Material 3, MagicDNS, adresses), le commit `830f659` (adresses + MagicDNS), et des
  correctifs cœur du 25/10 (workspace/codespace, steering) absents du bundle installé.

Mesure : du bundle construit depuis S: (25/10 02:44) au gateway installé, `1246 insertions(+),
150 deletions(-)`. Les 1 246 lignes sont le travail des Phases 1 à 4 ; les 150 sont le travail
cœur de S: que l'installation n'a pas.

Décision retenue (26/10) : **porter les Phases 1 à 4 dans ce monorepo**, puis construire
l'installeur ici (`npm run dist:win`). Ce document suit ce portage.

---

## Principe

1. **Une seule implémentation par sujet** : la logique vit dans le paquet qui la porte, typée,
   avec ses tests. Pas de copie de bundle, pas de correctif de chaîne.
2. **Même fichier d'état que l'installation existante** quand il existe déjà, pour ne rien perdre :
   - registre de confiance : `HERMES_HOME/jarod-os/publisher-keys.json` (sinon `dataDir`) ;
   - plateforme de plugins : `dataDir/plugin-platform.json` (inchangé) ;
   - capacités et dépendances : `HERMES_HOME/jarod-os/capabilities/` et `runtime-policies.json`.
3. **Chaque étape est un commit atomique**, avec `tsc --noEmit` et les tests du paquet verts.
4. **Le journal** (`tool-audit.jsonl`) reçoit les mêmes entrées que dans la reconstruction :
   `trust`, `plugin`, `capability`.

## Étapes

| # | Sujet | Où | État |
|---|---|---|---|
| 1 | Registre de confiance (matrice official/verified/community/local, rotation, révocation) | `packages/kernel/src/publisher-trust.ts` (+ export `@jarod/kernel/publisher-trust`) | **fait** |
| 2 | Intégration à la plateforme : `verify()` décide avant la signature, `list()` expose `trust`/`trustRevoked`, `uninstall()` refuse un plugin actif | `packages/plugins/platform/src/platform.ts`, `index.ts` | **fait** |
| 3 | RPC `trust.list` / `trust.check` / `trust.add` / `trust.rotate` (approbation pour les mutations) | `packages/cli/src/gateway/server.ts` | **fait** |
| 4 | Tests de la matrice | `packages/kernel/test/publisher-trust.test.ts` | **fait** (10 cas) |
| 5 | RPC `trust.install`, `trust.installed`, `trust.uninstall`, `trust.disable`, `trust.enable` (approbation, refus explicites) | `server.ts` (services lus par `core.app.get`) + `governance.withPermissionGrant` | **fait** |
| 6 | Mode test des plugins (`testPlugin`, réseau coupé même déclaré, dossier temporaire, rien de retenu) + RPC `trust.test`, `plugins.host` | `plugins.ts`, `runner.cjs`, `server.ts` | **fait** |
| 7 | Garde anti-injection en blocage (politique, teinture par tour, corpus, mode mesuré) + RPC `injection.check` | `kernel/src/injection-guard.ts` + `plugins/agent` | **fait** |
| 8 | Moteur de capacités (radar, quarantaine, intégration réversible) + RPC `capability.*` | `kernel/src/capability-engine.ts` + `server.ts` | **fait** |
| 9 | Gestionnaire de dépendances d'exécution + RPC `deps.*` | `kernel/src/runtime-deps.ts` + `server.ts` | **fait** |
| 10 | Page « Capacités & Évolution » (badges, registre, dépendances, mises à jour) + entrée de navigation | `apps/desktop/src/features/capabilities` + `shell/apps.ts`, `MainWindow.tsx`, `components/app-icon.tsx` | **fait** |
| 11 | Installeur : `npm run dist:win` (contourné sans pnpm), vérifier le bundle produit (24 plugins), installer sur place | `apps/desktop` | **fait** (11a le 27/10 00:09, installation 11b le 27/10 00:30) |

`BUNDLE.json` : le script de bundle écrit `node: process.version` et `gatewayBytes` **mesuré**. Le build final l'a rendu exact — **v26.12.1, 9 077 565 octets, 994 entrées, 24 plugins** — et c'est cette valeur qui est installée depuis le 27/10 (l'ancienne copie statique de `D:\Jarod-OS\repo`, 8 993 204 / v24.22.1, a disparu avec l'ancienne installation).

## Vérifications de référence (à chaque étape)

```powershell
# types
& 'S:\A0-Save\Jarod-0S-Dev\Jarod-OS\jarod-core\node_modules\.bin\tsc.cmd' -p packages\kernel\tsconfig.json --noEmit
& '...\tsc.cmd' -p packages\plugins\platform\tsconfig.json --noEmit
& '...\tsc.cmd' -p packages\cli\tsconfig.json --noEmit
# tests
& '...\node_modules\.bin\vitest.cmd' run   # dans le paquet concerné
```

`pnpm` du PATH est cassé sur cette machine (shim vers `S:\.pnpm-store` absent) : utiliser les
binaires locaux `node_modules\.bin\*` ou `npm exec`.

## État au 2026-10-27 00:0x

- Étapes 1 à 7 faites et prouvées. `tsc --noEmit` **vert** sur kernel, platform, cli, workflows, agent.
- Tests : kernel **88**, platform **21**, workflows **39**, cli **502** (501 + 1 attendu en échec), agent **470** (469 + 1 ignoré).
- Le contrat V-04 est **préservé** : la sortie d'une lecture passe inchangée au modèle ; le signal d'injection
  reste dans la ligne d'audit et dans la teinture du tour. Seules les actions bloquantes retiennent leur sortie.
- Banc AgentDojo : couche `injection` ajoutée au classement ; mesure 68 non applicables + **2 bloquées par la
  garde** (elles l'étaient par l'accord) — aucune attaque réussie, une couche plus tôt.
- Étapes 8 et 9 faites : deux moteurs dans le **noyau** (`capability-engine.ts`, `runtime-deps.ts`) plus 14 RPC,
  pas dans deux nouveaux paquets : cela évite d'ajouter des entrées à `pnpm-lock.yaml` (impossible à régénérer ici,
  `pnpm` du PATH étant cassé). `tsc` vert ; kernel **102** tests (dont 14 nouveaux), cli **502**.
- Étape 10 faite : page `CapabilitiesPage.tsx` (4 sections), enregistrée dans `PageId`/`AppIconId`/`PAGES`/route lazy,
  test DOM `capabilities-page.test.tsx` (jsdom + testing-library, gateway en doublure) — 4 cas verts. `tsc` du
  renderer vert ; suite renderer **194 fichiers, 1561 passés, 3 ignorés, 0 échec**.
- Piège n°4 corrigé : catégorie `authority-command` (autorité usurpée + verbe d'action), **8/8 bloqués, 0 faux
  positif** sur les 20 contenus légitimes. Le préfixe seul reste faible.
- `pnpm-lock.yaml` : toujours remis à HEAD après chaque série de tests (copies dans `backups/pnpm-lock.apres-*.yaml`).
- Étape 11 faite : build 11a le 27/10 à 00:09 et **installation en place le 27/10 à 00:30** — voir la section
  « Étape 11 » ci-dessous et `docs/RECETTE-PREMIER-LANCEMENT.md` pour les essais manuels.

Sauvegarde : un bundle git de **toutes les refs** du dépôt S: (16 branches, 45 refs, stash et têtes de worktrees
comprises) est vérifié dans `D:\Jarod-OS\backups\jarod-os-S-toutes-branches-2026-10-26.bundle`.

Incident mineur : lancer les binaires `node_modules/.bin/*` fait réécrire `jarod-core/pnpm-lock.yaml` (ajout de
`@pnpm/exe@12.6.0`). Remis à HEAD après chaque série (copies dans `backups/pnpm-lock.apres-*.yaml`) ; je n'ai
jamais committé cette modification.

---

## Étape 11 — build et installation (27/10/2026)

### 11a — fabrication, sans pnpm et sans toucher au verrou

`dist:win` exige `pnpm` (porte de `apps/desktop/scripts/bundle-core.mjs`) et le `pnpm` du PATH est le shim cassé du
runtime. Les étapes ont donc été rejouées **à la main, dans l'ordre du script**, sans installer d'outil et sans
réécrire `pnpm-lock.yaml` :

| Étape du script | Remplacement |
|---|---|
| `pnpm --version` (porte) | franchie autrement : la commande qu'elle protège est lancée directement |
| `pnpm install --prefer-frozen-lockfile` | sans objet (`jarod-core/node_modules` déjà en place) |
| `bundle-gateway.mjs --out jarod-core/dist/gateway` | identique (node + esbuild, 0,3 s) |
| sonde Electron sur le module natif | identique → **aucun `node.exe` embarqué** |
| `bundle:pinokio` / `bundle:restic` / `bundle:updater` | identiques (npm sauté par cache, `tar.exe` + empreintes, `cargo build --release --locked`) |
| `vite build` + `bundle-electron.mjs` | identiques (binaires de la racine) |
| `electron-builder --win --x64 -c.npmRebuild=false --publish never` | identique, avec `--config.directories.output=release-etape11a` (forme courte `-c.directories.…` mal analysée par yargs) |

Produit : `apps/desktop/release-etape11a/JarodOS-Setup-0.1.0-alpha.1-win-x64.exe`, 149 506 922 octets,
SHA-256 `8AB9A6F0E957FE11D3E85CD934AD485328FDED55AA6DA8157D35DBEAC69690E1`, **non signé** (aucun certificat).
L'ancienne sortie `apps/desktop/release/` n'a pas été touchée.

### 11b — installation en place, silencieuse

`Start-Process -ArgumentList '/S' -Wait` (UAC acceptée), 70 s. L'installeur s'est comporté en **mise à jour en
place** : le désinstalleur de l'installation précédente existe (`HKLM\…\Uninstall\cc62812a-…`,
`HKLM\Software\cc62812a-…\InstallLocation = C:\Program Files\Jarod-OS`), donc l'ancien arbre a été retiré d'un bloc
(`atomicRMDir`) avant la pose — les `.cjs` propres au build D: et `node-addon-api` dépaqueté ont bien disparu.

Vérifié après installation : version `0.1.0-alpha.1` ; `gateway.mjs` **9 077 565** o ; `app.asar` **6 324 061** o ;
`BUNDLE.json` **v26.12.1 / 9 077 565 / 24 plugins** ; `10 054` fichiers **identiques au bit près** au `win-unpacked` ;
registre et `InstallLocation` inchangés ; raccourcis du menu Démarrer intacts ; `D:\Jarod-OS\data` **104/104
identiques** et `D:\Jarod-OS\stt` **38 947/38 947 identiques**.

**Écart accepté (décision du 27/10)** : 8 binaires **ARM64** de `node-pty` (`prebuilds\win32-arm64\winpty.dll`,
`winpty-agent.exe`, `conpty\conpty.dll`, `conpty\OpenConsole.exe`, et les deux copies `third_party\…\win10-arm64`)
ne sont pas posés par l'installeur, alors que l'archive les contient (`7za x` du Setup rend les 10 062 fichiers).
Cause la plus probable : 7-Zip applique le filtre **BCJ ARM64** aux `.exe`/`.dll` (pas aux `.node`, d'où 8 fichiers
sur les 11 PE ARM64) et le plugin d'extraction NSIS 3.0.4.1 d'electron-builder ne décode pas ce filtre. Ces fichiers
ne sont **jamais chargés sur x64** (le chargeur prend `prebuilds/win32-x64`) et l'installation du 25/10 les avait
déjà manquants : **rien à corriger**, pas de reconstruction, pas de restauration. L'arbre installé compte donc
10 055 fichiers = 10 062 − 8 + `Uninstall Jarod-OS.exe`.

### À ne plus utiliser : `install-payload.ps1` du dépôt D:

Le script `install-payload.ps1` de `D:\Jarod-OS\repo` **ne doit plus servir**. Il recopiait l'ancien payload
(`jarod-core\*.cjs` et l'`app.asar` de D:) par-dessus l'installation : il **écraserait le port** — les Phases 1 à 4
vivent maintenant dans `gateway.mjs` et dans l'asar du build S: — et ferait réapparaître les quatre modules
`capability-engine.cjs`, `injection-guard.cjs`, `publisher-trust.cjs`, `runtime-deps.cjs` que ce build n'embarque
plus. Toute mise à jour passe par l'installeur (ou `Uninstall Jarod-OS.exe /allusers /S` puis l'installeur), jamais
par une copie de fichiers.

Sauvegarde d'avant 11b : `D:\Jarod-OS\backups\avant-11b-2026-10-27\` (installation 10 077 fichiers / 478,5 Mo,
données 104 / 1 180,0 Mo, `%APPDATA%\Jarod-OS`, registre, raccourcis, manifestes d'empreintes et
`RESTAURATION.ps1` — non exécuté, conservé comme plan de retour).
