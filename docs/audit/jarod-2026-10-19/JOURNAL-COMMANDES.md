# Journal des commandes et validations — 2026-10-19

Environnement : Windows 11 amd64, `C:\Users\San\herald-os`, branche `feature/windows-port` @ `4c9883c`, arbre propre. Node v24.20.0, npm 11.19.0, Electron 44.5.1, Playwright 1.60.0, Vitest 5.0.1, biome 2.5.15, pnpm 10.x (via corepack).

Règle appliquée : aucune dépendance installée, aucun modèle téléchargé, aucun test désactivé, aucune donnée réelle touchée, aucun push. Les e2e utilisent un profil jetable `%TEMP%\jarod-e2e-*`.

## 1. Validations principales

| # | Commande exacte | Sortie / résultat | Durée | Remarques |
|---|---|---|---|---|
| V1 | `npm run typecheck` | code 0, 0 erreur | — | shell, Electron, preload, client |
| V2 | `npm run lint` (`biome lint apps/desktop`, 1565 fichiers) | **0 erreur, 606 avertissements, 4 infos** | — | identique au 18-10 ; avertissements triés en X-06 |
| V3 | `npm test` (Vitest, workspace) | **161 fichiers : 1268 réussis, 3 ignorés, 0 échec** | ~19 s | 3 ignorés = dépendants d'environnement (documentés) |
| V4 | `npm run test:core` (pnpm -r) | **1 paquet en échec** : `@jarod/plugins-integrations` → `test/engines/browser.lifecycle.engine.test.ts:121` | — | échec machine-dépendant, voir V4bis |
| V4bis | `pnpm --filter @jarod/plugins-integrations test` | 272 tests réussis, 1 fichier en échec (le même) | — | message exact : « contrôle WebRTC : aucun datagramme STUN/TURN-UDP n'atteint le témoin sur cette machine, preuve non concluante (docs/E2-VALIDATION.md §6.1) » |
| V4ter | `pnpm --filter @jarod/cli test` | 3 fichiers réussis, dont `gateway-bundle.test.ts` | — | pnpm s'arrête au premier paquet en échec ; relance ciblée nécessaire |
| V5 | `npm run build` | code 0 | — | 2 avertissements `INEFFECTIVE_DYNAMIC_IMPORT` : `ApplicationsOverlay.tsx` (dynamique dans `Desktop.tsx`/`MainSurface.tsx`, statique dans `CommandSurface.tsx`), `CommandSurface.tsx` (dynamique dans `ShellRoot.tsx`, statique dans `AskOverlay.tsx`) |
| V6 | `npx playwright test` (1er essai) | **7 échecs, 38 non lancés**, 1 erreur de `global-setup` (« e2e run left 1 throwaway root(s) in %TEMP% ») | — | faux négatifs d'environnement, voir §2 |
| V7 | `npx playwright test cockpit.spec.ts` (variable retirée) | **6 réussis / 6** | 12,0 s | contrôle intermédiaire |
| V8 | `npx playwright test` (variable retirée) | **45 réussis / 45**, code 0 | ~2,0 min | `VOICE-LATENCY première phrase 263 ms, réponse entière 290 ms` ; aucun dossier ni processus résiduel |

### Interprétation

- V4/V4bis : l'échec n'est pas une régression du commit ; il dépend de la capacité de la machine à recevoir un datagramme UDP sur le témoin. Il est marqué **non concluant** par le test lui-même. X-07.
- V6 : voir §2 ; la suite n'est pas cassée, l'environnement d'exécution impose `ELECTRON_RUN_AS_NODE=1`.

## 2. Incident de lancement e2e (X-08) — chronologie des preuves

