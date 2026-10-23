# Suivi de remédiation — 2026-10-22

Ce document **s'ajoute** aux audits historiques (`AUDIT-COMPLET-JAROD-OS-2026-10.md`, `jarod-2026-10-19/`, `audit-jarod-15-10.txt`) sans les remplacer ni les corriger : un audit décrit l'état d'un commit à une date ; que le dépôt ait changé depuis ne rend pas un ancien constat faux. Le dossier `jarod-2026-10-19/` reste tel quel ; ses clôtures (BL-01) sont déjà datées dans son propre BACKLOG.

Niveaux de preuve employés, jamais mélangés :

- **O** — observation dans le code (lecture) ;
- **H** — hypothèse (plausible, non reproduite) ;
- **R** — reproduction contrôlée (test, sonde, commande rejouée) ;
- **V** — validation après correction (test ajouté ou existant, rejoué après le changement).

## 1. État initial

| Élément | Valeur relevée |
|---|---|
| Chemin de travail | `D:\Jarod-OS` |
| Branche / HEAD | `feature/windows-port` @ `d42ae24` (16 commits d'avance sur `origin/feature/windows-port` = `7579213`) |
| Arbre de travail au départ | 169 entrées `git status --short` (85 fichiers suivis modifiés + 84 non suivis, dont des dossiers) ; 175 fichiers avec `-uall`. Aucune n'a été défaite, supprimée ni mise de côté. |
| « 169 contre 174 » | Voir §2 : 169 = entrées, 175 = fichiers (`-uall`) au départ de cette passe. |
| Autres clones / worktrees | Voir §9. |
| Autre agent sur les mêmes fichiers | Aucun processus de session concurrent sur `D:\Jarod-OS` observé ; les 11 worktrees `.claude/worktrees/*` n'ont **aucun commit propre** (leurs têtes sont des ancêtres de HEAD) et 2–4 fichiers non suivis chacun. |

## 2. Réconciliation des résultats d'exécution

**Ce qui est établi (R).** Au départ de cette passe : 169 entrées `git status --short` et 175 fichiers `-uall` ; les rapports annonçaient « 169 entrées » d'un côté, « 174 fichiers » de l'autre. Les deux unités diffèrent (une entrée peut être un dossier non suivi entier) : 169 est bien un compte d'entrées, et l'écart de 174 à 175 est celui d'un arbre qui a bougé entre deux comptages. **H** : rien ne prouve qu'un fichier ait été oublié ; la liste nominative des 175 fichiers n'ayant pas été conservée par le rapport d'origine, elle ne peut pas être rapprochée ligne à ligne.

**« 10 / 8 / 7 échecs ».** Les rapports d'origine ne sont pas dans le dépôt ; ces trois nombres ne peuvent donc pas être rapprochés commande par commande ici. Ce qui est établi (O + R) :

- `pnpm -r test` s'exécute **quatre paquets à la fois** par défaut, et dans `plugins/integrations` les fichiers de test tournaient en parallèle alors que les suites moteur pilotent un vrai Chrome, le bureau (UIA), des ports et des profils jetables : des suites pouvaient se disputer ces ressources (R : voir §3, les processus laissés par une passe interrompue). **H** : une partie des échecs comptés a pu venir de ces collisions, ou de la fermeture globale de Chrome évoquée dans la mission ; elle n'est pas démontrable après coup.
- Le dépôt ne contient aucune commande qui ferme Chrome *par nom* (recherche `taskkill /IM`, `Stop-Process -Name`, `killall`, `pkill` dans `apps`, `jarod-core`, `scripts`, `packages` : aucun résultat). Les tests arrêtent des processus **par numéro** et, pour le navigateur jetable, **par profil** (`killProfileProcesses`). Le « Chrome fermé globalement » venait donc de la méthode de l'auditeur, pas d'un test du dépôt. **H**, non démontrable ici.

Correction de méthode (V) : `test:core` passe à `--workspace-concurrency=1`, `plugins/integrations` à `fileParallelism: false` (un fichier de test à la fois dans le paquet qui pilote Chrome et le bureau). **Les chiffres du §3 ne viennent que de passes faites avec cette méthode**, chacun avec sa commande ; rien n'y est compté deux fois.

## 3. Résultats par suite (méthode corrigée)

Une ligne = une commande, un répertoire, une passe ; la machine est un poste de travail UTILISÉ pendant les passes (voir « limites »). Aucune ligne n'est comptée deux fois.

| # | Commande (répertoire) | Résultat | Ignorés / non lancés |
|---|---|---|---|
| T1 | `pnpm -r --workspace-concurrency=1 --no-bail typecheck` (`jarod-core`) | **code 0**, 29 paquets | — |
| T2 | `npm run typecheck` (`apps/desktop`) | **code 0** | — |
| T3 | `npm test` (`apps/desktop`) | **174 fichiers, 1382 réussis, 0 échec** | 3 ignorés (déjà ignorés dans le code, inchangés) |
| T4 | `pnpm -r --workspace-concurrency=1 --no-bail --filter "!@jarod/plugin-integrations" test` (`jarod-core`) | **29 exécutions, 346 fichiers verts, 3111 tests verts, 0 échec** (l'`agent` compte deux exécutions : sans moteur, puis moteurs) | 3 fichiers et 18 tests ignorés par leurs propres conditions : `rag` 13, `embeddings` 3, `tools` 1, `agent` 1 (moteur ou modèle absent) |
| T5 | `pnpm --filter @jarod/plugin-integrations test` (`jarod-core`) : 48 fichiers, moteurs réels, un fichier à la fois | **48 fichiers, 409 tests, 0 échec, 0 ignoré** (moteurs réels : Chrome jetable, WebRTC/UDP, FlaUI, osquery, syft, …) ; ~8 min | — |
| T6 | détail de T4 pour `@jarod/plugin-agent` : tests sans moteur puis moteurs, en série | **63 fichiers verts, 417 tests**, dont `desktop-autonomy.engine` (FlaUI réel) — *déjà compris dans T4, non additif* | 1 fichier ignoré (condition d'environnement) |
| T7 | `npx playwright test` (`apps/desktop`), après `npm run build` et `node scripts/bundle-gateway.mjs --out dist/gateway` | **82 réussis, 0 échec, 0 non lancé** (5,7 min) ; plus aucun dossier ni processus laissé par la passe | 7 ignorés : `package-restic-cycle` ×6 (exige le paquet installé), `voice-turn-latency` ×1 (exige un vrai modèle) |
| T8 | `npm run lint` (racine) | **0 erreur, 487 avertissements, 1 info** (le décompte d'avant, 606, portait sur un autre ensemble de fichiers : pas comparable) | — |
| T9 | `py -3.14 -m pytest tests/test_credential_stores.py tests/test_permissions.py tests/test_windows_host.py` (dossier du pont Python) | **62 réussis** | — |

**Non lancés, avec la raison.** `mobile/` : `npm ci` n'a pas été lancé (autorisation, voir §10) ; manifeste et lockfile concordent (16/16 dépendances) et un job CI a été ajouté. `package-restic-cycle` (e2e) : exige le paquet installé. `voice-turn-latency` (e2e) : exige un vrai modèle. Aucune sonde destructive.

**Passes intermédiaires (non additives, pour mémoire).** Une passe unique de tout le noyau (`pnpm -r --workspace-concurrency=1 --no-bail test`) a donné 30 exécutions, 394 fichiers, 3520 tests, 0 échec (avec deux `retry: 2` bornés, retirés depuis). Dans la passe T4 « sans retry », un test de `gateways` (`mobile-direct › lets the phone forget this computer by itself`) a une fois dépassé 30 s (machine occupée) ; il réussit 3 fois sur 3 isolé (17 s) et dans la passe suivante : **échec intermittent non attribué**, sans lien établi avec cette mission (aucun code de `gateways` ni de réseau local modifié).

**Première passe complète de référence (avant les derniers correctifs), pour mémoire.** Noyau, un paquet à la fois : tous verts sauf `tools` (1 échec, causé par R-09/R-14, corrigé). e2e : 73 réussis, 2 échecs (`connected-browser` = R-14, `shell › deny rule` = R-13), 7 ignorés, 7 non lancés (suite en série derrière un échec). Ces deux échecs sont corrigés et rejoués (§4).

## 4. Constats, corrections et preuves

Les ids **R-xx** sont propres à cette passe ; les anciens ids d'audit (X-xx, BL-xx) sont rappelés.

| Id | Fichier / fonction | État initial | Preuve avant | Correction | Tests | État final · limite |
|---|---|---|---|---|---|---|
| R-01 (X-07, navigateur) | `integrations/src/impl/browser-engine.ts` · `launchDisposableBrowser` | La boucle d'attente faisait `break` dès que le lanceur sortait, avant `DevToolsActivePort` ; elle ne comparait jamais le port à l'instance attendue | **O** : le même fichier documente que Chrome « peut continuer sous un autre numéro » (mesuré le 2026-10-18). L'ancien code n'a pas été rejoué (non conservé) | Attente bornée qui distingue lanceur sorti / navigateur prêt / échec / annulation / délai ; fichier de port COMPLET (port + chemin `/devtools/browser/<guid>`), puis `/json/version` doit annoncer le MÊME chemin ; nettoyage du navigateur et du profil dans chaque échec ; l'écouteur `exit` posé avant `kill()` (4 s perdues sinon) | `test/browser-launch.test.ts` : 12 cas déterministes (les 7 demandés + annulation avant lancement, erreur de lancement, reprise du point d'entrée, parseur) ; moteur RÉEL : `browser.engine`, `browser.lifecycle` (dont **preuve WebRTC/UDP conclusive : contrôle > 0, durci = 0**), `connected-browser-host/lifecycle` ; e2e `connected-browser` 9/9 | **V**. Limite : un témoin UDP à zéro est maintenant déclaré « non concluant » (ignoré avec la mesure) pour WebRTC, WebTransport et le proxy seul — jamais réussi, jamais pris pour une fuite |
| R-02 (types) | `bridge/test/local-models.test.ts` | `tsc` : 2 × TS2339 (`owner`) | **R** : `tsc` dans `jarod-core/packages/bridge` | La fixture `View` était une copie à la main ; elle est devenue le contrat réel `LocalModelsView` (`owner: "jarod" \| "incertaine" \| "externe" \| null`) | typecheck vert ; 9 tests du fichier | **V** |
| R-03 (sélecteur) | `apps/desktop/e2e/shell.spec.ts` | `getByRole('button', {name:'Resonder Diagrammes'})` correspond à deux boutons | **O** : deux capacités, « Diagrammes » et « Diagrammes placés (reladraw) » ; Playwright compare par sous-chaîne | `exact: true` + vérification de la seconde capacité ; libellés inchangés. « Resonder » n'est pas un mot français (à corriger en « Sonder … ») : NON modifié ici | e2e `capabilities` vert | **V** |
| R-04 (X-08) | `apps/desktop/e2e/launch.ts` | `ELECTRON_RUN_AS_NODE=1` hérité transforme Electron en Node (« bad option ») | **O** + audit du 19-10 (reproduit avec le binaire officiel) | Retirée de l'environnement du SHELL de test seulement ; le shell la pose lui-même pour le noyau | e2e complets | **V** |
| R-05 (secrets, enfants) | nouveau `kernel/src/child-env.ts` ; `mcp.ts`, `builtin.ts` (`runShell`), `ps.ts`, `act.ts`, `sbom.ts`, `probe.ts`, `video.ts`, `hyperv.ts`, `isolated.ts`, `wakeword-isolated.ts`, `artifacts.ts`, `browser-engine.ts` | Tous les enfants héritaient de `process.env` en bloc | **O** : 12 sites `{ ...process.env }`. Le jeton de passerelle était déjà retiré de `process.env` avant tout enfant (`gateway-token-env.test.ts`, travail précédent) | Environnement construit par famille : MCP tiers = système + ce que SA configuration nomme ; agent et moteurs = environnement de la personne sans jetons internes ni clés de fournisseurs. `ELECTRON_RUN_AS_NODE` et les variables Windows conservés | `kernel/test/child-env.test.ts` (9), `mcp/test/mcp-env.test.ts` (2, vrai serveur MCP), `tools/test/shell-env.test.ts` (2, vrai `node`), faux secrets sentinelles | **V**. Limites : la chaîne « MCP → jeton → pont → lecture sensible » n'est pas rejouée avec un vrai jeton (interdit) ; un serveur MCP qui veut un jeton le reçoit par SA configuration (choix de la personne). Le backend Hermes (Python) reçoit toujours `JAROD_OS_CONTROL_TOKEN` : c'est son canal, hors du noyau Jarod |
| R-06 (fichiers sensibles) | `path-guard.ts`, `file-gate.ts`, `shell-guard.ts`, `tools/system/disk.ts`, `permissions.py` | Cinq listes différentes : la fenêtre ne protégeait ni `.aws`, `.kube`, `.docker`, `.azure`, `.config/gh`, `.git-credentials`, `.npmrc` ; le garde fichiers ni `gnupg`, `Vault`, `Crypto` ; le shell confiné ni `.config/gh`… | **O** (comparaison des listes) | Une référence : `contracts/v1/credential-stores.reference.json`, vérifiée par un test dans CHAQUE garde (fenêtre, garde fichiers, shell confiné, outils système, pont Python). `git`, `aws`, `kubectl`, `ssh`, `docker` lancés par la personne gardent leurs identifiants : seul l'accès IMPLICITE est fermé | `credential-stores.test.ts` ×3 (arborescence factice), `test_credential_stores.py` (2) | **V**. Limites : pas encore d'exception « à la demande » pour les canaux de la fenêtre (le terminal reste libre) ; les profils de navigateurs restent propres au garde fichiers |
| R-07 (journaux) | `kernel/src/redact.ts`, `agent.ts` | Arguments d'outil journalisés par `redactText` (seuil de 12 caractères, formes connues) | **R** : un champ `password` de 4 caractères restait en clair | `redactValue`/`auditArgs` : masquage PAR STRUCTURE (nom de champ), options de ligne de commande, formes connues, troncature EN DERNIER | `redact-args.test.ts` (6), `agent/test/audit.test.ts` (4) | **V**. Limites : un secret inconnu dans un texte libre peut passer ; les anciens journaux ne sont pas réécrits (exposition historique possible : à surveiller, aucune valeur recopiée ici) |
| R-08 (réseau) | `kernel/src/network.ts`, `cli/src/main.ts` | Seule la passerelle appliquait la politique ; `jarod serve`, `ask`, MCP, ACP ouvraient le cœur sans elle | **O** : un seul appel à `applyNetworkPolicyFromEnv` (`gateway/main.ts`) | `resolvePolicyFile` + `applyNetworkPolicyForEntry`, appelés avant `main()` ; fichier trouvé mais illisible = Internet coupé ; aucun fichier = comme avant | `network-entry.test.ts` (8) | **V**. Limites inchangées : DNS, `dgram`, processus enfants non isolés, backend Hermes (`docs/NETWORK-POLICY.md`) |
| R-09 (autonomie) | `tools/src/registry.ts` | Un outil sans `dangerous` était traité comme une lecture | **O** : 58 des 100 outils du noyau amorcé ne le déclarent pas | Le registre valide ses entrées et tient pour `dangerous` tout outil NON déclaré absent de la liste revue (`REVIEWED_WITHOUT_APPROVAL`). Ni retrait d'outil, ni changement de politique globale | `agent/test/tool-risk-metadata.test.ts` (4) | **V**. Voir R-14 |
| R-10 (CI) | `.github/workflows/ci.yml` | `push` seulement sur `main` : une poussée sur `feature/windows-port` ne lançait rien (seules les PR) ; pas de lancement manuel ; mobile non couvert | **O** + `gh run list` : des PR ont tourné ; « Secret scan » y est **vert** (donc pas « CI absente ») ; « Kernel » rouge sur `1e04451` (voix sans moteur sous Linux ; chemin `D:\C:\…` sous Windows) | `push: [main, feature/windows-port]`, `workflow_dispatch`, `timeout-minutes: 45`, job `mobile` | non rejouable sans poussée | **Non validé par GitHub** (§10) |
| R-11 (tests, processus) | `package.json` (`test:core`), `integrations/vitest.config.ts`, `agent/vitest.config.ts` + script | Quatre paquets à la fois ; fichiers de test moteur en parallèle | **R** : une passe interrompue a laissé un arbre de processus (`vitest` + une soixantaine de `chrome`) | Un paquet à la fois ; un fichier à la fois pour les moteurs ; `agent` enchaîne tests sans moteur puis moteurs. Les tests ne tuent que par numéro ou par profil | T4–T7 | **V**. Voir « Ressources résiduelles » |
| R-12 (latence) | `tools/test/system-read.test.ts` | Un test fonctionnel portait une borne de 5 s | **R** : 8 passes × 2 : 1,1–1,3 s (mémoire), 1,5–1,8 s (CPU) | Test fonctionnel sans borne + test de latence sur la MÉDIANE de 3 passes | `system-read.test.ts` (27) | **V**. Cause de la latence : démarrage de PowerShell + fenêtre d'échantillonnage CPU ; le dépassement ne se voit que machine chargée |
| R-13 (e2e périmés) | `e2e/shell.spec.ts` (×2) | Visaient l'ancien formulaire (« Ajouter la règle ») | **R** : échec à `getByRole('button',{name:'Ajouter la règle'})` | Mis au flux en deux étapes de l'éditeur de règles (« Vérifier » puis « Appliquer »), puis révocation | `shell.spec` 15/15 | **V** |
| R-14 (régression ATTRAPÉE) | `registry.ts` | Après R-09, `connected_browser` (enregistré à l'exécution) devenait `dangerous` : DEUX cartes d'accord pour une action | **R** : e2e `connected-browser` rouge, la carte restait affichée | `connected_browser` ajouté à la liste revue (il demande son accord par `ctx.approve`, voulu non `dangerous`) | `connected-browser` 9/9 | **V**. Leçon : un inventaire par tests unitaires rate les outils enregistrés à l'exécution ; un balayage statique (AST) donne la même liste |
| R-15 (fixtures) | `agent/test/contracts.test.ts`, `proofs-tasks.test.ts` | Des « lectures » de fixture sans déclaration | **R** | Déclarées `dangerous: false` | verts | **V** |
| R-16 (test fuyard) | `integrations/test/browser-launch.test.ts` (le mien) | Les cas réussis laissaient 3 profils jetables dans `%TEMP%` | **R** : dossiers `jarod-e2-*` avec marqueur factice | `close()` dans les cas réussis | aucun profil laissé | **V** |

## 5. Environnements enfants (vérification)

Voir R-05 (et §11.5 : depuis la 2ᵉ passe, la configuration d'un serveur MCP ne peut plus réintroduire un jeton interne) : sentinelles `SENTINELLE-…` absentes d'un MCP non autorisé, présentes seulement quand SA configuration les nomme, absentes des sorties de test ; `ELECTRON_RUN_AS_NODE` et `PATH` conservés (un vrai `node` enfant les voit). Le pont du moteur navigateur garde son environnement déjà minimal (`bridgeEnv`).

## 6. FlaUI, AppContainer, tube — résultats séparés

- **FlaUI (moteur réel) — R-17.** *Avant* : chaque fichier réussissait SEUL (`flaui.engine` 5/5, `desktop-autonomy.engine` 5/5), mais `desktop-autonomy.engine` échouait à chaque passe longue et sérielle du noyau (5 passes sur 5, trois tentatives chacune) et `flaui.engine › Ctrl+Alt+Fin` une fois, avec le message du moteur « la fenêtre n'a pas pu passer au premier plan : rien n'a été envoyé » — c'est le comportement voulu (constater avant d'envoyer). Mesures : `ForegroundLockTimeout` = 200 000 ms ; pendant ces passes la fenêtre au premier plan était Firefox (la personne regardait une vidéo) ; mais le même test réussissait seul AVEC Firefox au premier plan, et avec 115 s d'inactivité : le verrou seul n'explique pas tout (**H** partielle). Aucun lien avec R-01 démontré. *Correction* (`sidecars/uia-flaui/Program.cs`, `Foreground`) : la voie UIA d'abord, puis jusqu'à deux essais par attachement au fil d'entrée du premier plan (`AttachThreadInput` + `SetForegroundWindow`), sans envoyer aucune touche à l'application de la personne ; sinon refus comme avant. Compilé hors ligne (`dotnet build -c Release`, NuGet en cache) puis installé dans `engines/flaui` (ancienne version sauvegardée dans le dossier de travail de la session). *Après* : la même passe sérielle complète est verte, y compris ce test (voir T4/T5). **À confirmer sur un bureau au repos** si l'on veut exclure toute autre cause ; les `retry: 2` bornés posés en attendant ont été RETIRÉS : T4 et T5 sont verts sans eux.
- **AppContainer** : sonde non destructive `host-rust/target/debug/jarod-sandbox.exe selftest` → `confining: true`, 5 contrôles verts (démarre confiné, écrit dans l'espace de travail, une écriture hors de lui échoue et ne crée rien, droit révoqué). Binaire de développement ; `isolation: "workspace"` reste **refusée avec la raison** quand le binaire n'est pas livré et vérifié (X-03 inchangé, BL-04).
- **Tube nommé (canal de contrôle)** : couvert par les tests unitaires du shell (`control-authz`, `sender-guard`) ; aucune sonde active sur le tube réel.

## 7. Autonomie : état des profils

- `DECLARED_FALLBACK = "allow"` : un outil DÉCLARÉ au registre sans règle est autorisé ; viennent ensuite la porte d'approbation (`dangerous`), le mode Plan, la politique réseau et le garde propre à l'outil. Ce n'est pas un défaut : c'est le comportement décrit. Ce qui change (R-09) : un outil qui ne déclare pas son risque n'obtient plus le privilège d'une lecture.
- `autoApproveTools` : `false` par défaut ; choix explicite de la personne ; ne s'applique pas aux outils de `NEVER_ALWAYS` ni à `connected_browser`.
- `writeScope: "off"` (défaut) : aucun confinement des écritures DEMANDÉ, les autres gardes jouent. `"workspace"` : demandé ; la commande est **refusée avec la raison** si la machine ne peut pas le tenir (`shell-guard.ts`). Lu dans le code, pas déduit du nom.
- `isolation: workspace` : jamais promise sans `selftest` réel (§6).
- Règles `permissionsRules` : `autonomous` bornée à outil / cible / opération / conversation / échéance / nombre d'usages ; modification et révocation effectives (e2e `permission-rules` et `shell.spec`) ; les affaiblissements exigent une confirmation native.
- Profil ouvert choisi par la personne : reste possible (règle `allow` large, visible dans `jarod permissions list`).

## 8. Documentation modifiée

`docs/NETWORK-POLICY.md`, `docs/SECRETS.md`, `docs/PERMISSIONS-AUTONOMIE.md`, ce suivi. Les audits historiques ne sont pas modifiés.

## 9. Dépôts, worktrees, documentation

Comparaison en **lecture seule** ; rien n'a été supprimé, fusionné ni renommé, aucun correctif appliqué ailleurs que dans `D:\Jarod-OS`.

| Dépôt | Branche / HEAD | Rapport à `D:\Jarod-OS` | Travail unique |
|---|---|---|---|
| `D:\Jarod-OS` | `feature/windows-port` @ `d42ae24` | référence | — |
| `D:\Jarod-OS\.claude\worktrees\*` (11) | `claude/*` | chaque tête est un **ancêtre** de HEAD (0 commit propre ; 18 à 57 commits de retard) | 2–4 fichiers non suivis chacun, aucun commit |
| autre clone sous le profil utilisateur (ancien nom du dépôt) | `feature/windows-port` @ `7579213` (= `origin/feature/windows-port`) | ancêtre de HEAD ; D: a 16 commits de plus | non suivis : `docs/audit/jarod-2026-10-19/` (BACKLOG et RAPPORT antérieurs aux clôtures faites dans D:), `integrations/src/cockpit/{probe,types}.ts` (versions antérieures aux lots 1–10 commités dans D:) — remplacés, pas uniques |
| `C:\Users\San\jarod-one` | `master` @ `8ea2d97` | historique **sans ancêtre commun** (autre projet : « Phase 1 — 9 core services ») | non examiné au-delà de l'en-tête ; aucune action |
| autres dossiers à l'ancien nom du dépôt, `go-jarod-cli`, `audit_jarod` | — | pas des dépôts git | — |

L'ancien nom du produit n'est pas renommé globalement : ses variables d'environnement restent LUES (`kernel/src/legacy-env.ts`), le dossier du plugin Python garde son nom, `docs/RENAME-PLAN-JAROD-OS.md` fixe les identifiants à conserver.

**`autonomy/journal.jsonl`.** Il est écrit par `scripts/autonomy/lot-lib.mjs` (la boucle de « lots » avec évaluateur du 2026-10-17), pas par le noyau en fonctionnement. Sa dernière entrée est du 2026-10-17 parce que cette boucle n'a pas été relancée depuis. Cela ne dit rien de l'autonomie de l'agent : celle-ci passe par les règles de permissions (`permissionsRules`, `docs/PERMISSIONS-AUTONOMIE.md`) et son journal est le journal d'audit du noyau.

## 10. Limites, ressources résiduelles, autorisations nécessaires, commits proposés

### Limites restantes (dites telles quelles)

- **Rien n'est commité ni poussé** ; la CI GitHub n'a donc validé AUCUN des changements de cette passe. Le seul résultat « GitHub » cité (§4, R-10) est celui de commits anciens.
- Poste de travail UTILISÉ pendant les passes (navigateur, éditeurs ouverts) : les suites moteur (Chrome, FlaUI) y ont tourné ; une passe sur un bureau au repos reste souhaitable pour FlaUI (R-17).
- `gateways › mobile-direct` : un dépassement de 30 s isolé (§3), non attribué.
- Le décompte « 174 » : le shell compte aujourd'hui **174 fichiers de test** (T3). **H** : l'écart « 169 / 174 » des rapports d'origine vient peut-être de ce comptage-là ; non démontrable sans le rapport d'origine.
- Le libellé français « Resonder … » (Capacités) est une faute (« Sonder … ») : volontairement non modifié.
- Nombreux avertissements de lint (487) : non traités (BL-06 reste ouvert, pas de nettoyage en masse).
- Réseau (inchangé, `docs/NETWORK-POLICY.md`) : DNS avant refus, `dgram` du noyau non gardé, processus enfants non isolés, backend Hermes partiel.
- Secrets : un secret INCONNU, sans nom parlant, dans un texte libre peut passer au journal ; les journaux anciens ne sont pas réécrits (exposition historique possible : à surveiller, non recopiée ici).
- Sauvegarde externe, SSH/Tailscale réel, voix au micro : vérifications manuelles M1–M3 du BACKLOG du 19-10, toujours à faire.

### Ressources résiduelles (non touchées : propriété incertaine)

Constatées en lecture seule, **antérieures à mes passes finales (origine non prouvée, voir la nuance en §11.6)** (créées entre 12:29 et 12:54 le 2026-10-22, sans fichier de propriété `owner.json`, donc hors de portée du balayage du dépôt) :

- 16 dossiers `%TEMP%\jarod-e2-*` et **148 processus `chrome.exe`** (16 arbres) qui les portent encore ;
- 9 racines `%TEMP%\jarod-e2e-*` plus anciennes.

Les ressources créées par cette session (une passe interrompue : un arbre `vitest` + ses `chrome` ; cinq profils jetables) ont été arrêtées par numéro de processus puis supprimées après vérification du marqueur de propriété ; **aucun arrêt par nom de programme** n'a été fait. Les passes finales ne laissent rien (`global-setup` des e2e et recensement du dossier temporaire).

### Autorisations précises encore nécessaires

Rien ci-dessous n'a été fait ; chaque point attend votre accord (détails en §11.3, §11.4 et §11.6).

1. **Nettoyer les ressources résiduelles** : inventaire par profil et PID en §11.6 ; rien n'est arrêté ni supprimé tant que vous n'avez pas validé le périmètre.
2. **`npm ci` dans `mobile/`** : plan en §11.6.
3. **Commits** (§11.4), puis **poussée** d'une branche, puis lecture de la CI sur le commit exact.
4. **Une passe FlaUI sur un bureau au repos** : protocole en §11.3 ; je ne demande que le créneau.
5. (Information) `engines/flaui` a été **reconstruit** depuis `sidecars/uia-flaui` avec la commande documentée de `engines.lock/README.md` ; l'ancienne version est conservée dans le dossier de travail de la session. Dites-moi si vous préférez la restaurer.

## 11. Deuxième passe (2026-10-22, soir) : révocation, couverture, FlaUI, lots, environnements, résidus, livraison

### 11.1 Preuve de révocation sans boîte native (rétablie)

Le remplacement du test e2e par un aperçu annulé laissait sans preuve automatique l'application réelle d'une révocation. Test ajouté : `jarod-core/packages/plugins/agent/test/permissions-revocation.test.ts` (3 tests, **réussis du premier coup**), sur la porte unique `executeGuardedTool` + `unifiedGate` + `PermissionGuard`, avec un outil factice qui compte ses exécutions :

1. sans règle, l'outil à effet demande l'accord (refusé) → 0 exécution ;
2. **autorisation bornée** (`planGrant` : cible `zone/*`, durée 1 h, 5 utilisations, canal « réglages ») → appel dans la zone **sans accord demandé**, 1 exécution ; appel hors zone → accord demandé, pas d'exécution ;
3. **révocation** (`planRevoke`, appliquée à chaud par `setRules`) → nouvel appel dans l'ancienne zone : accord **redemandé**, refusé, **compteur d'exécutions inchangé** ;
4. la révocation ne touche que la règle visée ; une **autonomie large choisie explicitement** (`broad`) reste active : aucune restriction générale n'est introduite ;
5. une règle échue ne joue plus.

Aucune boîte native : le test ne passe pas par Electron. Ce qu'il ne prouve pas : la confirmation native d'affaiblissement elle-même (couverte par `permission-rules.spec.ts` e2e, qui répond à la boîte) ni l'écriture dans le stockage réel (couverte par `autonomy.engine.test.ts`, boucle réelle). **Dépendance de commit** : ce test importe `planGrant`/`planRevoke` de `permissions/src/admin.ts`, fichier **non commité** (éditeur de règles, travail antérieur) : il ne peut être commité qu'avec ou après ce lot (§11.4, lot D).

### 11.2 Couverture finale, par catégorie (rien n'est « tout validé »)

Les passes complètes T1 à T9 (§3) ont été faites AVANT les changements de cette deuxième passe (`child-env.ts` pour MCP, nouveau test de révocation). Pour ces changements, seule la zone touchée est rejouée (voir « rejoué après » ci-dessous), pas les suites sans rapport.

| Catégorie | Résultat |
|---|---|
| **Exécutés** | T4 : 346 fichiers / 3111 tests ; T5 : 48 / 409 ; T3 : 174 / 1382 ; T7 (e2e) : 82 ; T9 (Python ciblé) : 62 ; + rejoué après la 2ᵉ passe : voir ci-dessous |
| **Réussis au premier essai** | Tous les tests des passes finales T3 à T7 : **aucun `retry` n'est actif** (les deux `retry: 2` temporaires ont été retirés avant ces passes) ; `permissions-revocation` 3/3 ; `child-env` 10/10 ; `mcp` 24/24 |
| **Réussis après retry** | **0** dans les passes finales. Historique : `desktop-autonomy.engine` n'a réussi qu'avec `retry: 2` avant la correction FlaUI, retry retiré depuis |
| **Ignorés** | Noyau : 3 fichiers / 18 tests (`rag` 13, `embeddings` 3, `tools` 1, `agent` 1 fichier : moteur ou modèle absent) ; shell (vitest) : 3 ; e2e : **7** (`package-restic-cycle` ×6, `voice-turn-latency` ×1) |
| **Échec intermittent non attribué** | `gateways › mobile-direct › lets the phone forget this computer by itself` : un dépassement de 30 s une fois (machine occupée), 3/3 réussi isolé |
| **Suites non rejouées** | voir le tableau suivant |

Rejoué APRÈS les changements de la 2ᵉ passe, justifié par la zone : `tsc` des paquets `kernel`, `plugin-mcp`, `plugin-tools`, `plugin-agent` (aucune erreur) ; `kernel` complet (8 fichiers, 63 tests) ; `plugin-mcp` complet (5 fichiers, 24 tests, dont le MCP réel de bout en bout) ; `tools` : `shell-env` + `credential-stores` (4) ; `agent` (projet `unit`) : `permissions-revocation`, `audit`, `proofs-tasks`, `tool-risk-metadata`, `contracts` (5 fichiers, 59 tests) ; ratchet de renommage `repo/rename-guard` (5).

| Zone / suite | Statut | Justification |
|---|---|---|
| Typecheck complet du noyau (T1, 29 paquets) | **réussi avant** la 2ᵉ passe ; **rejoué seulement sur 4 paquets** après | seuls `kernel`, `mcp`, `tools`, `agent` ont changé ; un typecheck complet reste à refaire sur l'arbre exact de chaque commit (§11.4) |
| Shell `apps/desktop` : typecheck, vitest (T2, T3), e2e (T7) | réussis avant ; **non rejoués** | aucun fichier du shell touché en 2ᵉ passe |
| **Rust** (`host-rust`) | **`cargo test` NON exécuté** ; seule la sonde `jarod-sandbox selftest` a tourné (5 contrôles verts) | aucun fichier Rust modifié ; couverture Rust complète non démontrée par ce suivi |
| **Pont Python complet** | **NON exécuté** ; 62 tests ciblés (credential stores, permissions, windows_host) | seul `permissions.py` (liste des magasins d'identifiants) a changé |
| **Mobile** (`mobile/`) | **NON exécuté** (aucune installation faite) | CI ajoutée mais non exécutée ; `npm ci` attend votre accord (§11.6) |
| **Paquet Windows** (`release/win-unpacked`, NSIS) | **NON construit, NON validé** | dépend des tests restic empaquetés (ci-dessous) |
| Tests restic empaquetés (`package-restic-cycle` ×6) | **NON validés** (ignorés : exigent le paquet installé) | |
| Latence vocale réelle (`voice-turn-latency`) | **NON validée** (ignorée : exige un vrai modèle et un micro) | |
| Sauvegarde externe réelle, SSH/Tailscale, voix au micro (M1–M3 du BACKLOG du 19-10) | **NON vérifiées** | vérifications manuelles |
| CI GitHub | **aucune exécution** sur ces changements | rien n'est commité ni poussé |

**Conclusion honnête** : les suites qui ont tourné sont vertes, mais les points ci-dessus sont ouverts ; on ne peut pas en déduire « tout est validé ».

### 11.3 FlaUI : changements de focus, nettoyage, passe sur bureau au repos

**Ce que fait le moteur (`sidecars/uia-flaui/Program.cs`, fonction `Foreground` et `Native.ForceForeground`)**, avant TOUTE action de saisie ou de clic sur une fenêtre :

1. essai 1 : voie UIA normale (`Window.Focus()`), puis attente jusqu'à 8 × 50 ms que la fenêtre cible soit au premier plan ;
2. essais 2 et 3 seulement si l'essai 1 n'a pas suffi : `ForceForeground` = (a) `ShowWindow(SW_RESTORE)` **uniquement si la fenêtre cible est réduite**, (b) `AttachThreadInput(moi, fil du premier plan actuel, true)`, (c) `BringWindowToTop` + `SetForegroundWindow` sur la cible, (d) **détachement dans un bloc `finally`** : le fil est détaché même si une des deux dernières API lève ;
3. si la cible n'est toujours pas au premier plan : exception « la fenêtre n'a pas pu passer au premier plan : rien n'a été envoyé » (refus avant d'envoyer, comme avant).

**Nettoyage, y compris en erreur** : l'attachement de fil est le seul état global modifié et il est défait dans le `finally` (erreur de l'API comprise). Aucune touche n'est envoyée à la fenêtre qui était au premier plan, aucun réglage du bureau n'est changé (`ForegroundLockTimeout` n'est pas modifié). **Limite dite telle quelle** : la fenêtre qui était au premier plan AVANT n'est **pas** remise au premier plan à la fin ; seule la fenêtre cible (fenêtre de démonstration des tests) est amenée devant. Un processus du moteur interrompu en plein milieu ne laisse rien d'autre qu'un attachement qui disparaît avec le fil/processus.

**Protocole de passe répétée sur bureau au repos (non lancé)** : une seule consigne pour vous, un créneau d'environ 10 minutes sans toucher la machine (ni clavier, ni souris, ni vidéo au premier plan). Pendant ce créneau, je lancerai seulement :

- 5 fois de suite, un fichier à la fois : `flaui.engine.test.ts`, puis `desktop-autonomy.engine.test.ts` (fenêtres de démonstration créées et fermées par les tests eux-mêmes) ;
- en parallèle, l'échantillonneur en lecture seule `fg-sampler.ps1` (fenêtre au premier plan toutes les 250 ms, sans rien modifier) pour joindre la cause au résultat.

Aucune action sur vos applications, aucun changement global du bureau, aucun arrêt de processus par nom. Critère : 10/10 réussis sans `retry` = R-17 levé ; sinon l'échantillon dit quelle fenêtre avait le premier plan. **Ce que je vous demande : seulement le créneau précis** (par exemple « demain à 9 h pour 15 minutes »).

### 11.4 Découpage en commits par dépendances (rien n'est commité, rien n'est indexé)

**Constat qui change le découpage** : l'arbre contient **213 entrées non commitées**, dont une grande partie est un travail ANTÉRIEUR à cette mission (éditeur de règles de permissions, sauvegarde restic, mini-fenêtre, intégrations « plus3 », agentdojo, modèles locaux, garde de l'expéditeur IPC, prérogative…). Mes changements en dépendent ou en partagent les fichiers. Je ne propose donc **pas dix commits indépendants** ; je propose des lots dans cet ordre, les lots A à E (travail antérieur, à relire et décider par vous) puis mes lots, dont certains ne peuvent partir qu'APRÈS un lot antérieur.

**Méthode de contrôle non destructive** (rien dans votre index ni votre arbre de travail) : `scratchpad\mktree.mjs` construit l'arbre d'un lot dans un **index temporaire** (`GIT_INDEX_FILE`) : fichiers entiers par `git add`, portions par un patch `-U0` filtré appliqué à cet index temporaire (`git apply --cached`), puis `git write-tree` et `git diff-tree --stat` contre `HEAD`. Vérifié sur le lot 5 : l'arbre `d8797bd…` = 4 fichiers, +112/−4 lignes, 4 portions de `agent.ts` sur 35 ; l'index réel est resté inchangé (213 entrées, rien d'indexé). Seuls des objets git non référencés sont écrits (nettoyables par `git gc`). Pas de stash, pas de reset, pas de clean, aucune suppression de vos fichiers. `scratchpad\closure.mjs` vérifie en lecture seule les imports relatifs de chaque lot contre `HEAD`.

**Règle de validation** : chaque lot est validé sur **son arbre exact** (extrait de l'index temporaire dans un dossier jetable, hors de votre dépôt, avec ses dépendances), jamais sur l'arbre de travail qui contient aussi des changements non indexés. Cette extraction + typecheck + tests du lot **n'est pas encore faite** : elle suit votre accord sur les lots ; seul le contrôle de construction de l'arbre l'a été (lot 5).

**Lots antérieurs (non miens ; fichiers entiers, à décider avec vous)** :

| Lot | Contenu (entrées non commitées) | Pourquoi il compte pour mes lots |
|---|---|---|
| **A** modèles locaux | `llm/*`, `LocalModelsSection`, `local-models*`, `bridge/.../local-models.ts`, `engines.lock/*` | ma correction de type `bridge/test/local-models.test.ts` (lot 2) s'applique sur le contrat qui y est |
| **B** sauvegarde restic | `external-restic*`, `restic-*`, `ResticArchiveBlock`, `bundle-restic.mjs`, `engines.lock/restic.json`, licences G2/G4, `package-restic-cycle.spec.ts` | `launch.ts` mélange `executablePath` (B) et ma ligne `ELECTRON_RUN_AS_NODE` |
| **C** mini-fenêtre | `mini-window*`, `preload/mini.ts`, `public/mini.*`, `mini-summary*` | aucune dépendance de mes lots |
| **D** éditeur de règles / autonomie | `permissions/src/admin.ts`, `guard.ts` (22 portions), `cli/permissions.ts`, `agent/permissions-tool.ts`, `PermissionRulesEditor.tsx`, `permission-rules.spec.ts`, `autonomy.test.ts`, `rules-edit.test.ts`, `autonomy.engine.test.ts`, `desktop-autonomy.engine.test.ts`, `contracts/*`, `agent.ts` (31 portions sur 35), `prerogative.ts` | **mes lots 5, 6, 7 et 8 touchent ces fichiers** ; `permissions-revocation.test.ts` importe `admin.ts` |
| **E** intégrations « plus3 » | `integrations/src/impl/*` (sbom, osquery, sandboxie, smolvm, media, desktop…), `otel/`, `catalog-plus3.ts`, `cockpit/*`, agentdojo, tests moteur | `sbom.ts`, `probe.ts`, `browser-engine.ts` (lots 1 et 3) ; les tests moteur FlaUI (lot 8) |
| **F** divers | garde de l'expéditeur IPC, `jarod-core.ts`, `tray.ts`, `boot.ts`, locales, pnpm-lock, `docs/*` antérieurs, `linux/plymouth/*` (binaires, **hors périmètre Windows**, à exclure) | `shell.spec.ts` partagé |

**Mes lots**, chacun avec : sujet · fichiers et portions · changements antérieurs inclus/exclus · dépendances · validation prévue sur l'état exact du commit.

| # | Sujet | Fichiers et portions | Antérieur inclus / exclu | Dépend de | Validation prévue sur l'arbre exact |
|---|---|---|---|---|---|
| 1 | `fix(browser): attente bornée du navigateur jetable` | `browser-engine.ts` (24 portions : celles de `parseDevToolsActivePort`, `profileProcessIds`, `launchDisposableBrowser`, `killProfileProcesses` ; reste = lot E, **exclu**), `browser-launch.test.ts`, `browser.lifecycle.engine.test.ts` | exclu : le reste de `browser-engine.ts` s'il est du lot E | **E** si `browser-engine.ts` en dépend (à vérifier par typecheck de l'arbre) | typecheck `plugin-integrations` ; `browser-launch` ; `browser.lifecycle.engine` (Chrome réel) |
| 2 | `fix(types,e2e): contrat réel des modèles locaux, sélecteur Capacités, lancement e2e` | `bridge/test/local-models.test.ts` (5 portions), `shell.spec.ts` (portion « exact: true » seule), `launch.ts` (portions `NOT_INHERITED`) | exclu : `executablePath` (B), nouvelles lignes de l'éditeur de règles dans `shell.spec.ts` (D) | A (contrat des modèles locaux), D pour la partie `shell.spec.ts` « Vérifier/Appliquer » → **ces trois portions-là partent avec D** | typecheck `bridge` ; vitest `local-models` ; lancement e2e de `capabilities` |
| 3 | `feat(security): environnement des processus enfants par famille` | `kernel/src/child-env.ts` (+ export `package.json`), `mcp.ts`, `builtin.ts` (2 portions sur 8), `artifacts.ts` (2 sur 9), `ps.ts`, `act.ts`, `video.ts`, `hyperv.ts`, `isolated.ts`, `wakeword-isolated.ts`, `probe.ts` (portion `childEnv`), `sbom.ts` (**nouveau fichier du lot E** : la ligne `childEnv` part avec E), tests `child-env`, `mcp-env` (+ fixture), `shell-env` | exclu : tout le reste de `builtin.ts`, `artifacts.ts`, `probe.ts` | E pour `sbom.ts` ; sinon **autonome sur HEAD** | typecheck `kernel`, `mcp`, `tools`, `agent`, `hyperv`, `embeddings`, `voice` ; tests `kernel` + `mcp` + `shell-env` ; rename-guard |
| 4 | `feat(security): une référence pour les magasins d'identifiants` | `contracts/v1/credential-stores.reference.json`, `path-guard.ts` (3 portions, toutes de ce lot), `file-gate.ts`, `shell-guard.ts`, `disk.ts`, `permissions.py` (3 portions), 5 tests | exclu : rien de mixte connu | **autonome sur HEAD** | tests des 3 gardes + pytest ciblé (62) |
| 5 | `fix(logs): masquage structuré des arguments d'outils` | `redact.ts`, `agent.ts` (4 portions sur 35), `redact-args.test.ts`, `audit.test.ts` | exclu : 31 portions de `agent.ts` (D) | **autonome sur HEAD** (arbre contrôlé : `d8797bd…`) | typecheck `kernel` + `agent` ; `redact-args`, `audit` |
| 6 | `feat(network): politique Internet pour les points d'entrée autonomes` | `network.ts` (4 portions), `cli/src/main.ts` (2 portions sur 5 : l'import et l'appel), `network-entry.test.ts`, `docs/NETWORK-POLICY.md` (3 portions) | exclu : 3 portions de `main.ts` (D, `permissions.ts`) | **autonome sur HEAD** | typecheck `kernel` + `cli` ; `network-entry` |
| 7 | `feat(autonomy): risque d'outil déclaré, jamais accordé par omission` | `registry.ts` (4 portions, toutes de ce lot), `tool-risk-metadata.test.ts`, `contracts.test.ts`, `proofs-tasks.test.ts`, `permissions-revocation.test.ts`, `docs/PERMISSIONS-AUTONOMIE.md` | exclu : tout `agent.ts` | **D** (le test de révocation importe `admin.ts`, `tool-risk-metadata` exerce `agent.ts`) | typecheck `tools` + `agent` ; tests agent `unit` ciblés ; e2e `connected-browser` |
| 8 | `test(engines): exécution sérielle des suites moteur ; premier plan FlaUI` | `package.json` racine (1), `agent/package.json`, `agent/vitest.config.ts`, `integrations/vitest.config.ts`, `tools/test/system-read.test.ts` (3 portions), `Program.cs` (portion `Foreground`/`ForceForeground` ; ~137 lignes antérieures **exclues**), `flaui.engine.test.ts` (portions) | exclu : le reste de `Program.cs` et des tests FlaUI (E) | E (fichiers FlaUI), D (`desktop-autonomy.engine`) | build du sidecar hors ligne ; passes sérielles des suites moteur (§11.3 pour la passe au repos) |
| 9 | `ci: feature/windows-port, lancement manuel, mobile` | `.github/workflows/ci.yml` (5 portions, toutes de ce lot) | — | **autonome**, mais la tâche `mobile` n'a jamais tourné | lecture de la CI après poussée uniquement (§11.6 avant) |
| 10 | `docs(audit): suivi de remédiation 2026-10-22` | `docs/audit/REMEDIATION-2026-10-22.md`, `docs/SECRETS.md` (2 portions) | — | à la fin | relecture |

Pas dix commits obligatoires : **4, 5, 6 et 9 sont autonomes sur HEAD** et peuvent partir tout de suite ; **3 aussi, sans la ligne de `sbom.ts`** ; 1, 2, 7 et 8 attendent les lots antérieurs A, D ou E (ou partent dans le même commit qu'eux, à votre choix). Si vous préférez moins de commits : {4, 5, 6, 3} en un « durcissement », {1, 8} en un « fiabilité des tests moteur », {7} avec D.

**Reste à faire pour figer les lots (avant votre feu vert)** : l'identification des portions mixtes de `browser-engine.ts`, `Program.cs`, `flaui.engine.test.ts`, `launch.ts` et `shell.spec.ts` est faite par mots-clés ; la sélection définitive se vérifie dans l'index temporaire, portion par portion, avec vous si une portion est ambiguë.

### 11.5 Environnements enfants : une configuration MCP ne réintroduit plus un jeton interne

**Constat (réel)** : jusqu'ici, `explicit` (la configuration du serveur) était ajouté APRÈS le filtre et sans contrôle : une configuration MCP qui nommait `JAROD_GATEWAY_TOKEN` ou `JAROD_OS_CONTROL_TOKEN` (par exemple en y recopiant la valeur de l'orchestrateur) le **réintroduisait silencieusement** chez un serveur tiers. Aucune expansion `${VAR}` n'existe dans `mcp.ts` : le seul chemin était le nom littéral.

**Correction** : `childEnv("mcp", …)` ignore désormais, dans `explicit`, tout nom reconnu comme jeton de contrôle interne (`isInternalSecretName` : passerelle, canal de contrôle, relais, jetons des passerelles de messagerie, `HERMES_*`, ancien préfixe ; insensible à la casse). **Inchangé** : les identifiants dont le serveur a besoin (`GITHUB_TOKEN`, clés de ses propres services, y compris une clé de fournisseur de modèles qu'il vous plairait de lui donner) restent utilisables parce que sa configuration les nomme, sans hériter de ceux de l'orchestrateur ; l'agent et les moteurs (`agent-shell`, `engine`) gardent la liberté d'un secret injecté au point d'usage selon vos permissions d'exécution.

Preuves : `kernel/test/child-env.test.ts` (10/10, dont le nouveau test) et `plugins/mcp/test/mcp-env.test.ts` (3/3, **processus MCP réel** : `JAROD_GATEWAY_TOKEN` et `JAROD_OS_CONTROL_TOKEN` fournis par la configuration → absents ; `CONFIGURED_TOKEN` → présent). Limite : un jeton interne passé sous un nom que ni la liste ni le motif ne reconnaissent ne serait pas retiré.

### 11.6 Résidus et mobile (inventaire en lecture seule, rien n'est arrêté ni supprimé)

**Profils Chrome résiduels** (16 racines, 148 processus `chrome.exe` portant `jarod-e2` dans leur ligne de commande, sur 167 `chrome.exe` au total — les 19 autres ne portent pas ce marqueur et ne sont **pas** dans le périmètre). Aucun de ces dossiers ne contient `owner.json` : leur propriété n'est pas prouvée.

| Profil (`%TEMP%\…\chrome`) | Processus | PID racine | Démarré |
|---|---|---|---|
| jarod-e2-qE4NXP | 10 | 1288 | 12:29:08 |
| jarod-e2-PLtvAl | 9 | 50740 | 12:29:36 |
| jarod-e2-I8WqWr | 10 | 48832 | 12:29:57 |
| jarod-e2-8UGxsx | 9 | 48360 | 12:42:23 |
| jarod-e2-B6yEz9 | 9 | 372 | 12:42:27 |
| jarod-e2-fKygfh | 9 | 54140 | 12:42:29 |
| jarod-e2-Xi442p | 10 | 7216 | 12:44:10 |
| jarod-e2-Gk5OIU | 9 | 32608 | 12:45:15 |
| jarod-e2-2oc73K | 9 | 39864 | 12:51:59 |
| jarod-e2-eaLdpC | 10 | 37724 | 12:52:02 |
| jarod-e2-t2RXCS | 9 | 52280 | 12:52:05 |
| jarod-e2-9X7YcS | 9 | 56868 | 12:52:08 |
| jarod-e2-BL6zJy | 9 | 58164 | 12:52:11 |
| jarod-e2-x0l3HV | 10 | 39024 | 12:53:48 |
| jarod-e2-OgErvG | 8 | 59760 | 12:54:44 |
| jarod-e2-NZc7cy | 9 | 61136 | 12:54:48 |

**Dossiers sans processus connu** (aucun `owner.json`, anciens) : 7 `jarod-e2app-*` (17 au 20-10) et 9 `jarod-e2e-*` (18-10 23:53). **Total des dossiers** : 16 + 7 + 9 = **32** (le décompte « 25 » de la première rédaction omettait les 7 `jarod-e2app-*`).

**Nuance sur l'origine** : les heures 12:29 à 12:54 du 22-10 sont dans la même journée que cette session ; je ne peux pas exclure qu'une partie vienne d'une de mes passes interrompues du matin ; les profils que j'ai créés et supprimés sont connus et ne figurent plus ici, mais l'absence de `owner.json` ne permet pas de trancher. **Je n'y touche donc pas.**

**Plan proposé après votre validation du périmètre** (rien n'est exécuté) : pour chaque PID racine de la table, vérifier que sa ligne de commande contient exactement le chemin du profil listé, arrêter **l'arbre de ce PID** (jamais par nom de programme), vérifier qu'aucun autre processus ne référence le profil, puis supprimer ce seul dossier après relecture de son contenu (un profil Chrome jetable). Les 16 dossiers `jarod-e2-*`, puis les 16 anciens à votre choix. Dites-moi quels profils retirer du périmètre.

**Mobile — `npm ci` (non lancé, j'attends votre accord)** :

- **Lockfile** : `mobile/package-lock.json` (suivi par git, `lockfileVersion` 3, 271 paquets, 9 dépendances + 7 de développement). `mobile/node_modules` existe mais est **vide** (créé le 22-10 à 12:28).
- **Scripts qui pourraient s'exécuter** : un seul paquet du lockfile déclare un script d'installation, `node_modules/fsevents` (macOS uniquement, sans effet sous Windows) ; le manifeste de `mobile/` n'a pas de `postinstall` ni `prepare`. Pour exclure tout risque, la commande prévue est **`npm ci --ignore-scripts`** (celle de la CI), qui n'exécute aucun script de cycle de vie.
- **Pas d'élévation, pas de pilote, pas de modification système** ; écrit uniquement dans `mobile/node_modules` (ignoré par git). Aucune mise à jour de dépendance : `npm ci` suit le lockfile tel quel.
- **Validations prévues ensuite** : `npm run typecheck`, `npm test`, `npm run build` (qui fait `tsc --noEmit` puis `vite build` dans `mobile/dist`, ignoré). Pas d'APK (Gradle, Android SDK).

### 11.7 Livraison : ce qui n'est PAS validé

- **Tests restic empaquetés** (`package-restic-cycle`, 6 tests) : **non validés**, ignorés faute de paquet installé.
- **Latence vocale réelle** (`voice-turn-latency`) : **non validée**, ignorée faute de modèle réel et de micro.
- **Paquet Windows** : ni construit ni installé.
- **Rust (`cargo test`)**, **pont Python complet**, **mobile**, **CI GitHub**, **FlaUI sur bureau au repos** : non exécutés ou non confirmés, voir §11.2 et §11.3.
- Les suites vertes de ce suivi couvrent les zones modifiées sur ce poste, rien de plus. Il ne faut pas en tirer « tout est validé ».

## 12. Incident de validation du 2026-10-22 (22:33) et lot préalable « isolement Git des tests »

### 12.1 Incident et requalification

**Cause.** Pendant la troisième passe, les gardes `jarod-core/tests/repo/*` ont tourné sur l'arbre de validation avec trois variables :
- `GIT_DIR=D:/Jarod-OS/.git` ;
- `GIT_WORK_TREE=<arbre de validation>` ;
- `GIT_INDEX_FILE=<index temporaire>`.

`staged-files.test.ts` en a hérité. Son `git init` a réinitialisé le vrai dépôt et écrit `core.worktree`, puis son `git commit` a créé `5a9b30d` sur `feature/windows-port`.

**Réparation.** La branche a été remise sur `d42ae24` par `update-ref`, avec contrôle de l'ancienne valeur, et `core.worktree` a été retiré. `5a9b30d` est conservé (reflog et objets) : ni `gc` ni `prune`. Rien n'a été poussé. Le rapport complet est dans `D:\Jarod-OS-recovery-20261022\INCIDENT.md`, à côté de la sauvegarde.

**Requalification.** Les lots L1 à L9 et B1 de la troisième passe sont des **validations partielles avant incident** :
- la CI n'a jamais tourné à distance ;
- les e2e n'ont pas été rejoués ;
- les suites moteur ont été ignorées dans l'arbre de validation ;
- les gardes `repo/*` de cette passe sont invalides ;
- B1 est inachevé et B2 n'a pas été fait.

### 12.2 Correctif

Chaque appel git d'un test sur un dépôt fabriqué reçoit un environnement sans aucune variable `GIT_*`, quelle que soit la casse. L'environnement du shell appelant n'est jamais modifié.

| Fichier | Changement |
|---|---|
| `jarod-core/tests/repo/git-env.ts` (nouveau) | `isolatedGitEnv()` rend une copie sans `GIT_*` ; `stripGitEnv()` les retire d'un objet donné. |
| `jarod-core/tests/repo/git-env.setup.ts` (nouveau) + `tests/vitest.integration.config.ts` | Seconde ligne de défense : vide l'environnement du seul processus de test. Aucun test n'en dépend pour être sûr. |
| `jarod-core/tests/repo/git-env.test.ts` (nouveau) | Test de non-régression (§12.3). |
| `tests/repo/staged-files.ts`, `tests/repo/ignored-sources.ts` | Paramètre `env` facultatif. Par défaut, l'environnement hérité : le crochet `pre-commit` a besoin du `GIT_DIR` fixé par git. Comportement de `check-staged-files` et `check-ignored` inchangé. |
| `staged-files.test.ts`, `ignored-sources.test.ts`, `upstream-patches.test.ts` | `env: isolatedGitEnv()` sur chaque git, `readStaged` et `ignoredSources`. La lecture du vrai dépôt (`ignoredSources`) passe aussi `GIT_OPTIONAL_LOCKS=0`. |
| `integrations/test/engines/opencodereview.engine.test.ts` | Environnement propre pour les git du test. `ocr.exe` ne reçoit déjà que la liste `ENV_KEEP` de `code-review.ts`. |
| `scripts/autonomy/lot.test.mjs`, `scripts/autonomy/lot-lib.mjs` | Environnement propre pour les git du test et pour le `git()` de `lot-lib`. Un lot porte toujours sur `root`, et un `GIT_DIR` hérité le détournerait. |

### 12.3 Contre-épreuve et tests exécutés

**Contre-épreuve.**
- **Montage** : copie de `git-env.test.ts`, hors dépôt (`scratchpad\counterproof`), avec un `git-env.ts` dont l'assainissement est désactivé. Aucune variable n'y pointe sur `D:\Jarod-OS` : la victime est un dépôt temporaire.
- **Résultat** : 3 échecs sur 5, ce qui est attendu.
- **Échec principal** : `expect(snapshot()).toEqual(before)`. La victime reçoit `worktree = …\jarod-gitenv-tree-…` et un nouveau commit dans `HEAD` et dans son reflog, ce qui reproduit l'incident.
- **Deux autres échecs** :
  - le filtre ne retire plus `GIT_DIR`, `Git_Work_Tree`, `git_index_file` ni `GIT_CONFIG_GLOBAL` ;
  - le processus garde `GIT_ASKPASS`, `GIT_EDITOR`, `GIT_INSTALL_ROOT` et `GIT_TERMINAL_PROMPT`.

**Avec le correctif**, toutes les validations passent :

| Validation | Résultat |
|---|---|
| `tsc -p` de `jarod-core/tests` | 0 erreur |
| `tsc -p` de `plugin-integrations` | 0 erreur |
| `node --check` sur `lot-lib.mjs` et `lot.test.mjs` | OK |
| Suite `repo` complète | 26 fichiers, 226/226 |
| `node --test scripts/autonomy/lot.test.mjs` | 5/5, 0 ignoré |
| `opencodereview.engine.test.ts` + `cockpit.test.ts` | 33/33, 0 ignoré |

Pour OpenCodeReview, le moteur réel `engines/opencodereview/ocr.exe` 1.12.12 a été utilisé. Son SHA256 est identique au verrou (`c34033f9…`). La revue tourne contre un faux modèle local, et l'appel distant est refusé avant tout lancement. Aucun envoi de code, aucun téléchargement.

### 12.4 Surveillance du dépôt principal

Les relevés en lecture seule, pris avant et après la contre-épreuve et les validations, sont **identiques** (`git --no-optional-locks`). Ils couvrent :
- `HEAD` = `d42ae24` et toutes les références ;
- `config`, `packed-refs` et le reflog de la branche ;
- le contenu de l'index et `.git/index` octet pour octet ;
- 0 fichier indexé ;
- 230 entrées de `status` avec l'empreinte de chaque fichier.

Aucun fichier de `.git` n'a été écrit depuis 23:00.

**Inventaire contre la liste d'avant réparation** (219 fichiers et leurs empreintes) :
- **Modifications intentionnelles de fichiers suivis (8)** : `staged-files.ts`, `staged-files.test.ts`, `ignored-sources.ts`, `ignored-sources.test.ts`, `upstream-patches.test.ts`, `vitest.integration.config.ts`, `lot.test.mjs`, `lot-lib.mjs`.
- **Nouveaux fichiers (3)** : `git-env.ts`, `git-env.setup.ts`, `git-env.test.ts`.
- **Fichier déjà non suivi, modifié intentionnellement (1)** : `opencodereview.engine.test.ts`, qui fait partie d'un travail antérieur, le lot E.
- **Modifications inattendues : aucune.** Les 218 autres fichiers de la liste ont la même empreinte.

**Comptages.**
- La liste d'avant réparation compte 219 fichiers (un par fichier) ; il y en a 230 maintenant (219 + 11 chemins du correctif).
- Le « 213 » du bilan de réparation venait de `git status --short`, qui replie les dossiers non suivis ; ce même décompte donne 224 aujourd'hui, soit 213 + 11.

### 12.5 Limites restantes

- Le correctif protège les tests et `lot-lib`. Les scripts de banc `tests/bench/*` qui lisent le vrai dépôt n'ont pas été modifiés.
- `upstream-patches` lit `S:\SANK-UI` en lecture seule ; son test a tourné, et il est ignoré si l'amont manque.
- Un dossier `%TEMP%\jarod-ocr-test-Hoam9E` (créé à 22:28:33, pendant la troisième passe interrompue) subsiste. Je n'y ai pas touché.
- Les tests passés ici prouvent l'isolement sur ce poste. Ils ne remplacent ni la CI distante, ni les e2e, ni la reprise de la chaîne de validation.

### 12.6 Place dans l'ordre des commits

Ce correctif forme un **lot préalable « test(repo): isolement Git des tests sur dépôts fabriqués »**, à commiter avant tout autre lot. Exception : `opencodereview.engine.test.ts` est non suivi et appartient au lot E ; sa ligne d'environnement part avec E. Aucune autre validation ne reprend avant ce lot. La reprise utilisera un dépôt jetable avec son propre `.git`, et un relevé avant/après du dépôt principal.
