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
| 10 | Page « Capacités & Évolution » (badges de confiance, registre, dépendances, mises à jour) + entrée de navigation | `apps/desktop/src/renderer` | à faire |
| 11 | Installeur : `npm run dist:win`, vérifier le bundle produit (24 plugins), installer sur place | `apps/desktop` | à faire |

`BUNDLE.json` : le script de bundle écrit déjà `node: process.version` et `gatewayBytes` **mesuré** (vérifié le 26/10 : v26.12.1, 9 029 571 octets, 24 plugins). Le fichier installé aujourd'hui est périmé parce qu'il vient de la copie statique de `D:\Jarod-OS\repo` ; le build final depuis ce dépôt le rendra exact, sans retouche à la main.

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

## État au 2026-10-26 23:47

- Étapes 1 à 7 faites et prouvées. `tsc --noEmit` **vert** sur kernel, platform, cli, workflows, agent.
- Tests : kernel **88**, platform **21**, workflows **39**, cli **502** (501 + 1 attendu en échec), agent **470** (469 + 1 ignoré).
- Le contrat V-04 est **préservé** : la sortie d'une lecture passe inchangée au modèle ; le signal d'injection
  reste dans la ligne d'audit et dans la teinture du tour. Seules les actions bloquantes retiennent leur sortie.
- Banc AgentDojo : couche `injection` ajoutée au classement ; mesure 68 non applicables + **2 bloquées par la
  garde** (elles l'étaient par l'accord) — aucune attaque réussie, une couche plus tôt.
- Étapes 8 et 9 faites : deux moteurs dans le **noyau** (`capability-engine.ts`, `runtime-deps.ts`) plus 14 RPC,
  pas dans deux nouveaux paquets : cela évite d'ajouter des entrées à `pnpm-lock.yaml` (impossible à régénérer ici,
  `pnpm` du PATH étant cassé). `tsc` vert ; kernel **102** tests (dont 14 nouveaux), cli **502**.
- Reste les étapes 10 et 11 : page « Capacités & Évolution » dans `apps/desktop`, puis `dist:win` et installation.
  **Aucun build ni installation n'a été lancé.**

Sauvegarde : un bundle git de **toutes les refs** du dépôt S: (16 branches, 45 refs, stash et têtes de worktrees
comprises) est vérifié dans `D:\Jarod-OS\backups\jarod-os-S-toutes-branches-2026-10-26.bundle`.

Incident mineur : lancer les binaires `node_modules/.bin/*` fait réécrire `jarod-core/pnpm-lock.yaml` (ajout de
`@pnpm/exe@12.6.0`). Remis à HEAD après chaque série (copies dans `backups/pnpm-lock.apres-*.yaml`) ; je n'ai
jamais committé cette modification.