1. `npx playwright test` → 7 × `Process failed to launch!` ; journaux Electron : `bad option: --remote-debugging-port=0`, puis `--no-sandbox`, `--disable-gpu`, `--js-flags` également refusés.
2. Vérification que la variable est présente : `ELECTRON_RUN_AS_NODE=1` dans l'environnement du processus (héritée de la session), **absente** du registre Windows et des scripts npm.
3. Contrôle que ce n'est pas une restriction d'Electron 44.5.1 : extraction de `electron-v44.5.1-win32-x64.zip` depuis `%LOCALAPPDATA%\electron\Cache\...` ; lancement avec `--remote-debugging-port=9223` **sans** la variable → `DevTools listening on ws://127.0.0.1:9223` ; **avec** la variable → `bad option`.
4. Playwright 1.60.0 local (et 1.62/1.64 vérifiées) utilisent la même stratégie (`--inspect=0 --remote-debugging-port=0`, `loader.js`) : rien à corriger côté dépôt.
5. Reprise : processus enfant avec la variable retirée → V7 puis V8 verts.
6. Après la passe interrompue, un dossier `jarod-e2e-*` restait dans `%TEMP%` (nettoyage du `global-setup` non exécuté) ; supprimé manuellement, puis plus aucun résidu.

## 3. Inspections en lecture seule (échantillon)

| Sujet | Commande / méthode | Constat |
|---|---|---|
| État du dépôt | `git log --oneline -2`, `git status --short` | `4c9883c` en tête, arbre propre |
| Inventaire IPC | `Select-String ipcMain\.(handle|on)` sur `apps/desktop/electron` | 183 hors tests, 17 dans `main.ts` |
| Politique réseau shell | lecture `electron/network.ts`, `electron/ipc/network.ts`, `electron/net-guard.ts`, `shared/network-policy.ts` | mécanisme réel, voir rapport §4.1 |
| Politique réseau noyau | lecture intégrale `kernel/src/network.ts` | `installNetworkGuard`, `policyReader`, `toolVerdict`, `cutDisallowed` |
| Porte d'outils | lecture `plugins/agent/src/agent.ts` (`executeGuardedTool`) | ordre et refus vérifiés |
| Shell-guard | lecture `plugins/permissions/src/shell-guard.ts` | `mechanism()`, `writableRoots()`, `readRoots()`, `plan()` |
| `run_shell` | lecture `plugins/tools/src/builtin.ts:289-355` | `isolation` non promise sans mécanisme |
| Outils Windows | lecture `plugins/tools/src/system/ps.ts`, `tools.ts` | `-EncodedCommand`, 11 000 caractères, interpréteurs interdits |
| Coffre | lecture `storage/src/db.ts`, `dbkey.ts`, `os-crypt.ts` | DPAPI CurrentUser, `pl:` en base (X-02) |
| Documentation | lecture intégrale `docs/NETWORK-POLICY.md`, `SECRETS.md`, `BACKUP-EXTERNE.md`, `REMOTE-SSH.md`, `UPDATES.md`, `VOICE.md`, `JAROD-DISK.md` | limites annoncées cohérentes avec le code |
| Audit précédent | lecture `docs/AUDIT-GLOBAL.md` | A-01..A-16, statuts |

Aucune de ces commandes n'a modifié le dépôt ; les seules écritures sont les cinq fichiers de ce dossier.

## 4. Tests ignorés (3) et non exécutés

- 3 tests ignorés dans `npm test` : dépendants de la plateforme/du matériel (énumérés dans le rapport de Vitest ; aucun n'est un test de sécurité).
- Non exécutés volontairement : installation de modèle, téléchargement de dépendance, mise à jour de pilote, redémarrage, test sur machine distante, test destructif de restauration, test sur profil réel.

## 5. Reproductibilité

| Question | Réponse |
|---|---|
| Le résultat V3 est-il stable ? | oui, 1268/3/0 reproduit |
| V2 ? | oui, 606 avertissements exactement |
| V4 ? | dépend de la machine (témoin UDP) ; le même test échoue au 18-10 |
| V8 ? | oui, dès que `ELECTRON_RUN_AS_NODE` n'est pas injectée ; 45/45 |

*Fin du journal.*
