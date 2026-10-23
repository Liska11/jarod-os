# JAROD-OS vNext — audit de couverture, diff Herald, gap analysis (2026-10-23)

Branche `feature/windows-port`, arbre de travail du 2026-10-23 (non commité : voir `git status`). Méthode : lecture du code, des docs, des tests et de l'historique git ; `gh api` sur Herald-OS upstream et sur les 5 projets d'inspiration. **Aucun test n'a été relancé pour ce rapport** : les résultats de tests cités viennent des rapports du dépôt (`docs/audit/REMEDIATION-2026-10-22.md` §11.2), ils sont marqués comme tels.

Conventions :
- **FAIT** = observé dans le code, un test, un doc ou l'API GitHub, avec la preuve ;
- **INF.** = inférence ;
- **RECO** = recommandation ;
- **À VÉRIFIER** = hypothèse non prouvée.

Statuts autorisés : PRÉSENT ET FONCTIONNEL · PRÉSENT MAIS PARTIEL · PRÉSENT MAIS NON BRANCHÉ · PRÉSENT MAIS DIVERGENT DE HERALD · ABSENT · À VÉRIFIER PAR TEST.

---

## 0. Ce qu'il faut retenir d'abord

1. **FAIT.** 17 des 22 projets externes de la liste ont déjà été évalués, épinglés et, pour la plupart, intégrés : c'est la « vague G » (`docs/INTEGRATIONS-PLUS3.md`, G1 à G17). Syft, OpenTelemetry JS, AgentDojo, restic, yt-dlp, llama-swap, Windows-MCP, Reladraw, MCP Inspector, smolvm, UI-TARS, Coucou, osquery, GhidraMCP, Sandboxie, OpenCodeReview et Cua ont chacun une ligne avec version, licence, empreinte, tests et retour arrière. **Les refaire serait un doublon.**
2. **FAIT.** Seuls 5 projets sont réellement nouveaux : CoWork-OS, Wandesk, OpenMausBot, Rakazo et OpenMuse. Aucune occurrence dans le dépôt (grep hors `upstream/`).
3. **FAIT.** Herald-OS upstream a avancé d'environ 400 commits depuis le fork (`00138ed`, 2026-10-07 ; dernier push upstream le 2026-10-20). Rien n'a été repris : Herald Office (Docs, Sheets, Slides), Canvas, Calc, desktop pet, Pet Room, i18n, gel avant une demande d'accord (#172), magasins d'identifiants dans Files (#147), écriture atomique de la mémoire (#140).
4. **FAIT.** Plusieurs briques « structurantes » existent mais **ne sont pas branchées** :
   - `plugin-platform` : signature, rollback, quarantaine des plugins ;
   - `plugin-sandbox`, `plugin-quarantine` et `plugin-hyperv` : aucun import par le bridge ;
   - crates Rust `host-control`, `host-updater`, `host-vault`, `host-supervisor` et `host-storage` : aucun appelant TS. Seul `host-sandbox` est branché, par `JAROD_SANDBOX_BIN`.
   Le chantier principal est donc de **brancher et finir**, pas d'ajouter.
5. **FAIT.** Il reste deux trous de sécurité réels :
   - le journal d'audit ne trace pas les outils non dangereux (`agent.ts:1440`, `if (decision) audit(...)`) ;
   - l'observateur d'injections détecte 0 charge utile sur 70 (G3-F1, `INTEGRATIONS-PLUS3.md`, Constats §2).

---

## ÉTAPE 1 — Inventaire réel de JAROD-OS

### 1.1 Structure (FAIT)

| Couche | Où | Contenu vérifié |
|---|---|---|
| Shell Electron (main) | `apps/desktop/electron/` | backend manager, IPC typé, `engines/` (DSH en ACP), `plugins/host.ts` (widgets ADR-019), `restic-backup.ts`, `external-backup.ts`, `backups.ts`, `recovery.ts`, `sandboxes.ts`, `remote-machines.ts`, `updates-check` (Windows Update et winget), `tray.ts`, `problem-log.ts`, `rotating-log.ts`, `agent-browser/` |
| Renderer React | `apps/desktop/src/features/` | 26 surfaces : applications, auth, automations, capture, chat, connections, files, hermes, kanban, memory, missions, overview, pinokio, player, plugins, settings (≈50 sections), setup, sites, status, studio, system, terminal, voice, web… |
| Noyau TS (Cordis) | `jarod-core/packages/` | `kernel`, `bridge` (42 handlers), `cli`, `contracts`, 24 plugins (agent, automation, embeddings, gateways, hyperv, integrations, kanban, llm, mcp, memory, permissions, persona, platform, quarantine, rag, sandbox, scheduler, skills, storage, tools, updates, vision, voice, workflows) |
| Hôte Rust | `host-rust/crates/` | `host-control` (spike 0c, 70 tests), `host-sandbox` (AppContainer + ACL), `host-storage`, `host-supervisor`, `host-updater` (A/B, signature), `host-vault` (DPAPI) |
| Contrats | `contracts/v1/` | schémas, fixtures, matrice d'autorisation C2 « golden » |
| Pont Hermes (hérité) | `plugins/herald-os-bridge/` | plugin Python, 13 outils, `audit.jsonl`, paliers read/act/mutate/destructive |
| Moteurs épinglés | `engines/`, `jarod-core/engines.lock/` | flaui, browser-harness, docling, llama, restic, syft, yt-dlp, osquery, smolvm, windows-mcp, agentdojo, opencodereview… |

### 1.2 Outils de l'agent (FAIT, `grep name:` dans `plugins/*/src`, environ 115 noms)

Ils se répartissent ainsi :
- **fichiers et shell** : `read_file`, `write_file`, `edit_file`, `list_dir`, `find_files`, `search_files`, `run_shell` ;
- **système Windows**, en TS, portés depuis Herald : `system_info`, `system_processes`, `system_disk_usage`, `system_find_files`, `system_apps`, `system_open`, `system_kill_process`, `system_quit_app`, `system_files`, `system_files_plan`, `system_network`, `system_control`, `system_logs`, `system_state` et `system_diagnostics` (osquery) ;
- **bureau et navigateur** : `desktop_control`, `desktop_windows`, `browser_*` (11), `connected_browser` ;
- **mémoire et RAG** : `memory_save`, `memory_search`, `user_profile`, `annotate_line`, `annotations_list`, `rag_index`, `rag_search`, `vault_list`, `session_search`, `session_read`, `output_search`, `output_read` ;
- **planification** : `automation_*`, `cronjob`, `cronjob_list` ;
- **délégation** : `delegate_task`, `spawn_subagent`, `subagent_list`, `subagent_result`, `subagent_cancel` ;
- **cockpit** : `capabilities`, `task_status`, `permissions_explain`, `tool_search` ;
- **bacs et machines virtuelles** : `sandbox_run`, `sandbox_changes`, `sandbox_discard`, `linux_prepare`, `linux_run`, `linux_reset` ;
- **analyse** : `rea_static`, `ghidra_analyze`, `code_review_plan`, `code_diagnostics`, `code_navigate` ;
- **médias et artefacts** : `media_fetch`, `video_render`, `diagram_export`, `artifact_register`, `artifact_list`, `docling`, `pdfium` ;
- **modèles locaux** : `local_model_server` ;
- **Pinokio** : `pinokio_*` (7) ;
- **Android** : `android_devices`, `android_shell` ;
- **skills** : `skill_hub_install`, `skill_hub_search`, `skill_manage`, `load_skill`, `read_skill_file` ;
- **réseau** : `web_fetch`, `web_search`, `http_request` ;
- **affinage** : `refine`, `refine_history`, `refine_rollback`.

### 1.3 Tests (FAIT, d'après `REMEDIATION-2026-10-22.md` §11.2, non relancés ici)

| Suite | Résultat rapporté |
|---|---|
| Noyau (T4) | 346 fichiers, 3 111 tests, verts ; 18 ignorés (moteur ou modèle absent) |
| Shell vitest (T3) | 174 fichiers, 1 382 tests |
| e2e Electron (T7) | 82 ; 7 ignorés (restic empaqueté ×6, latence vocale) |
| Rust `cargo test` | **non exécuté** lors de la dernière passe |
| Pont Python complet, mobile, paquet Windows, CI GitHub | **non exécutés** |

---

## ÉTAPE 2 — Diff avec Herald-OS

### 2.1 Point de fork (FAIT)

| Élément | Valeur | Preuve |
|---|---|---|
| Fork | `00138ed` du 2026-10-07, « README: the Discord community » ; 62 commits Herald | `WINDOWS-PORT-NOTES.md` l.3, `git rev-list --count 00138ed` |
| Depuis | 397 commits Jarod ; de 583 à 2 397 fichiers suivis | `git rev-list 00138ed..HEAD` |
| Dossiers ajoutés | `jarod-core/`, `host-rust/`, `contracts/`, `mobile/`, `autonomy/`, `pinokio-runtime/`, docs `COCKPIT-*`, `INTEGRATIONS*`, `audit/` | `comm` sur `git ls-tree` |
| Dossiers supprimés | aucun | idem |
| Upstream depuis le fork | environ 400 commits (≥ 4 pages de 100 via `gh api`) ; alphas 3, 4 et 5 | `gh api repos/iamlukethedev/Herald-OS/commits?since=2026-10-07` |

### 2.2 Hérité, divergent, remplacé

| Capacité Herald (base `00138ed`) | Dans JAROD | Statut | Preuve |
|---|---|---|---|
| Backend = Hermes Agent (`hermes serve`) | Backend par défaut = noyau Jarod (`jarod-core`) ; Hermes reste optionnel (échelle `resolve.ts`) | DIVERGENT | `docs/ARCHITECTURE.md` « Three authorities » ; `electron/backend/resolve.ts` |
| Pont système Python (13 outils, 4 paliers, `audit.jsonl`) | Gardé pour le backend Hermes ; outils **re-portés en TS** dans `plugins/tools/src/system` (option B de `jarod-herald-reuse.md`) | DIVERGENT, deux implémentations | `plugins/herald-os-bridge/`, `jarod-core/packages/plugins/tools/src/system` |
| Paliers read/act/mutate/destructive | Remplacés par `dangerous`, des règles allow/ask/deny avec cible et échéance, l'autonomie bornée, `NEVER_ALWAYS` et le mode Plan | DIVERGENT | `plugins/permissions/src/guard.ts` (en-tête), `docs/COCKPIT-LOT2.md` |
| Chemins protégés (liste) | Confinement au dossier de travail ; magasins d'identifiants protégés (R-…) ; garde du shell | DIVERGENT | `jarod-herald-reuse.md` §3 ; `ipc/path-guard.ts` |
| Contrôle `os_ui` (socket Unix) | TCP loopback avec jeton sous Windows ; tube nommé avec DACL dans le spike Rust | DIVERGENT | `WINDOWS-PORT-NOTES.md` (« Control channel ») ; `host-rust/README.md` |
| Plugins widgets (ADR-019, `jarod-plugin://`, CSP) | Conservés | HÉRITÉ, FONCTIONNEL | `electron/plugins/host.ts` (en-tête) |
| Studio (« builds software while you watch ») | Conservé | HÉRITÉ, À VÉRIFIER PAR TEST sur le backend Jarod | `src/features/studio/StudioWindow.tsx` |
| Overview, panneau Today | Conservé | HÉRITÉ | `features/overview/TodayPanel.tsx` |
| Automations, Memory, Connections (via REST Hermes) | Rebranchés sur la passerelle Jarod (`/api/cron/*`, `/api/memory/files`, `/api/mcp/*`) | DIVERGENT, FONCTIONNEL | `jarod-core/PARITY.md` lignes 3 à 5 |
| Linux image, Arch | Hors périmètre (règle utilisateur) | IGNORÉ | mémoire `windows-only-linux-out-of-scope` |
| **Upstream après le fork** : Herald Office (Docs, Sheets, Slides, outils `docs.*`, `sheets.*`, `slides.*`, skills `herald-docs`…) | **Absent** | ABSENT | `gh api` commits du 2026-10-09 ; aucun « herald office » dans `apps/` |
| Upstream : Herald Calc (moteur exact math.js, outil `calc` de palier read) | Absent | ABSENT | commits du 2026-10-16 (`36c1866`, `8d90177`) |
| Upstream : desktop pet et Pet Room (journal d'activité, observer hooks pour un Hermes hors Herald) | Absent ; Jarod a la mini-fenêtre Coucou (G12) en lecture seule | ABSENT (équivalent partiel) | `1ea657b`, `352f7cf` ; `INTEGRATIONS-PLUS3.md` G12 |
| Upstream : correctif du gel avant une demande d'accord (#172) | À VÉRIFIER : Jarod n'utilise plus le même chemin d'accord quand le backend est le noyau | À VÉRIFIER PAR TEST | `d1ca5d2` |
| Upstream : Files hors des magasins d'identifiants (#147) | Équivalent présent (`path-guard.ts`, `credential-stores` testé) | PRÉSENT (fait indépendamment) | `REMEDIATION` §11.2 (`credential-stores`) |
| Upstream : mémoire relue avant écriture et atomique (#140) | `atomic-write.ts` existe dans le shell ; pour `MEMORY.md` côté noyau : À VÉRIFIER | À VÉRIFIER PAR TEST | `electron/atomic-write.ts` |
| Upstream : i18n (catalogues, pt-BR, zh-CN) | Jarod a `src/locales/en.ts` et `fr.ts` et `useT` ; c'est son propre système | DIVERGENT | `src/lib/i18n.ts` |
| Upstream : changement de fournisseur de modèle et de fournisseur mémoire Hermes | Jarod a son propre écran Providers et le coffre | DIVERGENT | `PARITY.md` l.7 |

**INF.** L'upstream suit désormais une direction « suite bureautique et Linux image », éloignée du cockpit Windows. Les seuls apports qui valent un cherry-pick ciblé sont :
- Office (comme « workbench » de résultats) ;
- Calc (un outil `read` déterministe) ;
- les correctifs d'accord et de mémoire.

---

## ÉTAPE 3 — Gap analysis (après les étapes 1 et 2)

### Sortie 1 — Matrice de couverture fonctionnelle (25 axes)

| # | Capacité | Herald upstream | JAROD actuel | Statut JAROD | Preuve | Commentaire | Action |
|---|---|---|---|---|---|---|---|
| 1 | Permissions par tiers | 4 paliers + `permissions.yaml` | règles allow/ask/deny par **outil + cible + échéance**, autonomie bornée (usages, conversation), `NEVER_ALWAYS`, mode Plan, confirmation native d'un affaiblissement | DIVERGENT DE HERALD, FONCTIONNEL | `permissions/src/guard.ts` ; `COCKPIT-LOT2.md` ; e2e `permission-rules` | plus fin que Herald ; il n'y a pas de palier « act » (journalisé sans accord) | garder ; ajouter des **préréglages** de profil (cf. CoWork) |
| 2 | Cartes d'accord | carte Hermes `approval` | cartes d'accord du chat, `clarify`, `sudo`, `secret` ; accords téléphone (`gateways/phone-approvals.ts`) ; accords DSH en ACP | FONCTIONNEL | `ARCHITECTURE.md` (« Server-to-client requests ») ; e2e `engines.spec.ts:200` | — | garder |
| 3 | Journal d'audit | `audit.jsonl` (tout appel) | SQLite `events` stream `audit`, **outils sensibles ou refusés seulement** ; journal C3 Rust à part ; `mcp-server.log` à part ; `audit.jsonl` du pont Python | PARTIEL | `agent/src/runtime.ts:146` ; `agent.ts:1440` | 4 journaux, pas de lecture auditée générale | **corriger** : journal unique, tous les appels |
| 4 | Bridge et outils système | Python, 13 outils | port TS de 15 outils `system_*` + osquery + FlaUI + `desktop_*` | FONCTIONNEL | `tools/src/system` ; `INTEGRATIONS-PLUS3` G13 | doublon Python/TS assumé (backend Hermes) | garder ; geler le Python |
| 5 | Intégration Hermes | backend unique | backend optionnel ; client du contrat généré ; `hermes-import` (skills et MCP, désactivés) ; surveillance d'upstream (`upstream.json`, `dernierShaVu: null` pour hermes-agent) | PARTIEL | `cli/src/hermes-import.ts` ; `jarod-core/upstream.json` | aucune mémoire, persona ni cron importés ; surveillance hermes-agent jamais exécutée | **finir** l'import ; lancer la veille |
| 6 | Intégration DSH NEXT | — | moteur DSH piloté **en ACP** (démarrage, session, tour, annulation, accords) ; choix du moteur du cockpit | FONCTIONNEL (e2e) | `electron/engines/dsh.ts`, `acp-client.ts` ; e2e `engines.spec.ts:143-220` | ELECTRON_RUN_AS_NODE (−93 Mo) proposé, non fait | garder ; mesurer A7 |
| 7 | Routage et repli de modèles | Hermes | `RoutingService` (disjoncteur 3 échecs / 60 s, stratégies order/fastest/cheapest) injecté dans l'agent ; 15 fournisseurs ; LM Studio, llama-server, Ollama ; llama-swap en fournisseur « Personnalisé » | FONCTIONNEL | `llm/src/routing.ts` ; `llm/src/index.ts:53` ; `PARITY.md` l.14 (« repli de modèles ») | pas de routage par **tâche** (vision, code, long contexte) | **adapter** : politique par capacité |
| 8 | Mémoire locale et partagée | `MEMORY.md` Hermes | mémoire SQLite FTS + curator + profil utilisateur + annotations + portabilité ; RAG (turbovec, vault) ; **exposée en lecture** à d'autres agents par `jarod mcp` | FONCTIONNEL ; partage PARTIEL | `memory/src/*` ; `cli/src/mcp-server.ts` | pas de versionnage ni de diff de la mémoire | **adapter** : historique de mémoire (cf. CoWork, git) |
| 9 | Routines et scheduler | cron Hermes | scheduler (interval, daily, cron, once, sortie vers les messageries), webhooks, automatisations (déclencheurs et actions), workflows isolés, kanban « Run next » | FONCTIONNEL | `scheduler/src/scheduler.ts` ; `PARITY.md` l.4, 15, 17 | pas de reprise d'une tâche **en cours** après un plantage (À VÉRIFIER) | **vérifier**, puis baux durables |
| 10 | Cockpit desktop | bureau, dock, Overview | idem + Réglages › Capacités, Tâches, Moteurs, Usage ; mini-fenêtre (G12) ; tray | FONCTIONNEL | `features/settings/sections/*` ; `tray.ts` | pas d'écran « Plateforme plugins », « Quarantaine » ni « Hyper-V » | **exposer** |
| 11 | Architecture plugins | widgets ADR-019 | widgets + plugins utilisateur **isolés par processus** (`node --permission`) + skills (hub, analyse, verrou de provenance) + MCP client ; `plugin-platform` (signature, dépendances, rollback, quarantaine) | PARTIEL / NON BRANCHÉ | `workflows/src/plugins.ts` ; `platform/src/platform.ts` ; BACKLOG « Connect PluginPlatform… » | la plateforme signée n'a ni appelant ni écran | **brancher** |
| 12 | Registre des capacités | — | `CapabilityService` (list, search, describe, check), outil `capabilities`, catalogues F1-F10 + plus3, sondes réelles, écran Capacités | FONCTIONNEL | `integrations/src/cockpit/*` ; `COCKPIT-LOT1.md` | les capacités du shell (IPC) et du Rust n'y sont pas | **finir** : une seule source |
| 13 | MCP entrant | — | `jarod mcp` : stdio, **lecture seule**, 5 outils (mémoire, sessions), audit sans contenu, 4 versions du protocole | FONCTIONNEL (volontairement restreint) | `cli/src/mcp-server.ts` (gardes G1 à G3) | pas d'outils d'action exposés, et c'est voulu | garder ; étendre derrière la porte unique seulement |
| 14 | MCP sortant | Connections (Hermes) | client MCP (stdio et HTTP), Réglages › Serveurs MCP (liste, test, activer), outils MCP `dangerous: true`, env enfant filtré (`child-env`) ; Inspector (G9) ; Windows-MCP en optionnel | FONCTIONNEL | `plugins/mcp/src/mcp.ts` ; `REMEDIATION` §11.5 ; `PARITY.md` l.5 | pas de filtre outil par outil à l'import (prévu pour Windows-MCP) | **finir** : liste blanche par outil |
| 15 | Multi-agent et délégation | Hermes delegate | `delegate_task`, `spawn_subagent` (outils dangereux exclus), profils = agents, DSH à côté | FONCTIONNEL | `agent/src/subagents.ts` ; `agent.ts:1083` | pas de « bots » persistants à identité propre | **adapter** (OpenMausBot/Rakazo), basse priorité |
| 16 | Apps locales générées | Studio | Studio, Pinokio (installer, lancer, journaux), sites, artefacts (empreinte, état) | PARTIEL | `features/studio`, `tools/src/pinokio`, `agent/src/artifacts.ts` | pas de runtime d'app isolé « une origine, une base par app » | **recréer** minimal (idée Wandesk) |
| 17 | Bac à sable | — | AppContainer (`host-sandbox`, `JAROD_SANDBOX_BIN`), Sandboxie (G15), smolvm (G10), Docker, copies de dossiers (`sandboxes.ts`) ; `plugin-sandbox` et `plugin-hyperv` non branchés | FONCTIONNEL pour 4 voies ; NON BRANCHÉ pour 2 | `shell-guard.ts:294` ; `INTEGRATIONS-PLUS3` G10, G15 | 6 mécanismes, sans sélecteur unique | **corriger** : une politique d'isolement choisit la voie |
| 18 | Observabilité | — | traces OTel locales en JSONL (**éteintes par défaut**), épurateur d'attributs, spans `conversation.turn`, `llm.request`, `tool.call` ; `problem-log`, `rotating-log`, crash ; Usage | PARTIEL | `otel/local-traces.ts:30` (`enabled: false`) ; `telemetry.ts` | pas de vue des traces dans l'UI, pas de métriques | **exposer** une timeline |
| 19 | Sauvegarde, restauration, rollback | — | sauvegarde vérifiée, restauration dans un profil neuf, sauvegarde externe, restic chiffré (`stageRestore`/`swapIn`), `refine_rollback`, application d'un bac vers la corbeille, rollback des plugins (non branché), `host-updater` A/B (non branché) | FONCTIONNEL / PARTIEL | `restic-backup.ts` ; `PARITY.md` l.19 ; `BACKUP-EXTERNE.md` | restic empaqueté non validé (6 e2e ignorés) ; M1 manuel non fait | **finir** la validation |
| 20 | Sécurité des plugins, skills et outils | — | skills : analyse et verrou ; plugins : processus isolé et permissions déclarées ; quarantaine de fichiers (non branchée) ; observateur d'injections (**0/70**) ; AgentDojo en banc ; garde réseau | PARTIEL | `quarantine/src/quarantine.ts` ; `observer.ts` ; `INTEGRATIONS-PLUS3` Constats §2 | détecteur inopérant ; DNS avant refus, `dgram` non gardé (`NETWORK-POLICY.md`) | **corriger** (priorité haute) |
| 21 | Inventaire système | `system_info` et compagnie | `system_*`, osquery (`system_diagnostics`), Syft (SBOM du paquet), `updates-check` (Windows Update, pilotes, winget) | FONCTIONNEL | `INTEGRATIONS-PLUS3` G1, G13 ; `docs/UPDATES.md` | — | garder |
| 22 | UX de travail visible (timeline, cartes de résultat) | chat + panneau d'artefacts | Tâches (étapes, statut, preuve), artefacts, `present`, sorties hors contexte | PARTIEL | `COCKPIT-LOT2.md` ; `agent/src/tasks.ts` | pas de timeline par tour dans le chat ; preuves absentes pour le shell et le réseau | **adapter** (CoWork) |
| 23 | Contrôle machine, navigateur, computer use | `os_ui` | FlaUI (D1), pywinauto (D2), navigateur isolé de l'agent, navigateur connecté, Windows-MCP optionnel ; UI-TARS et Cua différés | FONCTIONNEL (sémantique) ; vision ABSENTE | `INTEGRATIONS-PLUS3` G7, G11, G17 ; `REMEDIATION` §11.3 | FlaUI : passe sur bureau au repos non faite | **finir** le banc commun |
| 24 | Stockage, workspace, documents | Files | disque Jarod, dossier de travail, coffre DPAPI, docling, pdfium, RAG ; `host-storage` (baux, quotas) non branché | FONCTIONNEL / NON BRANCHÉ | `docs/JAROD-DISK.md` ; `host-rust/crates/host-storage` | pas d'édition de documents (Office) | **reprendre** Herald Office (option) |
| 25 | Mise à jour et gouvernance d'upgrade | releases GitHub | vérification Windows Update et winget (lecture seule) ; `plugin-updates` sans canal (⛔) ; `host-updater` A/B non branché ; veille d'upstream (`upstream.json`) | PARTIEL / NON BRANCHÉ | `PARITY.md` l.20 ; `docs/UPDATES.md` ; `host-updater/src/lib.rs` | aucune mise à jour de Jarod lui-même | **brancher** `host-updater` |

### Sortie 2 — « Ne pas refaire ce qui existe déjà »

| Fonctionnalité | Déjà dans JAROD ? | Où | Qualité actuelle | UI ? | Testé ? | Action |
|---|---|---|---|---|---|---|
| Registre de capacités | oui | `integrations/src/cockpit/` | bonne (sondes sans arg du modèle, délai de 8 s) | Réglages › Capacités | oui (`cockpit.test.ts`) | garder, étendre |
| Permissions par cible, temporaires, autonomes | oui | `permissions/src/guard.ts` | bonne, fail-closed | Règles | oui (unitaires et e2e) | garder |
| Tâches et preuves d'exécution | oui | `agent/src/tasks.ts` | partielle (pas de preuve shell ni réseau) | Réglages › Tâches | oui (`proofs-tasks`) | finir |
| MCP serveur (entrant) | oui | `cli/src/mcp-server.ts` | bonne, lecture seule | non (CLI) | oui (cli) | garder |
| MCP client et inspecteur | oui | `plugins/mcp`, G9 | bonne | Serveurs MCP | oui (24/24) | garder |
| Disjoncteur et repli de modèles | oui | `llm/src/routing.ts` | bonne | Agent & sécurité | oui | garder |
| Gestion des modèles locaux (llama.cpp, LM Studio, HF) | oui | `llm/src/local*.ts`, `engine*.ts` | bonne | Local models | oui | garder (ne pas ajouter llama-swap comme superviseur) |
| Traces OTel | oui | `integrations/src/otel` | correcte, éteinte | non | oui | exposer |
| SBOM (Syft) | oui | `impl/sbom.ts` | outil de dév. | non | oui | garder |
| Banc d'injections AgentDojo | oui | `agent/test/agentdojo.engine.test.ts` | banc OK, détecteur KO | non | oui | corriger le détecteur |
| Sauvegarde restic | oui | `restic-backup.ts` | bonne, empaqueté non validé | Stockage | partiel | finir la validation |
| yt-dlp | oui | `media_fetch` | bonne | non | oui | garder |
| osquery | oui | `system_diagnostics` | bonne | non | oui | garder |
| Sandboxie | oui | `sandbox_*` | bonne (installé par l'utilisateur) | non | oui | garder |
| smolvm | oui | `linux_*` | bonne | Environnement / VM | oui | garder |
| Reladraw | oui | `diagram_export` | bonne | Artefacts | oui | garder |
| OpenCodeReview | oui | `code_review_plan` | bonne | non | oui | garder |
| Coucou | oui (idée) | mini-fenêtre | lecture seule | oui | oui | garder |
| Windows-MCP | oui (optionnel) | serveur MCP | banc | via MCP | mesuré | garder optionnel |
| GhidraMCP | évalué, non intégré | — | — | — | sonde | garder `ghidra_analyze` headless ; ignorer GhidraMCP |
| UI-TARS, Cua | différés | — | — | — | sonde | banc commun avant toute décision |
| DSH via ACP | oui | `electron/engines` | bonne | Moteurs | e2e | garder |
| Import Hermes | partiel | `cli/src/hermes-import.ts` | skills et MCP seulement | ? (À VÉRIFIER) | oui | finir |
| Plateforme plugins signée | oui | `plugins/platform` | bonne en unitaire | **non** | unitaire | **brancher** |
| Quarantaine de fichiers | oui | `plugins/quarantine` | bonne en unitaire | **non** | unitaire | **brancher** (téléchargements, `media_fetch`, imports) |
| Hyper-V | oui | `plugins/hyperv` | non prouvé (droits admin) | non | unitaire | garder dormant |
| `plugin-sandbox` (bacs jetables) | oui | `plugins/sandbox` | doublon partiel de `sandboxes.ts` et `sandbox_*` | non | unitaire | **décider** : brancher ou supprimer le doublon |
| Updater A/B Rust | oui | `host-updater` | spike | non | cargo (non rejoué) | brancher en phase 3 |
| Coffre Rust | oui | `host-vault` | spike ; coffre TS en service | non | cargo | garder le spike |
| Outils système Python Herald | oui | `plugins/herald-os-bridge` | bonne (184 tests pytest au port) | via Hermes | oui | geler (backend Hermes seulement) |

### Sortie 3 — Gaps réels

| Fonctionnalité absente ou insuffisante | Valeur produit | Source d'inspiration | Intégrer ou recréer | Risque | Dépendances | Priorité |
|---|---|---|---|---|---|---|
| Journal d'audit unique couvrant **tous** les appels (lecture comprise), avec palier et résumé | sûreté, cockpit vérifiable | Herald `audit.jsonl` ; contrat C3 Rust | recréer (fusion des 4 journaux) | faible | `runtime.ts`, contrat C3 | **P0** |
| Détecteur d'injections opérationnel (au-delà de 0/70) | sécurité | AgentDojo (banc déjà là) | recréer le détecteur ; mesurer sur le banc | moyen (faux positifs) | `observer.ts`, G3 | **P0** |
| Garde réseau complète (DNS, `dgram`, processus enfants) | sécurité | — | recréer | moyen | `NETWORK-POLICY.md` | **P0** |
| Branchement de la plateforme plugins (signature, rollback) et UI | extensibilité sûre | interne | brancher l'existant | moyen | `plugin-platform`, `PluginHost` | **P1** |
| Quarantaine sur toute entrée externe | sécurité | interne | brancher l'existant | faible | `plugin-quarantine` | **P1** |
| Timeline visible par tour (lectures, commandes, diffs) + cartes de résultat | confiance, UX | CoWork-OS (timeline, Today) | adapter (TaskLedger + spans existants) | faible | tâches, OTel | **P1** |
| Préréglages de profil d'accès (Demander / M'approuver / Plein / Personnalisé) avec **limites dures** | UX des permissions | CoWork-OS (access profiles) | adapter (au-dessus des règles) | faible | `guard.ts` | **P1** |
| Mises à jour de Jarod (A/B, signature, essai, rollback) | gouvernance | interne (`host-updater`) | brancher | élevé | Rust packagé | **P2** |
| Reprise des tâches longues après plantage (baux) | fiabilité des routines | OpenMuse (SQL leases) | recréer | moyen | scheduler, TaskLedger | **P2** (À VÉRIFIER d'abord) |
| Historique et diff de la mémoire (rollback mémoire) | contrôle | CoWork-OS (mémoire en markdown sous git) | adapter (versions en SQLite, pas git) | faible | `memory` | **P2** |
| Import Hermes complet (persona, mémoire, cron, bots) en `--dry-run` | migration | CoWork-OS (`cowork import --from hermes`) | adapter (`hermes-import.ts`) | faible | — | **P2** |
| Passer une tâche à Hermes en ACP (comme DSH) | interop Hermes | CoWork-OS (ACP vers Hermes) | adapter (`acp-client.ts`) | moyen (Hermes ACP : À VÉRIFIER) | `electron/engines` | **P2** |
| Runtime d'apps générées isolées (une origine et une base par app, un seul point d'accès IA) | apps locales | Wandesk (workerd, `env.AI`) | recréer **minimal** (sans workerd au départ : `jarod-plugin://` + CSP + base par app) | élevé | widgets ADR-019 | **P3** |
| Workbench documents (éditer docs, feuilles, présentations à côté du chat) | travail fini | Herald Office (MIT, même lignée) / CoWork Workbench | intégrer depuis Herald (cherry-pick ciblé) | élevé (volume) | Univer, docx… | **P3** |
| Équipes de bots persistants (identité, modèle, mémoire, routine par bot) et paquets d'équipe | multi-agent | OpenMausBot (format `.md`), Rakazo | adapter sur les profils | moyen | persona, scheduler | **P3** |
| Computer use par vision | contrôle d'apps non accessibles | UI-TARS, Cua | intégrer **après** le banc commun | élevé (modèle lourd) | G7, G11, G17 | **P3** |
| Calcul exact (outil `calc` en lecture) | fiabilité numérique | Herald Calc | intégrer (moteur seulement) | faible | math.js | **P3** |
| Suivi de pages et objectifs (alertes de changement) | veille | OpenMuse | recréer (scheduler + `web_fetch`) | faible | Internet | **P4** |

### Sortie 4 — Matrice par projet externe

| Projet | Apporte | Déjà dans JAROD | Manque réellement | Intégration possible | Recréation préférable | Risques | Priorité |
|---|---|---|---|---|---|---|---|
| **CoWork-OS** (MIT, 496★, push le 2026-10-22) | timeline visible, 4 profils d'accès + limites dures, Workbench, Today, mémoire markdown sous git, import Hermes et OpenClaw, ACP vers Hermes, inbox | règles fines, tâches, Today (Herald), import Hermes partiel, ACP (DSH) | préréglages, timeline par tour, historique mémoire, import complet, ACP→Hermes | non (application complète, autre noyau) | **oui** : idées et UX | doublon d'agent | P1 (UX), P2 (import) |
| **Wandesk** (ISC, 70★, push le 2026-10-13) | apps générées en workerd, origine par app, base par app, `env.AI` unique | Studio, Pinokio, widgets isolés | runtime d'apps générées avec stockage par app | non (Node 22.5 SQLite, macOS d'abord) | **oui** (patron) | surface d'exécution de code généré | P3 |
| **OpenMausBot** (Apache-2.0 selon README ; licence À VÉRIFIER) | roster de bots, broker de permissions, paquets d'équipe `.md` (routines en pause, sans secrets), canaux | profils, sous-agents, messageries, accords | identité par bot, format d'équipe portable | non (pilote les CLI claude/codex/grok, cloud Boat) | **oui** (format d'équipe) | dépendances cloud | P3 |
| **Rakazo** (Apache-2.0, 5 244★) | bots persistants, ordinateurs d'équipe ou privés, délégation entre pairs, MCP distant et OpenAPI | sous-agents, bacs, MCP | délégation entre pairs persistants ; OpenAPI comme source d'outils | non (orienté serveur, Docker, E2B) | idée « OpenAPI → outils » | cloud par défaut | P4 |
| **OpenMuse** (MIT, 5 447★) | tâches durables (baux SQL), revue d'action enregistrée, profils navigateur persistants avec reprise en main, suivi de pages | navigateur de l'agent + handoff (`browser_handoff`), accords | baux et reprise ; suivi de pages | non (CopilotKit Intelligence **obligatoire**, donc cloud) | **oui** | dépendance cloud obligatoire : exclue | P2 (baux) |
| Syft | SBOM | **G1** intégré (outil de dév.) | — | fait | — | — | clos |
| OpenTelemetry JS | traces | **G2** intégré, éteint | vue UI | fait | — | — | exposer (P1) |
| AgentDojo | banc d'injections | **G3** intégré au test | détecteur | fait | détecteur interne | — | P0 (détecteur) |
| restic | archive chiffrée | **G4** branché (Réglages › Stockage) | validation empaquetée | fait | — | — | finir (P1) |
| yt-dlp | texte de vidéos | **G5** `media_fetch` | — | fait | — | — | clos |
| llama-swap | multi-modèles en mémoire | **G6** fournisseur optionnel | — | fait (optionnel) | — | second superviseur | clos |
| Windows-MCP | contrôle Windows MCP | **G7** optionnel | filtre par outil | fait (optionnel) | — | Python 3.14 | P2 (filtre) |
| Reladraw | diagrammes | **G8** dans `diagram_export` | — | fait | — | — | clos |
| MCP Inspector | débogage MCP | **G9** `mcp:inspect` | — | fait | — | trousseau Windows (mesuré) | clos |
| smolvm | VM Linux | **G10** `linux_*` | — | fait | — | — | clos |
| UI-TARS Desktop | perception visuelle | **G11** différé | computer use par vision | après banc | — | modèle lourd | P3 |
| Coucou | mini-interface | **G12** (idée) | — | fait | — | marques déposées | clos |
| osquery | diagnostics | **G13** `system_diagnostics` | — | fait | — | — | clos |
| GhidraMCP | pont Ghidra GUI | **G14** évalué ; `ghidra_analyze` + REA | — | non | — | exécution de la cible (bethington) | ignorer |
| Sandboxie | bac d'applications | **G15** `sandbox_*` | — | fait | — | GPL (binaire non embarqué) | clos |
| OpenCodeReview | revue de code | **G16** `code_review_plan` | — | fait | — | — | clos |
| Cua | bureaux d'évaluation | **G17** différé | banc commun | après banc | — | — | P3 |
| `claude-plugins-official` | — | absent (seulement cité par `upstream/hermes-agent/plugins/security-guidance`, non chargé) | — | **exclu** | — | — | exclu |

---

## ÉTAPE 4 — Recommandation JAROD-OS vNext

### Sortie 5 — Architecture cible (incrémentale)

```
┌────────────── Renderer React (cockpit) ──────────────┐
│ Chat + timeline · Capacités · Tâches · Plugins · Traces│
└──────────────▲───────── preload window.jarodOS ───────┘
               │ IPC typé (shared/ipc.ts)
┌──────────────┴─ Electron main (aujourd'hui) ─────────────┐   ┌── Hôte Rust (cible) ───────────────┐
│ backend manager · engines (DSH/ACP, Hermes) · widgets   │ → │ host-control (porte, C1–C3)       │
│ restic/backup · updates-check · sandboxes               │   │ host-supervisor · host-sandbox    │
└──────────────┬───────────────────────────────────────────┘   │ host-vault · host-storage · updater│
               │ WS JSON-RPC + REST (127.0.0.1, jeton)        └────────────────▲───────────────────┘
┌──────────────┴──── Noyau Cordis (jarod-core) ──────────────────────────────┐ │ tube nommé DACL
│ Agent ─ executeGuardedTool ─► PermissionGuard ─► Tâche + preuve ─► AUDIT │─┘
│ llm (RoutingService) · memory · rag · scheduler · skills · mcp(in/out)   │
│ plugin-platform (signé) ─► PluginHost (processus isolés) · quarantaine   │
│ integrations (catalogue = registre unique) · otel local                  │
└────────────────────────────────────────────────────────────────────────────┘
```

| Composant | Responsabilité | Frontière de sécurité | État |
|---|---|---|---|
| Hôte Rust | possède la machine : porte de contrôle, supervision, coffre, isolement, stockage, updater | seul processus privilégié ; contrats `contracts/v1` chargés depuis le disque ; refus par défaut | spikes ; à brancher un par un |
| Electron main | fenêtres, IPC, moteurs annexes | ne voit jamais de secret en clair (capacités seulement) | en service |
| Noyau Cordis | intelligence : agent, outils, mémoire, modèles | tout effet passe par `executeGuardedTool` | en service |
| Plugins | capacités ajoutées | processus isolé, permissions déclarées, manifeste signé, quarantaine si malade | isolement en service ; signature non branchée |
| MCP entrant | lecture pour d'autres agents | stdio seulement, lecture seule, audit sans contenu | en service |
| MCP sortant | outils tiers | `dangerous: true` par défaut, env filtré ; **cible** : liste blanche par outil | partiel |
| Modèles | local d'abord, repli par disjoncteur | réseau sortant soumis à l'interrupteur Internet | en service ; **cible** : routage par capacité |
| Audit | un journal append-only : tout appel, décision, palier, preuve | masquage (`redactKeyedText`) ; **cible** : chaîne de hachage | à unifier |
| Sandbox | une politique choisit AppContainer, Sandboxie, smolvm ou Docker selon l'outil | jamais de promesse sans `selftest` | voies en service, sélecteur absent |
| Rollback | restic, restauration à côté, updater A/B, rollback plugin, refine | état précédent gardé à côté, jamais écrasé | partiel |
| Observabilité | traces OTel locales + timeline UI + compteurs | épurateur par liste blanche | traces en service ; UI absente |

**IPC et permissions (RECO).** On garde le contrat actuel et on ne crée pas de nouveau canal :
- un outil = un `ToolDef` avec `dangerous`, `targetOf`, `verify` et un risque déclaré ;
- la porte unique décide, la tâche porte la preuve, l'audit enregistre.

### Sortie 6 — Plan de migration incrémental

| Phase | Objectif | Livrables | Dépendances | Risques | Critères de validation | Rollback | Dette traitée |
|---|---|---|---|---|---|---|---|
| **0 — Consolider** (1 sem.) | mettre l'arbre au propre | commits de l'arbre actuel (découpage `REMEDIATION` §11.4), CI verte, `cargo test`, pytest complet, passe FlaUI sur bureau au repos | accord utilisateur pour commit et push | régressions cachées | CI GitHub verte sur le commit exact | revert du commit | R-17, rien de validé en CI |
| **1 — Sûreté** | audit unique et injections | `audit` pour tout appel (lecture comprise) avec palier et résumé ; détecteur mesuré sur AgentDojo (seuil de détection et de faux positifs) ; garde DNS et `dgram` | phase 0 | faux positifs bloquants | banc AgentDojo > seuil, en mode `observe` d'abord ; test « un outil non dangereux est journalisé » | réglage `observe` ; ancien chemin d'audit | 4 journaux ; G3-F1 ; `NETWORK-POLICY` |
| **2 — Brancher l'existant** | plateforme plugins, quarantaine, écrans | `PluginPlatform` → `PluginHost` ; quarantaine sur `media_fetch`, téléchargements et imports de skills ; écrans Plugins, Quarantaine ; registre = une source (IPC + Rust inclus) | phase 1 | casse des plugins non signés | e2e : un plugin non signé refusé ; une mise à jour qui échoue est annulée | interrupteur `pluginPlatform: off` | non-branchés du BACKLOG phase 4 |
| **3 — Visibilité** | timeline et préréglages | timeline par tour (spans + tâches) dans le chat ; preuves shell et réseau ; 4 préréglages de profil au-dessus des règles ; filtre des tâches par conversation | phase 1 | bruit visuel | e2e : chaque appel visible ; un préréglage n'affaiblit jamais sans confirmation native | préréglage « Personnalisé » = règles actuelles | limites `COCKPIT-LOT2` |
| **4 — Hermes, DSH, modèles** | interop | import Hermes complet en `--dry-run` ; Hermes en ACP comme moteur annexe (si Hermes parle ACP : À VÉRIFIER) ; routage par capacité (vision, code, long contexte) ; veille `upstream.json` exécutée | phase 2 | dérive du contrat Hermes | `tsc` sur le contrat généré ; e2e moteur Hermes | désactiver le moteur | `dernierShaVu: null` |
| **5 — Hôte Rust** | déplacer la porte | `host-control` en service derrière un drapeau, puis `host-supervisor`, puis `host-updater` A/B ; packaging | phases 0 à 3 | double porte pendant la transition | matrice C2 « golden » identique TS et Rust | drapeau → porte TS | spike non packagé |
| **6 — Extensions produit** | apps, documents, bots | runtime d'apps minimal ; cherry-pick Herald Office ou Calc ; format d'équipe portable ; banc vision UI-TARS/Cua | phases 2 et 3 | surface d'attaque | chaque ajout passe le registre, la quarantaine et l'audit | désinstallation du plugin | — |

### Sortie 7 — Backlog priorisé

| ID | Titre | Source | Type | Valeur | Effort | Risque | Dépendances | Priorité | Nature |
|---|---|---|---|---|---|---|---|---|---|
| V-01 | Commit et CI de l'arbre actuel | interne | corriger | haute | S | faible | accord | P0 | quick win |
| V-02 | Auditer **tous** les appels (lecture comprise), palier, résumé | Herald | corriger | haute | S | faible | — | P0 | quick win |
| V-03 | Fusionner les journaux (SQLite, `audit.jsonl` Python, C3 Rust, `mcp-server.log`) dans une vue | interne | adapter | haute | M | faible | V-02 | P0 | structurant |
| V-04 | Détecteur d'injections mesuré sur AgentDojo | AgentDojo (G3) | recréer | haute | M | moyen | — | P0 | structurant |
| V-05 | Garde DNS et `dgram`, isolement réseau des enfants | interne | corriger | haute | M | moyen | — | P0 | structurant |
| V-06 | Brancher `plugin-platform` sur `PluginHost` + écran | interne | exposer | haute | M | moyen | V-02 | P1 | structurant |
| V-07 | Quarantaine sur les entrées externes | interne | exposer | haute | S | faible | — | P1 | quick win |
| V-08 | Timeline par tour dans le chat | CoWork-OS | adapter | haute | M | faible | OTel, tâches | P1 | structurant |
| V-09 | Préréglages de profil d'accès + limites dures | CoWork-OS | adapter | moyenne | S | faible | — | P1 | quick win |
| V-10 | Preuves pour le shell et le réseau | interne | finir | moyenne | M | faible | — | P1 | structurant |
| V-11 | Valider restic empaqueté (6 e2e) + M1 à M3 manuels | interne | finir | moyenne | S | faible | paquet | P1 | quick win |
| V-12 | Registre unique (IPC shell + Rust dans `CapabilityService`) | interne | finir | moyenne | M | faible | — | P1 | structurant |
| V-13 | Décider du sort de `plugin-sandbox` (doublon de `sandboxes.ts`) | interne | supprimer doublon | faible | S | faible | — | P2 | quick win |
| V-14 | Liste blanche MCP outil par outil | interne (G7) | finir | moyenne | S | faible | — | P2 | quick win |
| V-15 | Import Hermes complet `--dry-run` | CoWork-OS | adapter | moyenne | M | faible | — | P2 | structurant |
| V-16 | Hermes comme moteur ACP | CoWork-OS | adapter | moyenne | M | moyen | À VÉRIFIER : ACP de Hermes | P2 | structurant |
| V-17 | Reprise des tâches longues (baux) | OpenMuse | recréer | moyenne | M | moyen | test de plantage | P2 | structurant |
| V-18 | Historique et diff de la mémoire | CoWork-OS | adapter | moyenne | S | faible | — | P2 | quick win |
| V-19 | Routage de modèle par capacité | interne | adapter | moyenne | M | faible | — | P2 | structurant |
| V-20 | Cherry-pick des correctifs Herald #172 et #140 (après vérification) | Herald | intégrer | moyenne | S | faible | test | P2 | quick win |
| V-21 | `host-updater` A/B branché | interne | exposer | haute | L | élevé | phase 5 | P2 | structurant |
| V-22 | `host-control` derrière un drapeau | interne | exposer | haute | L | élevé | V-21 | P3 | structurant |
| V-23 | Runtime d'apps générées minimal | Wandesk | recréer | moyenne | L | élevé | V-06 | P3 | structurant |
| V-24 | Outil `calc` exact | Herald Calc | intégrer | faible | S | faible | — | P3 | quick win |
| V-25 | Workbench documents (Herald Office) | Herald | intégrer | moyenne | XL | élevé | — | P3 | structurant |
| V-26 | Format d'équipe portable (bots, routines en pause, sans secrets) | OpenMausBot | adapter | faible | M | moyen | persona | P3 | structurant |
| V-27 | Banc vision commun G7/G11/G17 | UI-TARS, Cua | intégrer | moyenne | L | élevé | GPU | P3 | structurant |
| V-28 | Suivi de pages et alertes | OpenMuse | recréer | faible | S | faible | Internet | P4 | quick win |

---

## Sortie 8 — Synthèse finale

### Fonctions déjà là dans JAROD à réutiliser
- Registre de capacités (`CapabilityService`, outil `capabilities`).
- Porte unique `executeGuardedTool` : règles par cible, échéance et autonomie bornée.
- Tâches avec preuves.
- Disjoncteur et repli de modèles.
- Gestion des modèles locaux.
- MCP entrant (lecture seule) et sortant.
- DSH en ACP.
- Scheduler, webhooks et workflows.
- Mémoire, RAG et vault.
- Sauvegarde restic et restauration à côté.
- Sandboxie, smolvm, AppContainer et Docker.
- osquery, Syft, OTel, AgentDojo, yt-dlp, Reladraw et OpenCodeReview.
- FlaUI et pywinauto.
- Plugins isolés par processus.
- Hub de skills avec analyse.

### Fonctions partiellement là, à terminer
- Audit, qui ne couvre que les outils sensibles.
- Preuves, absentes pour le shell et le réseau.
- Import Hermes (skills et MCP seulement).
- Veille d'upstream, jamais exécutée pour hermes-agent.
- Traces, sans UI.
- Restic empaqueté, non validé.
- Banc des contrôleurs de bureau, pas encore passé sur un bureau au repos.
- Registre, qui n'inclut ni le shell ni le Rust.
- Liste blanche MCP outil par outil.

### Fonctions qu'on croyait absentes mais qui existent déjà
- **17 des 22 dépôts externes** (vague G1 à G17).
- MCP **entrant** (`jarod mcp`).
- Intégration **DSH NEXT** en ACP, testée en e2e.
- **Repli de modèles** avec disjoncteur.
- **Permissions temporaires et par cible**.
- **Plateforme plugins signée avec rollback**, existante mais non branchée.
- **Quarantaine de fichiers**, non branchée.
- **Hyper-V**, non branché.
- **Updater A/B signé**, en Rust, non branché.
- **Coffre DPAPI**, en Rust et en TS.
- **Vérification Windows Update, pilotes et winget**.
- **Sorties d'outils hors contexte** (context-mode natif).
- **Panneau Today** (Herald).

### Fonctions réellement absentes à ajouter
- Journal d'audit unique et complet.
- Détecteur d'injections opérationnel.
- Garde DNS et `dgram`.
- Timeline visible par tour.
- Préréglages de profil d'accès.
- Mise à jour de Jarod lui-même.
- Reprise des tâches longues (À VÉRIFIER).
- Historique de la mémoire.
- Runtime d'apps générées.
- Workbench de documents.
- Computer use par vision.
- Bots persistants à identité propre.

### Fonctions externes les plus utiles comme inspiration
- CoWork-OS : timeline, profils d'accès, Today, import Hermes et ACP.
- OpenMuse : baux durables, revue d'action enregistrée.
- Wandesk : une origine et une base par app, un seul point d'accès IA.
- OpenMausBot : paquets d'équipe sans secrets, routines livrées en pause.

### Fonctions externes les plus utiles comme briques intégrables
- Herald Office et Herald Calc (MIT, même lignée, même contrat de pont).
- UI-TARS ou Cua, **après** le banc commun.
- Les autres briques intégrables sont **déjà intégrées**.

### Top 10 décisions proposées
1. Geler toute nouvelle intégration externe tant que V-01 à V-05 ne sont pas clos.
2. Un seul journal d'audit, couvrant tous les appels ; les 3 autres deviennent des sources de la même vue.
3. Mettre le détecteur d'injections en `observe` avec un seuil mesuré sur AgentDojo, puis passer en `enforce`.
4. Brancher `plugin-platform` : un plugin non signé ne s'installe pas.
5. La quarantaine devient obligatoire pour toute entrée venant d'Internet.
6. Une politique d'isolement unique choisit la voie (AppContainer, Sandboxie, smolvm ou Docker) ; décider du sort de `plugin-sandbox`.
7. Herald upstream : cherry-pick ciblé (correctifs, Calc) ; Office seulement si le workbench est confirmé comme besoin.
8. Les 5 nouveaux projets (CoWork-OS, Wandesk, OpenMausBot, Rakazo, OpenMuse) servent d'**inspiration seulement**. On n'intègre le code d'aucun : ce sont des applications complètes avec leur propre noyau ; OpenMuse exige un service cloud et OpenMausBot ou Rakazo un cloud de calcul.
9. Hôte Rust : brancher crate par crate derrière un drapeau, en commençant par `host-updater`. C'est le seul moyen d'obtenir des mises à jour sûres.
10. `claude-plugins-official` reste exclu ; vérifier qu'aucun plugin de `upstream/hermes-agent` qui le référence n'est chargé par le backend Hermes.

### Prototype minimal à construire maintenant
**Une « timeline auditée » de bout en bout.** Elle tient en quatre pièces :
- `executeGuardedTool` écrit une entrée d'audit pour chaque appel : outil, cible, décision, palier, preuve, durée et span id ;
- une vue du chat affiche, sous chaque tour, la liste de ces entrées, avec un lien vers la tâche et la trace OTel ;
- un test e2e prouve qu'une lecture (`read_file`), une commande (`run_shell`) et un refus apparaissent chacun une fois ;
- un test unitaire prouve qu'aucun contenu ne fuit (masquage).

Ce prototype réutilise `TaskLedger`, `SpanSink`, `events.append` et `redactKeyedText` : aucune dépendance nouvelle.

**Livré le 2026-10-23 (non commité).** Ce qui a changé :
- **V-02 dans la porte unique.** `executeGuardedTool` écrit une ligne pour **chaque** appel : lectures, outil inconnu, arguments invalides et annulations compris. Chaque ligne porte `callId`, `tier`, `target` masquée (`redactCommandText`), `durationMs` et `proof`. Les nouvelles décisions sont « sans accord », « annulé » et « refusé (invalide) » (`plugins/agent/src/agent.ts`).
- **Contrat c7-tool-audit-entry étendu**, toujours fermé : schéma, 3 fixtures, `index.json` et `INVENTORY.md`.
- **Lecture du journal par la fin** (`EventFilter.newest`). Avant, `auditLog` lisait les 10 000 *premières* lignes, ce qui serait devenu faux avec le nouveau volume. `AgentRuntime.auditOf(sessionId)` rend la timeline d'une conversation.
- **Canal `audit-session`** (lecture seule, identifiant validé) : 289 canaux au lieu de 288.
- **Vue** `AuditTimeline` sous chaque tour du chat (`features/hermes/`) : ligne repliée avec le nombre d'appels, les refus et les échecs ; dépliée, une ligne par appel avec heure, outil, cible, décision, preuve, palier et durée.
- **Tests.**
  - Noyau : agent 414, storage 58, bridge 473, cli 471 (+1 échec attendu, déjà connu).
  - Shell : vitest 1 434, typecheck shell et electron.
  - e2e `audit-timeline.spec.ts` sur l'app construite : 2/2, trois passes de suite.

**Limites.**
- `auditOf` ne cherche que dans les 10 000 dernières lignes du journal (toutes conversations confondues).
- Le journal n'a pas de rotation ; son volume croît désormais avec chaque lecture.
- Le backend Hermes n'a pas ce canal : la vue reste vide.
- Les journaux C3 (Rust), `audit.jsonl` (Python) et `mcp-server.log` restent séparés : c'est V-03.
- Les suites `engines` de l'agent (AgentDojo et autres) n'ont pas été relancées.

### Expériences à lancer cette semaine
1. `cargo test` dans `host-rust` et pytest complet du pont : établir la ligne de base manquante.
2. Banc AgentDojo : mesurer deux détecteurs candidats (motifs enrichis, petit classifieur local) pour la détection et les faux positifs.
3. Test de plantage pendant une automation longue : la tâche reprend-elle ? Cela tranche V-17.
4. Reproduire le scénario Herald #172 (gel avant une demande d'accord) sur le backend Jarod et sur le backend Hermes.
5. Vérifier si Hermes 0.21+ expose ACP (`hermes acp` ou équivalent). Cela tranche V-16.
6. Passe FlaUI sur un bureau au repos (`REMEDIATION` §11.3).
7. Mesurer A7 de `ANALYSE-2026-10-12` : `ELECTRON_RUN_AS_NODE` avec `node --permission` sur Electron 44.

---

## Sources externes consultées
- Herald-OS upstream : <https://github.com/iamlukethedev/Herald-OS> (commits via `gh api`, depuis le 2026-10-07)
- CoWork-OS : <https://github.com/CoWork-OS/CoWork-OS>
- Wandesk : <https://github.com/Sider-ai/wandesk>
- OpenMausBot : <https://github.com/milind-soni/OpenMausBot>
- Rakazo : <https://github.com/elie222/rakazo>
- OpenMuse : <https://github.com/CopilotKit/openmuse>
- Les 17 autres dépôts : URL vérifiées le 2026-10-20 dans `docs/INTEGRATIONS-PLUS3.md`.
