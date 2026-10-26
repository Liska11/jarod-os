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
| 5 | RPC `trust.install`, `trust.installed`, `trust.uninstall`, `trust.disable`, `trust.enable` + ponts de portée plugin (même mécanisme que la reconstruction) | `packages/plugins/workflows/src/plugins.ts` (ponts) + `server.ts` | à faire |
| 6 | Mode test des plugins (`testPlugin`) + RPC `trust.test`, `plugins.host` | `plugins.ts`, `server.ts` | à faire |
| 7 | Garde anti-injection en blocage (politique, teinture par tour, motifs) + RPC `injection.check` | `packages/kernel/src/injection-guard.ts` + `packages/plugins/agent` | à faire |
| 8 | Moteur de capacités (radar, quarantaine, intégration réversible) + RPC `capability.*` | nouveau paquet `packages/plugins/capabilities` | à faire |
| 9 | Gestionnaire de dépendances d'exécution + RPC `deps.*` | nouveau paquet `packages/plugins/dependencies` | à faire |
| 10 | Page « Capacités & Évolution » (badges de confiance, registre, dépendances, mises à jour) + entrée de navigation | `apps/desktop/src/renderer` | à faire |
| 11 | Installeur : `npm run dist:win`, vérifier le bundle produit (24 plugins), installer sur place | `apps/desktop` | à faire |

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

## État au 2026-10-26 22:52

- Étapes 1 à 4 faites et prouvées : `kernel` 10 tests, `platform` 21 tests, `cli/gateway-server`
  29 tests, `tsc --noEmit` vert sur les trois paquets.
- Reste les étapes 5 à 11 (dont l'installeur et l'installation).
