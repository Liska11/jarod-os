# Audit indépendant de Jarod-OS — 2026-10-19

Périmètre : dépôt `C:\Users\San\herald-os`, branche `feature/windows-port`, HEAD `4c9883c` (« fix(desktop): shell no longer shifts when an element scrolls into view; final audit »), arbre de travail propre, 18 commits d'avance sur `origin/feature/windows-port`. Dossier `prompt/` non suivi, préexistant, non touché.

Mission : audit complet et reproductible (architecture, code, sécurité, données, fonctions, interface, performances, tests, distribution), **sans modifier le code applicatif** ; produire les cinq livrables, puis s'arrêter avant corrections.

Statuts utilisés : **confirmé** (preuve reproduite pendant cet audit), **hypothèse** (plausible, non reproduite), **corrigé** (constat d'un audit antérieur, correctif présent au commit courant), **différé**, **limite admise** (documentée et énoncée honnêtement).

## 1. État initial et reproductibilité

| Élément | Valeur relevée |
|---|---|
| Date de l'audit | 2026-10-19 |
| Branche / commit | `feature/windows-port` @ `4c9883c` |
| Arbre de travail | propre (aucune modification, aucun fichier indexé) |
| Avance sur l'origine | 18 commits, aucun poussé pendant l'audit |
| OS | Windows 11, amd64 |
| Node / npm | v24.20.0 / 11.19.0 (`.nvmrc`/`engines` : `>=22.12.0`) |
| Electron | 44.5.1 (`electron` 44.5.1, binaire v44.5.1 à l'exécution) |
| Pile du shell | React 19.3.0, TypeScript 6.0.3, Vite 8.3.0, Vitest 5.0.1, Playwright 1.60.0, biomes 2.5.15 |
| Monorepo | npm workspaces `apps/*`, `packages/*` ; noyau séparé `jarod-core` (pnpm workspaces) |
| Fichiers de verrouillage | `package-lock.json` (racine), `jarod-core/pnpm-lock.yaml`, `jarod-core/engines.lock` |
| Scripts | `bootstrap`, `dev`, `build`, `typecheck`, `test`, `lint`, `test:core`, `test:bridge`, `dist:mac`, `dist:win` |

Conditions de lancement : `npm run bootstrap` puis `npm run dev` (shell + noyau Jarod par défaut ; `HERALD_OS_BACKEND=hermes` bascule sur Hermes). Les données de tests vivent dans `%TEMP%\jarod-e2e-*` (profil jetable), jamais dans le profil réel.

## 2. Résultats exacts des validations

Les commandes exactes et leurs sorties détaillées sont dans [JOURNAL-COMMANDES.md](JOURNAL-COMMANDES.md). Synthèse :

| Validation | Commande | Résultat | Remarque |
|---|---|---|---|
| Types | `npm run typecheck` | **code 0** | shell, Electron, preload, client |
| Lint | `npm run lint` (biome, 1565 fichiers) | **0 erreur, 606 avertissements, 4 infos** | identique à l'audit du 18-10 |
| Tests unitaires du shell | `npm test` | **1268 réussis, 3 ignorés, 0 échec** (161 fichiers) | 19 s |
| Tests du noyau | `npm run test:core` | **1 échec** : `plugins/integrations` → `test/engines/browser.lifecycle.engine.test.ts:121` ; 272 tests du paquet réussis ; `packages/cli` relancé à part : réussis | échec **dépendant de la machine** (témoin UDP WebRTC), pas une régression — voir X-07 |
| Build de production | `npm run build` | **code 0** | 2 avertissements `INEFFECTIVE_DYNAMIC_IMPORT` (X-05) |
| e2e (Electron réel) | `npx playwright test` | **45 réussis / 45** | 7 échecs de lancement au premier essai, dus à l'environnement — voir X-08 |

**Point d'exécution important (X-08).** Le premier lancement des e2e a échoué (7 échecs, 38 non lancés, plus un dossier jetable laissé dans `%TEMP%`). La cause n'est pas le dépôt : la variable d'environnement `ELECTRON_RUN_AS_NODE=1`, injectée par l'environnement d'exécution de la session, transforme `electron.exe` en interpréteur Node, qui refuse alors `--remote-debugging-port=0` (« bad option »). Preuve : le binaire officiel Electron 44.5.1 extrait du cache (`%LOCALAPPDATA%\electron\Cache\...\electron-v44.5.1-win32-x64.zip`) reproduit le refus avec la variable, et démarre normalement (DevTools `ws://127.0.0.1:9223`) sans elle. En relançant la suite dans un processus où la variable est retirée : `cockpit` 6/6 (12 s), puis suite complète **45/45 (2 min, code 0)**, `VOICE-LATENCY première phrase 263 ms, réponse entière 290 ms`. Aucun dossier `jarod-e2e-*` ni processus résiduel après la passe.

## 3. Cartographie de l'architecture

Document dédié : [CARTOGRAPHIE.md](CARTOGRAPHIE.md). Vue courte :

```
Utilisateur
 └─ Shell Electron (apps/desktop)
      ├─ renderer React + nanostores (src/) ── preload `heraldOS.*` ── main (electron/)
      ├─ main : ~183 enregistrements ipcMain.handle/on (hors tests, dont 17 dans main.ts),
      │         fs/path-guard, terminal (node-pty), vues web (WebContentsView + sessions),
      │         disque Jarod, sauvegardes, bacs à sable, environnements, VM WSL,
      │         canal de contrôle (pipe nommé + jetons), catalogue, thèmes
      └─ BackendManager ── ws://127.0.0.1 (jeton par lancement) ──▶ noyau jarod-core (gateway node)
             ├─ agent : executeGuardedTool = porte unique des outils
             ├─ plugins : tools, permissions (shell-guard, gate), llm, gateways, storage,
             │            memory, rag, embeddings, scheduler, mcp, integrations, voice,
             │            kanban, workflows, sandbox, quarantine, skills, updates
             └─ kernel : network.ts (interrupteur Internet, gardes sockets), redact, util
```

Frontières de confiance : renderer sandboxé (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`), pont `contextBridge` unique et typé, navigation verrouillée (`setWindowOpenHandler` refuse, `will-navigate` n'autorise que la page du shell), chemins contrôlés par `electron/ipc/path-guard.ts`, réseau contrôlé par `network-policy.json` des deux côtés de la frontière, secrets contenus dans le coffre du noyau (noms visibles de l'agent, valeurs jamais renvoyées).

## 4. Sécurité

### 4.1 Interrupteur Internet — mécanisme réel, vérifié des deux côtés

La revendication « interrupteur Internet » n'est pas un bouton cosmétique. Chaîne vérifiée dans le code courant :

- **Source de vérité unique** : `network-policy.json` dans le dossier de configuration du shell, écrit atomiquement, relu par les deux processus. `apps/desktop/shared/network-policy.ts` (83 l.) et `jarod-core/packages/kernel/src/network.ts` portent la même décision : `parsePolicy` (fichier absent → défaut Internet on ; fichier illisible ou invalide → **Internet coupé**, jamais un « on » silencieux), `decideHost` → `loopback | internet | remote | blocked`, boucle locale toujours autorisée.
- **Sessions web** (`apps/desktop/electron/ipc/network.ts:24-67`) : `app.on('session-created')` capte toute session présente ou future ; proxy `fixed_servers` vers `127.0.0.1:9` (`DEAD_PROXY`, rien n'écoute) avec `proxyBypassRules` limité aux machines distantes déclarées ; `closeAllConnections()` à la coupure ; WebRTC passé à `disable_non_proxied_udp` hors ligne, puis restauré (mémorisation par page). Un échec d'application est journalisé, pas ignoré silencieusement — mais ne lève pas.
- **Sockets Node du shell** : `apps/desktop/electron/net-guard.ts` remplace `net.Socket.prototype.connect` ; `main.ts:113` `installSocketGuard(host => network.allows(host))`, `main.ts:114` coupe les connexions ouvertes à chaque changement de politique. Couvre fetch/undici, http, https, tls, WebSocket ; les tubes et sockets Unix passent (non réseau).
- **Noyau** : même garde (`installNetworkGuard`), politique relue via `stat` (relecture seulement si mtime/taille change), `watchFile(..., { interval: 500, persistent: false })` + `cutDisallowed` qui détruit les sockets ouverts d'un flux en cours ; `toolVerdict` refuse avant approbation les outils Internet (`web_search`, `web_fetch`, `http_request`, `connected_browser`, `browser_*`, skills hub, pinokio) et `run_shell`/MCP sauf option explicite « commandes locales ».
- **Preuve d'application** : `main.ts:115` `electronNetworkSessions()`, `main.ts:805` `await network.attach(networkSessions)` (avant chargement des fenêtres), `apply()` itère sur **toutes** les sessions connues.

Conclusion : le mécanisme est réel et défend en profondeur ; ses **limites** sont documentées et exactes (DNS d'un nom avant refus du `connect`, `dgram` du noyau non gardé, processus enfants non isolés, backend Hermes hors garde noyau) — voir X-04, X-12.

### 4.2 IPC et frontières de privilèges — X-01

Inventaire actuel : **183 enregistrements** `ipcMain.handle`/`ipcMain.on` hors tests (17 dans `main.ts`, 20 dans `ipc/fs.ts`, 9 `external-backup`, 9 `capture`, 9 `web`, 6 `plugins/host`, etc.). Aucun contrôle centralisé de l'émetteur (`senderFrame`/`event.senderFrame.url`) à l'entrée des handlers. Des contrôles **locaux** existent là où ils comptent : propriété des arbres surveillés (`fsUnwatchTree` compare `event.sender`), propriété des vues web (`web.*` passent `event.sender`), propriété des PTY (`terminal.ts` : libération à la destruction du propriétaire), et la surface exposée par `preload/index.ts` est explicitement bornée (aucun `ipcRenderer` brut exporté).

Constat : défense en profondeur **incomplète**, sans exploit démontré. Le renderer n'exécute que le bundle local, la navigation est verrouillée et les vues web n'ont pas de preload ; le risque résiduel est celui d'une compromission du renderer (XSS via contenu rendu, plugin) qui atteindrait des canaux non contrôlés. Sévérité élevée en impact potentiel, confiance **confirmée** sur l'absence de contrôle, **hypothèse** sur l'exploitabilité.

### 4.3 Commandes et outils

- `run_shell` (`jarod-core/packages/plugins/tools/src/builtin.ts:289-355`) passe par `ShellGuardService.plan()` avant exécution : programme résolu sur le **binaire réel** (liens suivis), listes `deniedPrograms`/`allowedPrograms`/`askPrograms`, refus si le confinement demandé n'est pas tenable, accord par la porte existante. `isolation: "workspace"` n'est jamais promis : si `jarod-sandbox selftest` ne passe pas, la commande est **refusée avec la raison**. Sous Windows, ce mécanisme n'est pas livré par défaut → X-03.
- Les outils système Windows n'interpolent jamais le texte du modèle dans un script PowerShell : arguments en JSON dans l'environnement, scripts en `-EncodedCommand`, préfixe d'environnement toléré, 11 000 caractères max ; `INTERPRETERS` (cmd, powershell, bash, node, python, wsl…) ne peuvent pas devenir l'application d'ouverture de `system_open`.
- Le garde d'outils unique (`agent.ts:1159` `executeGuardedTool`) ordonne : outil inconnu/désactivé → `toolVerdict` (réseau) → mode Plan → porte de permissions (défaut `deny`) → validation JSON Schema → `precheck` de l'outil → approbation (une entrée « toujours autoriser » est ignorée pour les outils de `NEVER_ALWAYS`) → exécution → audit (`redactText` **avant** troncature à 500, sortie tronquée à 50 000).

### 4.4 Secrets

Chaîne : saisie dans Réglages › Secrets → `VaultService` (coffre du noyau) → référence `{{secret:NOM}}` injectée au dernier moment (https + domaine autorisé pour `http_request`, variable d'environnement seulement si le secret l'autorise pour `run_shell`) → sortie masquée y compris URL-encodée/base64 → suppression/renvoi. L'agent ne voit que noms, type, domaines. Sauvegarde externe : les valeurs sont retirées par `snapshotWithoutSecrets` (`VACUUM INTO` puis effacement des valeurs et vacuum). Protection au repos : base SQLCipher, clé 32 octets protégée par DPAPI `CurrentUser` (entropie `Jarod-One db key`), repli fichier `db.key` en mode 0600 signalé « faible ». Valeurs du coffre écrites en `pl:` (base64) **dans** la base chiffrée → X-02.

### 4.5 Données et restauration

`docs/BACKUP-EXTERNE.md` décrit une chaîne crédible et cohérente avec le code lu : dossier `<date>.incomplete` renommé après hachage/relu, manifeste écrit **en dernier** (`status: "complete"`), validation intégrale à la restauration (chemins relatifs, absence de `..`, taille+hachage), bascule avec conservation du précédent (`<cible>.before-restore-<tag>`), retour arrière si un renommage échoue, verrou `operation-lock.ts` partagé sauvegarde/restauration, destructions limitées au dossier de l'opération. Non testé pendant cet audit : cycle complet sur données factices dans l'interface réelle, disque USB débranché, disque plein, restauration sur un autre compte Windows (échoue par construction : clé DPAPI).

## 5. Constats

| Id | Catégorie | Sévérité | Confiance | Preuve | Impact | Correction | Effort | Test de non-régression | Statut |
|---|---|---|---|---|---|---|---|---|---|
| X-01 | IPC | élevée (impact) / moyenne (probabilité) | confirmée (absence de contrôle) ; hypothèse (exploit) | 183 `ipcMain.handle/on` hors tests, pas de contrôle `senderFrame` central ; contrôles locaux seulement (`ipc/fs.ts:334-338`, `ipc/web.ts:300-311`, `ipc/terminal.ts:106-122`) | Un renderer compromis atteindrait des canaux non contrôlés (fs, terminal, capture, sauvegardes) | Un wrapper commun `handle(channel, fn)` qui vérifie l'émetteur, avec liste blanche des surfaces autorisées | 2–4 j | Test unitaire : appel d'un canal privilégié depuis une frame non autorisée → refus | **constat inexact, clos le 2026-10-21** : un garde central existait (commit `1555fc2`, 2026-10-18) ; couverture prouvée dans l'application réelle (178 canaux, aucun hors garde) — voir BACKLOG BL-01 |
| X-02 | Secrets | moyenne | confirmée | `storage/src/os-crypt.ts:102` écrit `pl:` (base64) ; `dbkey.ts` clé DPAPI `CurrentUser` + repli `db.key` (mode 0600) | Valeur en clair **dans** la base : protection = chiffrement de la base + compte Windows. Copie de `jarod.db` + clé = lecture | Chiffrer la valeur elle-même (os_crypt/DPAPI) plutôt que la seule base ; ne jamais écrire de `pl:` pour le coffre | 1–2 j | Test : un dump de la base ne contient aucun octet de la valeur | à traiter (BL-03) |
| X-03 | Commandes | moyenne | confirmée | `shell-guard.ts` : sans mécanisme vérifié, `writeScope:"workspace"` est refusé ; sous Windows `jarod-sandbox` n'est pas livré/testé par défaut | `run_shell` s'exécute sans confinement des écritures par défaut (limite admise) ; l'agent peut écrire hors du workspace | Livrer/provisionner `jarod-sandbox` et le documenter comme prérequis d'isolation ; garder le refus explicite | 3–5 j | Test d'acceptation : commande écrivant hors workspace → refus | différé (BL-04) |
| X-04 | Réseau | faible | confirmée | `kernel/src/network.ts:137-152` (garde `Socket.prototype.connect` uniquement) ; `dgram` non gardé, enfants non isolés (docs) | Fuites UDP éventuelles par un plugin ; processus enfants non confinés | Garder `dgram`/`node:dgram` et documenter ; isoler les enfants par pare-feu par programme reste hors périmètre | 1–2 j | Test : `dgram` vers l'extérieur hors ligne → refus | à traiter (BL-07) |
| X-05 | Build | faible | confirmée | `npm run build` : 2 × `INEFFECTIVE_DYNAMIC_IMPORT` (`ApplicationsOverlay` importé statiquement par `CommandSurface.tsx` ; `CommandSurface` statique par `AskOverlay.tsx`) | Chunks non séparés : démarrage un peu plus lourd, aucun défaut fonctionnel | Rendre les imports cohérents (statique **ou** dynamique, pas les deux) | 0,5 j | Build sans avertissement ; mesure de la taille des chunks | à traiter (BL-05) |
| X-06 | Qualité | faible | confirmée | `biome lint` : 606 avertissements (dont `noControlCharactersInRegex`, `noNonNullAssertion`) | Bruit qui masque les vrais défauts | Trier par règle, corriger les catégories qui masquent un défaut (regex, non-null), ne pas « nettoyer » en masse | 2–3 j | Lint sans avertissements masquants ; seuil ratchet en CI | à traiter (BL-06) |
| X-07 | Tests noyau | faible | confirmée, dépendante de la machine | `plugins/integrations/test/engines/browser.lifecycle.engine.test.ts:121` : « contrôle WebRTC : aucun datagramme STUN/TURN-UDP n'atteint le témoin sur cette machine, preuve non concluante » | `test:core` échoue sur les machines où le témoin UDP ne reçoit rien ; ce n'est pas une fuite ni une régression | Séparer le témoin réseau de la suite, ou la marquer explicitement « non concluante » (skip conditionnel + rapport) | 0,5–1 j | `test:core` vert partout, témoin rapporté comme mesure | à traiter (BL-02) |
| X-08 | Environnement de test | info | confirmée | 7 échecs e2e « Process failed to launch! » + « bad option: --remote-debugging-port=0 » ; cause `ELECTRON_RUN_AS_NODE=1` injectée par l'environnement ; binôme officiel Electron 44.5.1 reproduit le refus | Faux négatifs en CI locale ; un dossier jetable laissé dans `%TEMP%` par la passe interrompue | Un garde dans `e2e/launch.ts` (retirer la variable ou refuser tôt avec un message clair) + note QA | 0,5 j | e2e verts dans un environnement qui hérite `ELECTRON_RUN_AS_NODE=1` | à traiter (BL-09) |
| X-09 | SSH/Tailscale | faible | hypothèse | `docs/REMOTE-SSH.md` + tests unitaires réels (ssh-keygen sur `known_hosts` temporaire) ; aucun second PC disponible | Première connexion réelle non prouvée | Essai manuel documenté (même réseau / Tailscale) | — | — | vérification manuelle (M1) |
| X-10 | Sauvegarde | faible | hypothèse | `docs/BACKUP-EXTERNE.md` : USB réel, disque plein, débranchement non testés ; cross-compte DPAPI impossible (documenté) | Perte de confiance sur le cas matériel | Essai sur disque amovible dédié puis débranchement | — | — | vérification manuelle (M2) |
| X-11 | Voix | faible | confirmée (partiel) | e2e : synthèse 263/290 ms ; duplex, VAD, barge-in, invalidation de tour couverts par tests unitaires ; micro réel/écho non testés | Comportement en conditions réelles inconnu | Essai micro réel + haut-parleurs, relever les mesures affichées | — | — | vérification manuelle (M3) |
| X-12 | Réseau / backend | faible | confirmée | `docs/NETWORK-POLICY.md` : avec `HERALD_OS_BACKEND=hermes`, seul le shell applique la politique | Un utilisateur en backend Hermes n'a pas la garde sockets du noyau | Documenter dans l'UI que l'interrupteur est partiel en backend Hermes | 1 j | Test e2e backend Hermes : requête hors ligne refusée | différé (BL-08) |

Aucun constat **P0** (perte de données imminente, compromission active) n'a été établi. X-01 et X-02 sont les deux sujets à traiter en priorité avant d'ajouter de nouvelles surfaces.

## 6. Fonctions vérifiées / non vérifiées

Voir la matrice complète : [MATRICE-FONCTIONNALITES.md](MATRICE-FONCTIONNALITES.md). Résumé :

- **Vérifiées fonctionnelles** (preuve au commit) : interrupteur Internet (code des deux côtés + e2e cockpit), pont preload borné, path-guard des écritures, garde d'outils unique, sauvegarde externe (unitaire + e2e), disque Jarod (e2e), cockpit/modèle/barre latérale (e2e), synthèse vocale du noyau (e2e).
- **Partielles** : voix duplex en conditions réelles ; SSH/Tailscale (unitaire seulement) ; mises à jour (lecture seule, jamais installé) ; restauration externe complète (cycle réel non rejoué ici) ; confinement `workspace` de `run_shell` (refus explicite sous Windows).
- **Implémentées non vérifiées** : installation/mise à jour de pilotes, déplacement de VM WSL, restauration multi-compte.
- **Limites admises** (documentées) : enfants non isolés, `dgram` non gardé, backend Hermes partiellement couvert.

## 7. Comparaison avec le compte rendu du 18-10

| Point | 18-10 (`docs/AUDIT-GLOBAL.md`) | 19-10 |
|---|---|---|
| Types / build | code 0 | inchangé (2 avertissements Vite constatés) |
| Lint | 597 → 606 avertissements | 606, inchangé |
| Tests shell | 1221 → 1268 réussis | 1268 / 3 ignorés |
| Tests noyau | 1 échec (A-07) | 1 échec identique (X-07), même test |
| e2e | 33 au commit `309a0d8`, puis 45 annoncés après correctifs | **45/45 reproduits** ; échecs initiaux expliqués (X-08), pas une régression |
| IPC sans contrôle d'émetteur | 159 canaux annoncés | **183 enregistrements constatés** — la documentation a vieilli |
| Interrupteur Internet | « corrigé (lot 1) » | mécanisme confirmé ligne à ligne, des deux côtés |
| A-08 (coffre `pl:` + DPAPI) | « en partie corrigé » | confirmé : seul le retrait en sauvegarde a été fait ; X-02 reste ouvert |

Aucune régression constatée entre les deux passes. Les écarts sont des **écarts de documentation** (décompte IPC, périmètre des 45 e2e) et des **constats non soldés** (A-08/X-02, A-06/X-01, A-11/X-06), pas des régressions.

## 8. Limites de cet audit

- Pas de second PC ni de pair Tailscale : SSH/TS réels non rejoués (X-09, M1).
- Pas de disque amovible dédié : débranchement et disque plein non testés (X-10, M2).
- Pas de micro ni de modèle cloud branché : duplex réel non mesuré (X-11, M3).
- Aucun test destructif, aucun test sur le profil réel : les e2e utilisent `%TEMP%\jarod-e2e-*`.
- Revue **ciblée** du noyau (agent, permissions/shell-guard, kernel/network, tools, storage, bridge), pas ligne à ligne de 25 paquets.
- Aucune capture d'écran produite dans cet audit : l'interface est couverte par les e2e (cockpit) et les correctifs déjà en place ; les défauts visuels du 18-10 (A-02..A-05, A-13..A-16) sont marqués corrigés et n'ont pas été revus visuellement ici.

## 9. Vérifications manuelles restantes

- **M1** — SSH réel vers l'autre PC (clé, empreinte, première confiance, changement de clé) ; Tailscale connecté avec un pair.
- **M2** — Sauvegarde externe sur un disque amovible dédié, puis débranchement en cours de copie ; disque presque plein ; restauration d'une installation neuve sur le même compte Windows.
- **M3** — Voix duplex au micro réel : interruption, écho, latence bout en bout affichée par « Mesures de cette session ».
- **M4** — Clic de contrôle sur l'interface (grande/petite fenêtre, focus clavier) après les correctifs A-02..A-16, si l'on veut une preuve visuelle à jour.

## 10. Conclusion et arrêt

État réel : **alpha solide**, périmètre sécurité mieux tenu que la documentation ne le suggère (interrupteur réseau réel des deux côtés, chemin d'outils unique, chemins gardés), mais **deux sujets restent ouverts** avant d'ajouter des surfaces : le contrôle d'émetteur IPC (X-01) et la protection des valeurs du coffre (X-02). Le reste est de la dette de qualité (lint, build, témoin de test machine-dépendant) et trois vérifications matérielles (SSH, USB, micro).

Aucune correction n'a été appliquée. Le plan de correction, ses dépendances et ses critères d'acceptation sont dans [BACKLOG.md](BACKLOG.md). **Arrêt ici, en attente d'accord** avant toute modification du code applicatif.
