# Audit complet Jarod-OS — 2026-10-16

Périmètre : HEAD de `feature/windows-port`, dépôt unique `C:\Users\San\herald-os` (shell, noyau `jarod-core/`, bridge `plugins/herald-os-bridge/` sont dans le même dépôt git). Aucun fichier source modifié, aucun commit, aucun push, aucun changement de branche. Seul ce rapport a été ajouté.

## 1. Résumé exécutif

1. Les correctifs R1 tiennent sur le HEAD (`30b17fb`) : 8 invariants sur 10 vérifiés par code et tests, 1 partiel (un chemin `tcp://` subsiste côté client Python), 1 non vérifiable en direct (named pipe de bout en bout, pas d'app lancée).
2. Suites exécutées et vertes : shell typecheck + 883 tests (135 fichiers), noyau typecheck + tests (≈ 1 500 tests), bridge 218 tests (14 ignorés), lint sans erreur.
3. R4 (écritures `run_shell` non confinées sous Windows) : **ouvert**, confirmé. Le code refuse `writeScope: workspace` sous Windows plutôt que de le prétendre.
4. R5 (`curl | bash` non épinglé) : **ouvert**, confirmé à `linux/bin/herald-os:1332`.
5. R6 (vérification cosign des images) : **ouvert**, confirmé : la politique de signature n'est écrite que si `linux/image/cosign.pub` existe, et ce fichier n'existe pas.
6. R2 et R3 : **partiels** (les tests de la surface de contrôle passent ; le bout en bout en application n'est pas re-prouvé ici).
7. R9 : référence orpheline, aucune définition dans le dépôt ni dans les audits fournis ; classée obsolète faute de sujet vérifiable.
8. Plusieurs constats des audits précédents sont obsolètes (voir §7) : `os`/`os-run` retirés du backend, pas de « case os » trouvée dans le bridge.
9. Migration : la phase 0 (contrats et spike Rust) peut démarrer. Le host Rust **ne doit pas** être mis en production ni recevoir la phase sandbox tant que R4 reste ouvert ; R5 et R6 sont de petites corrections (effort S) à faire avant tout portage.

## Mise à jour — phase 0a (2026-10-16, après validation)

Changements **non commités** dans l'arbre de travail :

| Fichier | Changement |
|---|---|
| `plugins/herald-os-bridge/bridge/ui.py` | Suppression de `parse_tcp_endpoint` et de la branche TCP : seuls le pipe (`pipe://`) et le socket Unix sont acceptés. Invariant 2 passe à **pass**. |
| `plugins/herald-os-bridge/tests/test_os_ui.py`, `test_control_protocol_r2.py`, `test_control_security.py` | Tests adaptés : le `tcp://` est refusé (test `test_tcp_endpoint_is_refused_everywhere`) ; le fixture ne tourne plus en TCP ; le faux shell R2 est ignoré sur Windows (pas d'`AF_UNIX`). |
| `linux/bin/herald-os` | **R5** : `curl \| bash` remplacé par `install_hermes()` : téléchargement dans un dossier temporaire, contrôle SHA-256 contre `HERMES_INSTALLER_SHA256`, puis exécution. **La constante est vide : tant qu'elle n'est pas renseignée, l'installation de Hermes est refusée.** |
| `linux/image/packages.sh` | **R6** : l'absence de `cosign.pub` n'est plus un saut silencieux mais un avertissement explicite. |
| `.github/workflows/image.yml` | **R6** : nouvelle étape qui échoue si `COSIGN_PRIVATE_KEY` est défini sans `linux/image/cosign.pub` committé ; un avertissement sinon (les builds sans clé restent possibles). |

**Vérifications après changement** : bridge `200 réussis, 18 ignorés, 0 échec` (avant : 218 / 14) ; `npm run typecheck` du shell : code 0 ; `python -m py_compile linux/bin/herald-os` : OK ; `bash -n linux/image/packages.sh` : OK ; YAML de `image.yml` : valide.

**Régression de couverture à connaître** : 18 tests du bridge qui s'exécutaient sur Windows via le faux shell TCP ne tournent plus sous Windows (le faux shell n'a pas de pipe). Ils tournent sur macOS et Linux. La couverture du transport réel Windows (named pipe) reste à écrire.

**Ce qui reste ouvert après 0a** :
- **R5** : il faut un humain pour *lire* le script d'installation Hermes puis renseigner `HERMES_INSTALLER_SHA256`. Je ne l'ai pas épinglé : je ne peux pas valider ce script, et une somme prise au hasard serait un faux contrôle.
- **R6** : il faut générer la paire de clés cosign (`cosign generate-key-pair`), committer `linux/image/cosign.pub`, et mettre la clé privée dans les secrets CI. C'est une action humaine ; je ne génère ni ne stocke de clé.
- Le test d'intégration Windows du transport pipe n'existe toujours pas.

## 2. État exact des dépôts

| Élément | Valeur (vérifiée) |
|---|---|
| Chemin | `C:\Users\San\herald-os` (dépôt unique, OS Windows 11) |
| Branche | `feature/windows-port` |
| HEAD | `30b17fbf9d26001c2a72e7efb1d3bd580ab097da` (`fix(kernel): R3.5 ...`) |
| Suivi | fichiers suivis : arbre propre (`git diff` vide) |
| Non suivis préexistants (ne pas toucher) | `JAROD-CAPABILITY-AUDIT.md`, `audit jarod15-10.txt`, `prompt/` |
| Node | v24.20.0 (`engines` : shell `>=22.12.0`, noyau `>=22`) |
| pnpm | 12.6.0 (= `packageManager` du noyau, `jarod-core/package.json`) |
| Python | 3.15.0 global (`C:\Python315`) ; `uv` 0.12.18 (utilisé pour les tests bridge) |
| Shell | `package.json` racine : `typecheck`, `test`, `lint`, `typecheck:core`, `test:core`, `test:bridge`, `build` |
| Noyau | `jarod-core/package.json` : `typecheck` (`pnpm -r`), `test` (`pnpm -r test`), `bundle:gateway` |
| Bridge | `plugins/herald-os-bridge/tests/` (pytest). Pas de `package.json`. |

Noyau : `jarod-core/` n'a pas de dépôt git imbriqué (`git rev-parse --show-toplevel` renvoie le dépôt racine). Le bridge n'a pas non plus de dépôt propre.

Historique récent R1→R3 : `d15d2bc` (R1), `a02b78a`/`f3d2699` (R2), `6d717d9`…`30b17fb` (R2.2→R3.5).

## 3. Vérification des invariants R1

Verdicts : `pass` = code et test trouvés et exécutés ; `unverifiable` = code trouvé, pas d'exécution de bout en bout.

| # | Invariant | Verdict | Preuve |
|---|---|---|---|
| 1 | Aucun enfant ne reçoit de secret de contrôle | pass | `plugins/herald-os-bridge/bridge/util.py:31` (`CONTROL_ENV_NAMES`), `:48` (`child_env`), `:82` (`take_control_env`), `:107` (`run` passe par `child_env`) ; appel au chargement `plugins/herald-os-bridge/__init__.py:25` ; tests `tests/test_control_security.py:117-118`, `:133-139`, `:161-164`, `:185` (verts) |
| 2 | Pas de repli TCP loopback sous Windows | partiel | Côté shell : pipe seul (`apps/desktop/electron/shell/os-control.ts:150-156`, `:180`, `:248-252`). Côté Python, le client accepte encore `tcp://` : `plugins/herald-os-bridge/bridge/ui.py:132` (`parse_tcp_endpoint`). Ce chemin n'est pas émis par le shell, donc non atteint par la configuration normale, mais il reste. |
| 3 | Commandes panel-only refusent le jeton CLI | pass | `apps/desktop/electron/shell/control-authz.ts:445-447` (« the backend shell surface needs the backend token ») ; test `control-authz.test.ts:193` (vert) |
| 4 | Jeton backend ne permet pas `os`/`os-run` | pass | `control-authz.ts:61` (`RETIRED_COMMANDS`), `:70` (`BACKEND_COMMANDS`, allow-list sans `os`), `:439-442` (refus `unsupported`) ; test `control-authz.test.ts:162` |
| 5 | Commande inconnue refusée ET journalisée | pass | Refus : `control-authz.ts:450-454` (`unsupported`) ; journal : `control-authz.ts:604-620` (`ControlSecurity.check` enregistre **toute** décision, y compris refus) |
| 6 | Requête sans jeton refusée ET journalisée | pass | Refus : `control-authz.test.ts:17` ; journal de la tentative non attribuable : `os-control.ts:323-324` |
| 7 | Le journal ne contient jamais un jeton | pass | `control-authz.test.ts:131` (« never writes a token ») ; `control-authz.test.ts:295-310` (une valeur `Bearer …` n'est jamais écrite, le champ `requestId` est omis) |
| 8 | Aucune branche « même utilisateur donc autorisé » | pass, avec réserve | `os-control.ts:283-288` : un jeton sans SID de logon n'accorde que le compte, ce qui est journalisé. Le jeton reste exigé ; ce n'est pas une branche d'autorisation implicite. |
| 9 | Le named pipe est utilisé de bout en bout | unverifiable | Code : `os-control.ts:180`, `plugins/herald-os-bridge/bridge/ui.py:49-52` (`pipe_path_for`), tests `plugins/herald-os-bridge/tests/test_os_ui.py`. Pas d'application lancée ici (exigence GUI). |
| 10 | Secrets retirés de `os.environ` avant le reste | pass | `util.py:75` (`forget_control_env`), `:82` (`take_control_env` lit et retire `CONTROL_SOCKET`, `CONTROL_TOKEN`, `CLI_TOKEN` de `os.environ`), appelé au chargement `__init__.py:25` ; test `test_control_security.py:176-185` |

**Régression depuis d15d2bc** : aucune régression constatée par les tests. Un écart à surveiller : le client Python accepte `tcp://` (invariant 2).

## 4. Statut R2 → R9

Les libellés R2 à R9 viennent des notes d'audit fournies, pas d'un document du dépôt (voir §7 et §10).

| Risque | Statut | Preuve | Exploitation / impact | Effort | Dépendances |
|---|---|---|---|---|---|
| **R2** : contrôle typé, approbations uniques détenues par l'hôte | **partiel** | Commits `a02b78a`, `f3d2699` ; `plugins/herald-os-bridge/tests/test_control_protocol_r2.py` (vert) ; `control-authz.ts:423-447` | Surface de contrôle testée unitairement. Le bout en bout (approbation → exécution, dans l'application) n'est pas re-prouvé. | S (test e2e) | Aucune |
| **R3** : toute sortie du shell passe par la porte, masquée et bornée | **partiel** | Commits `6d717d9`…`30b17fb` ; `plugins/herald-os-bridge/tests/test_control_security.py` (vert) | Couverture unitaire fournie ; pas de test d'intrusion ni d'exécution réelle sur Windows ici. | S–M | R4 pour la partie écriture |
| **R4** : écritures de `run_shell` non confinées sous Windows | **ouvert** | `jarod-core/packages/plugins/permissions/src/shell-guard.ts:16-25` (« sur win32, `writeScope: "workspace"` est REFUSÉ ») ; `:338` ; `ANALYSE-2026-10-12.md:63` (D1) ; `HANDOFF.md:152` | Un `run_shell` autorisé (approbation une fois ou pour la conversation) peut écrire hors du dossier de travail, la liste blanche de programmes n'étant « pas un confinement » (`shell-guard.ts:20-25`). L'accord permanent est interdit pour cet outil (`plugins/agent/src/never-always.ts`, décision du 2026-10-04 dans `jarod-core/DECISIONS.md`). Le refus fail-closed évite un faux sentiment de sécurité mais ne protège pas. | **XL** (code natif : jeton restreint ou AppContainer, tests sur plusieurs Windows) | Architecture cible : sandbox du host Rust |
| **R5** : `curl \| bash` non épinglé | **ouvert** | `linux/bin/herald-os:1306` (`HERMES_INSTALLER = …/install.sh`) et `:1332` (`bash -c "curl -fsSL {HERMES_INSTALLER} \| bash"`) ; `scripts/bootstrap.sh:70` (texte seulement) | Un script distant non vérifié s'exécute au premier lancement, après confirmation utilisateur (`herald-os:1329-1331`) ou `--yes`. Pas de somme, pas de version figée. | **S** (télécharger, vérifier une somme, exécuter) | Aucune |
| **R6** : vérification cosign des images non active | **ouvert** | `linux/image/packages.sh:100-111` : bloc conditionnel `if [[ -f "$LINUX/image/cosign.pub" ]]` ; **`linux/image/cosign.pub` n'existe pas** (vérifié) ; `.github/workflows/image.yml:30-31` (signature seulement si le secret `COSIGN_PRIVATE_KEY` existe), `:81` ; aucune occurrence de `cosign verify` dans `linux/` ni `packaging/` | Une image non signée est acceptée à l'installation et à la mise à jour (`linux/bin/herald-os:1450`, `bootc switch`). | **S** côté code ; la clé est une action humaine (secret CI) | Génération de la clé par l'utilisateur |
| **R9** | **obsolète** (non définissable) | `grep -rn "\bR9\b"` dans le dépôt : aucune définition ; les audits fournis n'en contiennent pas non plus | Aucun sujet vérifiable. À redéfinir si la référence est importante. | — | — |

## 5. Architecture actuelle

### 5.1 Diagramme textuel des flux

```
Utilisateur
  │ clavier / souris / voix
  ▼
Shell Electron/React (apps/desktop)
  │  stores & UI (src/)  ──IPC──  preload  ──▶ main.ts
  │                                              │
  │                    ┌─────────────────────────┤
  │                    ▼                         ▼
  │         OsControlServer (os-control.ts)   BackendManager (backend/manager.ts)
  │         pipe://… (Windows) / socket        ws://127.0.0.1:<port>  (token par lancement)
  │                    │                         │
  │                    │ ControlSecurity          │ Gateway JSON-RPC
  │                    │ (control-authz.ts)       ▼
  │                    │                  Noyau jarod-core (gateway, agent)
  │                    │                         │
  │                    │                         ├──▶ modèles locaux / cloud (packages/plugins/gateways)
  │                    │                         ├──▶ executeGuardedTool ──▶ permissions (shell-guard, never-always)
  │                    │                         ├──▶ mémoire / RAG, sous-agents, planificateur, MCP, voix, navigateur
  │                    │                         ▼
  │                    └──────────────▶ Bridge Python herald-os-bridge (chargé dans Hermes)
  │                                       ├── child_env / take_control_env (util.py)
  │                                       ├── bridge/ui.py (dialogue avec le pipe du shell)
  │                                       └── bridge/host/{windows,linux,darwin}.py ──▶ Windows
  ▼
Journal audit.jsonl (côté hôte, sans jeton)
```

### 5.2 Frontières

| Frontière | Protocole | Direction | Authentification | Erreurs / timeout | Annulation / reprise | Audit | Contrat |
|---|---|---|---|---|---|---|---|
| UI ↔ main (IPC) | Electron IPC | bidirectionnelle | contexte de fenêtre | non vérifié ici | non vérifié ici | non vérifié ici | `apps/desktop/electron/**` |
| Shell ↔ bridge (contrôle) | JSON-lines sur named pipe (Windows) | requête/réponse | jeton par surface (`backend`, `cli`) | refus typé (`unauthenticated`, `unauthorized`, `unsupported`, `invalid`) : `control-authz.ts:37` | non vérifié | chaque décision : `control-authz.ts:604-620` | `ControlRequestShape` `:80`, `ControlDecision` `:102`, `ControlAuditEntry` `:126` |
| Backend ↔ gateway | WebSocket JSON-RPC sur loopback | bidirectionnelle | jeton de lancement (`backend/manager.ts:125`) | non vérifié | non vérifié | non vérifié | non vérifié (le gateway est dans `jarod-core/packages/bridge`) |
| Gateway ↔ outils | `executeGuardedTool` | appel | politique de permissions | refus explicite | non vérifié | journal côté noyau | `packages/plugins/permissions/src/` |
| Bridge ↔ Windows | `subprocess` avec argv fixe (jamais de chaîne shell) | appel | environnement filtré (`util.py:48`) | `ExecResult` sans exception (`util.py:107-115`) | délai de `run` : 15 s par défaut | audit en amont | `bridge/util.py` |

Note : la frontière « gateway ↔ outils » ne se trouve pas dans le périmètre lu dans cet audit au-delà des tests (`shell-guard.ts`, `never-always.ts`, `permissions.py`). Le contrat JSON des outils n'a pas été re-dérivé.

## 6. Capacités (vérifiées / partielles / absentes)

Niveau d'après les tests exécutés ici, pas d'après l'UI lancée.

| Domaine | Capacité | État | Backend réel | Test existant | Test exécuté ici | Limite |
|---|---|---|---|---|---|---|
| Sécurité | Autorisation des commandes de contrôle | vérifiée (unitaire) | `control-authz.ts` | `control-authz.test.ts` | oui, vert (shell `npm test`) | pas de bout en bout en application |
| Sécurité | Environnement des enfants filtré | vérifiée (unitaire) | `util.py` | `test_control_security.py` | oui, vert (bridge) | — |
| Sécurité | Confinement des écritures `run_shell` | **absente** (refus fail-closed sous Windows) | `shell-guard.ts` | oui (refus testé) | non (non lancé) | R4 |
| Sécurité | Approbations, accord « pour cette conversation » | partielle | `approvals-failclosed.test.ts` (kernel bridge) | oui | oui, vert (noyau) | pas d'e2e GUI |
| Système Windows | Bridge outils (`system_info` et autres) | partielle | `bridge/host/windows.py` | tests unitaires bridge | oui, vert | `verify-windows.ps1` non exécuté (voir §9) |
| Orchestration | Agent, sous-agents, planificateur, workflows | partielle | `jarod-core/packages/plugins/{agent,automation,workflows}` | oui | oui, vert (noyau) | pas de modèle réel |
| Modèles | Fournisseurs locaux et cloud | partielle | `packages/plugins/gateways` | 81 tests | oui, vert | modèles réels non testés |
| Mémoire / RAG | Recherche et indexation | partielle | `packages/plugins/tools` (RAG) | oui | oui, vert (noyau `tests`) | non testé avec corpus réel |
| Qualité | Lint | verte | `biome.json` | — | oui, 0 erreur (543 avertissements) | avertissements non traités |
| Image Linux | Mise à jour signée | **absente** | `linux/image/packages.sh:100-111` | aucun | non | R6 |
| Installation | Installation de Hermes | fragile | `linux/bin/herald-os:1332` | aucun | non | R5 |

## 7. Dette et doublons

Classement : **défaut réel**, **choix volontaire**, **dette acceptable**, **hypothèse non vérifiée**.

| Constat | Verdict | Preuve | Commentaire |
|---|---|---|---|
| Client Python accepte `tcp://` | défaut réel (mineur) | `bridge/ui.py:132` | Non émis par le shell ; à supprimer pour que le pipe soit le seul chemin |
| `parse_tcp_endpoint` « code mort » (ancienne note) | **obsolète** | encore appelé `ui.py:132` ; testé `test_os_ui.py:228-230` | Ce n'est pas du code mort ; voir ligne précédente |
| « case os inatteignable dans le répartiteur » (ancienne note) | **obsolète** | `os`/`os-run` refusés côté shell (`control-authz.ts:439-442`) ; les tests Python vérifient qu'ils ne sont plus émis (`test_control_protocol_r2.py:96`, `:149`, `:348`) | Le cas a été retiré, pas laissé inatteignable |
| Journal `allowed=true` avec raison pour commande inconnue | **hypothèse non vérifiée** | `control-authz.ts:~463-468` : si `catalogueReady` est faux, un `run` d'identifiant inconnu est `allowed: true` | Le répartiteur doit refuser ensuite ; non vérifié. Risque faible, à confirmer par test |
| Serveur WebSocket backend sur loopback | **choix volontaire** | `backend/manager.ts:125` (`ws://127.0.0.1`) | Distinct du contrôle (pipe) ; protégé par jeton |
| Duplication de la liste de commandes entre `control-authz.ts` et le bridge Python | dette acceptable | `BACKEND_COMMANDS` `:70` ; `CONTROL_ENV_NAMES` `util.py:31` | Deux listes à garder alignées ; les tests les couvrent |
| Deux implémentations de la règle de masquage (ancienne note R3.4) | **obsolète** | commit `f367b63` « one masking rule » | Corrigé |
| Avertissements lint (543) | dette acceptable | `npm run lint` | Non bloquant |
| Chemin d'installation de Hermes en `curl \| bash` | défaut réel | R5 | Voir §4 |

Pas de fonction dupliquée entre shell, noyau et bridge n'a été recherchée systématiquement dans cet audit (hors listes de commandes ci-dessus) : non vérifié.

## 8. Résultats des commandes

Toutes exécutées à la racine ou au répertoire indiqué, sur le HEAD, sans données personnelles.

| Commande | Répertoire | Durée | Code | Résultat |
|---|---|---|---|---|
| `npm run typecheck` | `C:\Users\San\herald-os` | 9 s | 0 | tsc propre (shell) |
| `npm test` | racine | 12 s | 0 | **135 fichiers réussis, 883 tests réussis, 3 ignorés**, 0 échec |
| `npm run typecheck:core` | racine → `jarod-core` | 8 s | 0 | propre (cli, tests) |
| `npm run test:core` | racine → `jarod-core` | 160 s | 0 | agent 42 fichiers / 262 tests ; automation 5 / 28 ; workflows 3 / 29 ; gateways 13 / 81 ; bridge 35 / 425 (1 ignoré) ; cli 42 / 456 (1 attendu en échec) ; tests 26 / 226. **0 échec.** |
| `npm run lint` | racine | 2 s | 0 | 0 erreur, **543 avertissements**, 9 infos |
| `python -m pytest -q` (bridge) | `plugins/herald-os-bridge/tests` | 7 s | 1 | **1 échec** : `test_permissions.py:95`. Cause : `pyyaml` absent de mon premier venv (`bridge/permissions.py:177` importe `yaml` ; à défaut la politique retombe sur les défauts). **Non reproduit** avec la commande du projet. |
| `uv run --no-project --python 3.11 --with pytest --with pyyaml python -m pytest -q` (bridge) | `plugins/herald-os-bridge/tests` | 7 s | 0 | **218 réussis, 14 ignorés, 0 échec** (commande de repli de `scripts/test-bridge.ps1`) |

Environnement : `uv` éphémère, aucun paquet installé dans le dépôt ni dans le Python global. Un venv de test a été créé dans le dossier de travail temporaire de la session (hors dépôt).

## 9. Non vérifié

| Élément | Raison | Procédure pour le faire |
|---|---|---|
| `scripts/verify-windows.ps1` | Démarre `hermes serve` depuis le runtime Hermes de l'utilisateur et **écrit une entrée dans son `audit.jsonl` réel** (`%LOCALAPPDATA%\hermes\herald-os\audit.jsonl`). Interdit par le périmètre (profil réel). | Lancer dans un profil jetable : `HERMES_HOME=<dossier temporaire>` puis `powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1` |
| `jarod-core/scripts/verify-jarod-os.ps1` | Profil jetable et faux LM Studio : compatible avec le périmètre, mais non lancé ici (durée, hors objectif initial). | `powershell -ExecutionPolicy Bypass -File jarod-core\scripts\verify-jarod-os.ps1 -TimeoutSeconds 120` depuis la racine |
| Named pipe de bout en bout (invariant 9) | Exige l'application Electron lancée | Démarrer l'application en mode dev sur profil jetable, puis appeler la commande de contrôle depuis `herald-os` |
| Électron e2e (`*.e2e.test.ts`) | Exige une fenêtre et des boîtes natives | Procédure décrite dans `jarod-core/DECISIONS.md` (JAROD_SMOKE) |
| R4 : écriture hors dossier par `run_shell` | Exécution dangereuse ; non reproduite | Procédure seulement (`writeScope` sous Windows, commande d'écriture dans un dossier jetable), à exécuter uniquement en profil isolé |
| R5 : exécution du script d'installation distant | Réseau et code distant ; non exécuté | Procédure seulement : `bash -c "curl -fsSL <URL> \| bash"` non lancé |
| R6 : vérification de signature | Pas de `cosign.pub` ni d'image publiée | Générer une paire sur un dépôt de test, signer une image jetable, vérifier avec `cosign verify --key` |
| Modèles réels (llama, cloud) | Non disponibles et non lancés | — |

## 10. Hypothèses

1. Les « R2 à R9 » sont les numéros des notes d'audit fournies à l'auditeur ; le dépôt ne les définit pas. R9 n'a pas pu être identifié.
2. `AUDIT-JAROD-OS.md` (cité par le brief) n'existe pas dans le dépôt. Les risques ont été pris dans le brief et dans `ANALYSE-2026-10-12.md`, `ANALYSE-2026-10-13.md`, `HANDOFF.md` et `jarod-core/DECISIONS.md`.
3. « Ne tue aucun processus que tu n'as pas créé » : aucun processus n'a été terminé.
4. Le venv de test a été créé hors dépôt pour un essai ; l'exécution finale a utilisé `uv` éphémère, conformément au script du projet.
5. Le travail de la phase de sécurité des commandes est supposé complet là où les tests passent ; pas de revue de code ligne à ligne de l'ensemble du noyau et du shell.
6. Les fichiers non suivis (`JAROD-CAPABILITY-AUDIT.md`, `audit jarod15-10.txt`, `prompt/`) sont considérés comme préexistants et n'ont pas été lus pour le contenu, sauf le brief `prompt/audit_jarod-os_1610.txt`.

## 11. Préparation migration Rust / Cordis

### Contrats à figer avant tout portage

- **Protocole de contrôle** (JSON-lines sur pipe) : `ControlRequestShape` (`control-authz.ts:80`), `ControlDecision` (`:102`), `ControlAuditEntry` (`:126`), nom du pipe `pipe://<nom>`.
- **Modèle de jetons** : deux jetons par lancement, `backend` et `cli`, matrice d'autorisation (`control-authz.ts:39-70`).
- **Format du journal** `audit.jsonl` (sans jeton, `control-authz.test.ts:131`).
- **Politique de permissions** : `permissions.yaml` (`bridge/permissions.py:127`), niveaux `read`/`act`/`mutate`/`destructive`, `NEVER_ALWAYS` (`plugins/agent/src/never-always.ts`).
- **Environnement enfant** : `CONTROL_ENV_NAMES` (`util.py:31`) comme contrat de sécurité.
- **Manifeste de plugin** : `plugins/herald-os-bridge/plugin.yaml`.
- **Schéma des outils** `executeGuardedTool` : non lu dans cet audit (à figer, non vérifié).
- **Mise à jour d'image** : clé publique cosign (`linux/image/cosign.pub`, absente) et politique (`packages.sh:100-111`).

### Seams stables et protégés par des tests

- `adjudicate` / `ControlSecurity` (`control-authz.ts:423`, `:535`) : pur, à injection du journal. Très bien couvert (`control-authz.test.ts`).
- `pipe-security.ts` : DACL et refus de servir sans lecture de la politique.
- `child_env` / `take_control_env` (`util.py`).
- `shell-guard.ts` : `mechanism()` fail-closed sous Windows.

### Parties prêtes pour le host Rust

| Partie | Prêt ? | Raison |
|---|---|---|
| Autorisation des commandes | oui, avec réserve | Logique pure, testée. La couche transport reste en TypeScript. |
| Named pipe et DACL | oui | Logique et tests existants. |
| Environnement enfant | oui | Test de sécurité explicite. |
| Journal | oui | Format figé dans les tests. |
| Coffre à secrets, approbations, superviseur, updater, volume D:, sandbox | **non** | Le coffre et l'updater ne sont pas dans le périmètre lu ; le sandbox est R4 (ouvert). |

### Risques qui bloqueraient le portage de l'UI

1. R4 : sans confinement d'écriture, le host Rust n'a rien à reprendre sur la sécurité des écritures ; la phase sandbox ne peut pas être terminée.
2. Double runtime : le bridge Python tourne dans le même processus que le gateway Hermes (`bridge/util.py:24-27`), ce qui limite la séparation des secrets.
3. `tcp://` résiduel côté Python (invariant 2).

### Ordre de migration recommandé

| Phase | Contenu | Critère de sortie mesurable |
|---|---|---|
| **0a (avant tout)** | Corriger R5 (somme et version figées pour l'installeur Hermes) et R6 (clé cosign publiée, politique active, vérification à la mise à jour) ; retirer le chemin `tcp://` de `ui.py` | R5 : `grep "curl.*| *bash"` ne trouve plus rien dans `linux/bin/herald-os` ; R6 : `cosign verify` réussit sur l'image de test et échoue sur une image non signée |
| **0b** | Figer les contrats ci-dessus (fichiers de schéma JSON, tests de contrat) | Les tests de contrat passent sur TypeScript et sur le futur host |
| **0c (spike)** | Prototype Rust du transport pipe et de l'autorisation, sans UI | Les tests de `control-authz` passent contre le binaire Rust |
| **1** | Stockage et coffre dans le host Rust | Aucun secret en clair dans le journal ni le profil (tests) |
| **2** | Approbations et superviseur | Tests `approvals-failclosed` passent contre le host |
| **3** | Sandbox et R4 | Une écriture hors dossier est refusée en test sur **au moins deux** versions de Windows |
| **4** | Updater et volume D: | Mise à jour signée vérifiée, retour arrière testé |
| **5** | UI | Parité des tests e2e existants |

**Réponse à la question du brief** : la phase 0 peut démarrer, mais **0a doit être fait avant** (R5 et R6 sont des corrections S). R4 peut rester ouvert pour les phases 0b et 0c, à condition d'être marqué bloquant pour la phase 3.

## 12. Annexe JSON

```json
{
  "audit": { "date": "2026-10-16", "branch": "feature/windows-port", "head": "30b17fbf9d26001c2a72e7efb1d3bd580ab097da", "dirty": true },
  "r1Invariants": [
    { "id": 1, "verdict": "pass", "evidence": "plugins/herald-os-bridge/bridge/util.py:31" },
    { "id": 2, "verdict": "pass", "evidence": "apps/desktop/electron/shell/os-control.ts:150" },
    { "id": 3, "verdict": "pass", "evidence": "apps/desktop/electron/shell/control-authz.ts:445" },
    { "id": 4, "verdict": "pass", "evidence": "apps/desktop/electron/shell/control-authz.ts:439" },
    { "id": 5, "verdict": "pass", "evidence": "apps/desktop/electron/shell/control-authz.ts:450" },
    { "id": 6, "verdict": "pass", "evidence": "apps/desktop/electron/shell/os-control.ts:323" },
    { "id": 7, "verdict": "pass", "evidence": "apps/desktop/electron/shell/control-authz.test.ts:131" },
    { "id": 8, "verdict": "pass", "evidence": "apps/desktop/electron/shell/os-control.ts:283" },
    { "id": 9, "verdict": "unverifiable", "evidence": "apps/desktop/electron/shell/os-control.ts:180" },
    { "id": 10, "verdict": "pass", "evidence": "plugins/herald-os-bridge/bridge/util.py:82" }
  ],
  "risks": [
    { "id": "R2", "status": "partial", "evidence": "jarod-core/packages/plugins/permissions/src/shell-guard.ts:16", "effort": "S" },
    { "id": "R3", "status": "partial", "evidence": "plugins/herald-os-bridge/tests/test_control_security.py:117", "effort": "M" },
    { "id": "R4", "status": "open", "evidence": "jarod-core/packages/plugins/permissions/src/shell-guard.ts:16", "effort": "XL" },
    { "id": "R5", "status": "partial", "evidence": "linux/bin/herald-os (install_hermes, HERMES_INSTALLER_SHA256)", "effort": "S" },
    { "id": "R6", "status": "partial", "evidence": ".github/workflows/image.yml (step 'The signing key and its public half agree')", "effort": "S" },
    { "id": "R9", "status": "obsolete", "evidence": "none", "effort": "S" }
  ],
  "capabilities": [
    { "id": "CAP-01", "domain": "securite", "name": "autorisation des commandes de controle", "status": "verified", "priority": "critical" },
    { "id": "CAP-02", "domain": "securite", "name": "environnement enfant filtre", "status": "verified", "priority": "critical" },
    { "id": "CAP-03", "domain": "securite", "name": "confinement des ecritures run_shell (Windows)", "status": "absent", "priority": "critical" },
    { "id": "CAP-04", "domain": "securite", "name": "approbations et accord par conversation", "status": "partial", "priority": "high" },
    { "id": "CAP-05", "domain": "systeme", "name": "bridge outils Windows", "status": "partial", "priority": "high" },
    { "id": "CAP-06", "domain": "orchestration", "name": "agent, sous-agents, planificateur, workflows", "status": "partial", "priority": "high" },
    { "id": "CAP-07", "domain": "modeles", "name": "fournisseurs locaux et cloud", "status": "partial", "priority": "high" },
    { "id": "CAP-08", "domain": "memoire", "name": "recherche et indexation RAG", "status": "partial", "priority": "medium" },
    { "id": "CAP-09", "domain": "exploitation", "name": "mise a jour d image signee", "status": "absent", "priority": "critical" },
    { "id": "CAP-10", "domain": "installation", "name": "installation de Hermes epinglee", "status": "fragile", "priority": "high" },
    { "id": "CAP-11", "domain": "qualite", "name": "suites shell, noyau, bridge vertes", "status": "verified", "priority": "medium" }
  ],
  "migrationReadiness": {
    "contractsToFreeze": [
      "ControlRequestShape (control-authz.ts:80)",
      "ControlDecision (control-authz.ts:102)",
      "ControlAuditEntry (control-authz.ts:126)",
      "pipe://<nom> endpoint (os-control.ts:180)",
      "CONTROL_ENV_NAMES (util.py:31)",
      "permissions.yaml tiers (permissions.py:127)",
      "NEVER_ALWAYS (plugins/agent/src/never-always.ts)",
      "plugin.yaml manifest",
      "cosign public key and policy (linux/image/packages.sh:100)"
    ],
    "stableSeams": [
      "adjudicate and ControlSecurity (control-authz.ts:423, :535)",
      "pipe-security.ts DACL",
      "child_env and take_control_env (util.py:48, :82)",
      "shell-guard mechanism fail-closed (shell-guard.ts)"
    ],
    "blockingRisks": [
      "R4 run_shell write confinement absent on Windows",
      "R5 unpinned curl pipe bash installer (linux/bin/herald-os:1332)",
      "R6 image signature verification inactive (cosign.pub missing)",
      "bridge runs in the same process as the Hermes gateway (util.py:24-27)"
    ],
    "recommendedOrder": [
      "0a: pin the Hermes installer hash, commit linux/image/cosign.pub (tcp:// path already removed)",
      "0b: freeze contracts with contract tests",
      "0c: Rust spike of pipe transport and authorization",
      "1: storage and vault in Rust host",
      "2: approvals and supervisor",
      "3: sandbox and R4, tested on two Windows versions",
      "4: updater and D: volume with signature check and rollback",
      "5: UI parity"
    ]
  }
}
```

## Rapport git après audit

Le rapport a été ajouté à la racine. Aucun fichier source modifié, aucun commit, aucun push.
