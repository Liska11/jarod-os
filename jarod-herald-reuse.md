# Réutiliser les outils système Windows de Herald OS dans Jarod

Inventaire en lecture seule, établi le 2026-10-11. Rien n'a été écrit dans `S:\`, aucun commit n'a été fait.

**Sources lues.** Herald : `plugins/herald-os-bridge/` (`bridge/tools.py`, `permissions.py`, `audit.py`, `ui.py`, `host/windows.py`, `host/winps.py`, `host/base.py`), `WINDOWS-PORT-NOTES.md`.
Jarod : `S:\store\projet\jarod-cordis` (DECISIONS.md, DECISIONS-INDEX.md, BESOINS.md, STATE.md, plan.md, gap-reel.md, PHASE-3/4, SPECS-P5-MCP/TRAY/UI-PARITE, docs/SECURITE.md, `packages/plugins/{tools,agent,permissions,mcp,workflows,vision}`) et `S:\Jarod-one` (`packages/core`, `packages/desktop`).

**Ce qui n'a pas été fait.** Aucun outil n'a été porté ni exécuté dans Jarod. Les efforts S/M/L sont mes estimations (S ≤ 1 jour, M 1 à 3 jours, L > 3 jours, pour une personne qui connaît les deux bases), pas des mesures. Les 714 Ko de DECISIONS.md n'ont pas été lus en entier, seulement par recherches ciblées ; les SPECS ont été cherchées par thèmes, pas lues une à une.

---

## 0. Corrections de l'audit précédent

Ma réponse précédente contenait quatre erreurs ou omissions, trouvées en vérifiant par comportement.

| # | Ce que j'avais dit | Ce qui est vrai | Preuve |
|---|---|---|---|
| 1 | « jarod-cordis dialogue déjà avec le tableau de bord Hermes » | **Non, pas dans l'usage.** DECISIONS du 2026-09-27 : « Jarod n'a pas le tableau de bord Python d'Hermes, le chat passe par l'IPC » ; `start-dashboard` répond `{ supported: false }`. Le code du transport (`useDashboardChatTransport`, `Chat.tsx:612`) vient de SANK-UI et est présent, mais je ne l'ai pas exécuté : **à vérifier à l'exécution**. Hermes n'a servi qu'à un import de données unique (B2 : 892 sessions, 875 mémoires). | DECISIONS.md:147, STATE.md |
| 2 | « Jarod n'a aucun outil de volume » | **Jarod-one en a un** : le plugin livré `media-control` (volume, mute, touches média, lancement d'appli), mais en touches simulées (`keybd_event`) : le volume est **relatif** (chaque appui = +2 %), le mute est une **bascule**, et rien ne **lit** l'état. Jarod-cordis ne l'a pas porté (planifié `plan.md:83` dans `plugin-vision`, absent de `packages/plugins/vision/src`). | `S:\Jarod-one\packages\core\src\services\media-control-plugin.ts`, `plan.md:83` |
| 3 | « Jarod refuse "Toujours" pour `run_shell` » | **Vrai pour jarod-cordis seulement** (`NEVER_ALWAYS`, 6 outils dont `run_shell`). Jarod-one n'a ni « Toujours » ni règles par outil : approbation binaire (`dangerous` + `autoApproveTools`). | cordis `plugins/agent/src/never-always.ts` ; one `core/src/agent.ts:931` |
| 4 | « Jarod a un audit » | **Partiel.** Dans cordis, une ligne n'est écrite que pour un outil `dangerous` ou refusé/bloqué : un outil non dangereux n'est **pas journalisé** (`if (decision) audit(...)`, `agent.ts:1084-1138`). Le journal va dans le magasin d'événements SQLite, pas dans un fichier ; il n'a ni palier ni résumé. | cordis `plugins/agent/src/agent.ts` |

Deux précisions de méthode :
- Un premier balayage `grep -r` s'arrêtait sur un lien cassé de `node_modules` et donnait de faux zéros pour Jarod-one. J'ai refait toutes les recherches avec `find` en excluant `node_modules`, les sorties de build, les tests et le rendu SANK-UI (cordis : 325 fichiers parcourus ; Jarod-one : 241).
- Jarod-one et cordis sont deux états d'une même lignée : cordis porte `packages/core` de Jarod-one « rév. 2e180305 » (HEAD de Jarod-one, 2026-09-26). Jarod-one est gelé ; **cordis est la cible** (dernier commit `f64ef4cc`, 2026-10-06). Tout le plan ci-dessous vise cordis.

---

## 1. Absent, planifié ou abandonné ?

Recherche dans DECISIONS.md, BESOINS.md, STATE.md, plan.md, gap-reel.md, SPECS-*.md et PHASE-*.md (motifs : outils système, `os_ui`, multi-plateforme, processus, corbeille, volume, mode sombre, événements, verrouillage, PowerShell, Herald).

- **Aucune mention de Herald ni de `herald-os`** dans les documents de cordis (recherche `herald|hermes-os` dans `docs/`, `*.md`, `jarod_master_plan_Muse`). Rien n'y est planifié ni abandonné à ce sujet.
- **Pas d'outils système**, ni planifiés ni refusés : aucune décision n'en parle. Le plus proche est `media-control` (volume, lancement) placé dans `plugin-vision` par `plan.md:83` et « Phase 3 » par `plugins/vision/src/index.ts:3` ; `PHASE-3.md:67` repousse OBS, calendrier, etc. à « P3-P4 ». **Planifié, non livré.**
- **Windows seulement.** cordis cible Windows ; macOS et Linux sont « non ciblés » (`SPECS-P5-TRAY.md:25`, `:49`). Les capacités Linux de Herald (`system_os`, image bootc, niri) n'ont donc aucun terrain.
- **Python.** Règle statuée par l'utilisateur (DECISIONS.md:225, 2026-09-28) : Python n'est toléré que dans des **workers d'ingestion isolés**, « JAMAIS dans le chemin critique : voix, embeddings, **chat** ». Un outil appelé pendant un tour de chat est dans ce chemin. **Cette règle écarte l'option A telle que décrite en §4.**
- **Notifications système** : listées comme non faites dans `SPECS-P5-TRAY.md:49`.
- **Plugins utilisateur** : exécutés dans un processus isolé avec le modèle de permissions de Node : « ni processus enfant, ni worker, ni addon » (`workflows/src/runner.cjs:3-4`, `plugins.ts:154`). **Un plugin utilisateur ne peut donc pas lancer PowerShell.** Un outil système doit être un outil **intégré** (`plugin-tools`), pas un plugin.
- **Précédents utiles.** cordis lance déjà PowerShell depuis le noyau (`plugins/llm/src/local.ts`, `storage/src/dbkey.ts`, `os-crypt.ts`, `voice/src/speech.ts`, `desktop/src/main/terminal.ts`), donc le mécanisme n'est pas nouveau.

---

## 2. Capacités de Herald : qui les fournit dans Jarod ?

Degré : **natif** = outil de l'agent ; **contournable** = faisable via `run_shell` ou `execute_code` (cmd.exe sous Windows, approbation à chaque appel, pas de « Toujours » dans cordis, sortie brute, aucune liste de chemins protégés) ; **absent**.
Recherche : `find … | xargs grep -E` sur les motifs entre parenthèses, hors tests, `node_modules`, builds, rendu SANK-UI.

| Capacité Herald | jarod-cordis | Jarod-one | Fichiers vérifiés / recherche |
|---|---|---|---|
| Infos système (CPU, RAM, disques, batterie, uptime) | contournable ; absent en natif | idem | `os.totalmem\|os.cpus\|systeminformation\|Win32_OperatingSystem\|Win32_Battery` : 0. Seul `statfsSync` (`plugins/llm/src/huggingface.ts:58`, espace libre avant téléchargement, pas un outil) |
| Liste des processus, port | contournable (`tasklist`, `netstat`) ; absent en natif | idem | `Get-Process\|tasklist\|Win32_Process\|Get-NetTCPConnection\|netstat` : 0 |
| Arrêter un processus | contournable (`taskkill`) ; `taskkill` n'est employé que sur ses propres enfants (`kernel/src/util.ts:13`) | idem (`core/src/util.ts:13`, `runtime-python-plugin.ts:119`) | |
| Espace disque par dossier | absent ; `list_dir` est confiné au dossier de travail | idem | `Win32_LogicalDisk\|Get-PSDrive\|wmic` : 0 |
| Recherche de fichiers | **partiel** : `find_files`, `search_files` existent mais **confinés au dossier de travail** (`resolveInWorkspace`, `search.ts:123,154`), sans `kind` ni `when` | partiel, même modèle | `plugins/tools/src/search.ts`, `builtin.ts:68` |
| Applications installées / ouvertes / fermer | absent | **partiel** : lancer une appli (`media-control` `launch`, nom validé, `spawn` sans shell) | `Get-StartApps\|Get-AppxPackage\|shell:AppsFolder\|App Paths` : 0 |
| Ouvrir URL / chemin / Réglages | absent en outil. Des gestionnaires de l'interface appellent `shell.openExternal/openPath/showItemInFolder` (`handlers/app.ts`, `files.ts`) ; `open-external` côté API Hermes est refusé (DECISIONS.md:80) | idem (`desktop/src/main/index.ts:325,331`) | `ms-settings:` : 0 |
| Créer / déplacer / copier / corbeille | **partiel** : `write_file`, `edit_file` confinés ; ni déplacer, ni copier, ni corbeille. Via `run_shell`, `del` supprime **définitivement** | idem | `trashItem\|SendToRecycleBin\|RecycleBin` : 0 (sauf le simulacre `scripts/electron-stub/index.mjs:123`, tests) |
| Réseau, Wi-Fi, Bluetooth | absent (`networkInterfaces` n'y sert qu'à l'appairage du téléphone, `gateways/src/mobile.ts:60`) | idem (`core/src/services/mobile.ts:56`) | `Get-NetIPConfiguration\|wlan show\|Get-PnpDevice` : 0 |
| Volume, mute | absent | **partiel et relatif** (voir §0 n°2) | `IAudioEndpointVolume\|keybd_event\|setVolume` : 1 fichier, `media-control-plugin.ts` |
| Mode sombre du système | absent. `set-native-appearance` règle `nativeTheme.themeSource` (l'application seulement, DECISIONS.md:150) | absent | `AppsUseLightTheme\|ImmersiveColorSet` : 0 |
| Notification système | absent en outil ; Jarod-one a une seule notification de conseil pour la zone de notification (`desktop/src/main/index.ts:314`) | idem | `ToastNotification\|node-notifier` : 0 |
| Verrouiller, éteindre l'écran | absent | absent | `LockWorkStation\|SC_MONITORPOWER` : 0 |
| Journal d'événements, rapports de crash Windows | absent. cordis écrit ses **propres** minidumps Electron (DECISIONS.md:168), pas ceux des autres programmes | absent | `Get-WinEvent\|wevtutil\|Application Error` : 0 |
| Piloter l'interface par l'agent (`os_ui`) | absent. 59 canaux propres à Jarod et `desktopCommands.ts` existent pour l'utilisateur ; `ui-bridge` est un pont IPC rendu↔principal. Aucun outil de la liste ne pilote l'interface | absent | liste des outils : `annotate_line … write_file` (cordis, 59 noms) ; `android_devices … worktree_run` (Jarod-one) |

Inventaire des outils (extrait de `name: "…"` dans `tools/src`, `agent/src`, `skills/src`, `rag/src`, `memory/src`) : cordis n'a aucun outil `system_*`. Jarod-one non plus, hors `media_control_*`.

---

## 3. Contrats communs de Herald (valables pour les 13 outils)

| Élément | Herald | Écart avec cordis |
|---|---|---|
| Enveloppe | succès `{"success": true, "summary": "<outil> <action>", …}` ; échec `{"success": false, "error": "…", …}` (`util.py:ok/fail`) | cordis renvoie une **chaîne** (`run(args, ctx): Promise<string>`) ; erreur = exception → « Erreur : … ». Le JSON de Herald tient dans la chaîne. |
| Paliers | `read` (immédiat), `act` (immédiat, journalisé), `mutate` (demande ; « session » / « always » acceptés), `destructive` (demande toujours ; clé de règle unique par appel, donc « always » ne tient jamais). Réglables dans `permissions.yaml` (`allow\|confirm\|deny`) ; un destructif ne peut jamais être pré-autorisé (`permissions.py:114`) | cordis : `dangerous` booléen + règles par outil `allow/ask/deny` (`PermissionGuard`) + `NEVER_ALWAYS` + `autoApproveTools` + mode Plan. **Pas de palier `act`.** |
| Chemins protégés | refus **avant** de demander (`authorize`), liste intégrée + `protected_paths` du YAML. Windows : `~/.ssh`, `~/.gnupg`, `%APPDATA%\gnupg`, `Microsoft\Credentials`, `Protect`, `SystemCertificates`, `Vault`, `ProgramData\Microsoft\Crypto`, `$HERMES_HOME\.env`, `auth.json`, `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%` | cordis n'a pas de liste de chemins protégés : il **confine** les outils fichiers au dossier de travail (`resolveInWorkspace`). Le garde du shell refuse `writeScope: workspace` sous win32 (`shell-guard.ts`, en-tête). |
| Approbation | `tools.approval.request_tool_approval(tool, reason, rule_key=…)` de Hermes ; hors Hermes : « No approval channel » → refus | cordis : `ctx.approve(sessionId, call, description)` (même porte que les outils `dangerous`) |
| Audit | `$HERMES_HOME\herald-os\audit.jsonl` : `{ts, tool, tier, action, decision, ok, summary, error, args}` ; secrets (`password`, `token`…) masqués ; rotation à 5 Mo ; **tout** appel est journalisé | cordis : `AuditEntry {sessionId, tool, args(500, masqués), decision, ok}` en SQLite, outils `dangerous` seulement |
| Exécution Windows | PowerShell 5.1 par chemin absolu, `-EncodedCommand` (UTF-16 base64), arguments en JSON dans `HERALD_OS_ARGS` (jamais dans le texte du script), sortie JSON UTF-8 | Réutilisable tel quel depuis Node (`child_process.spawn`, `shell:false`) |
| Latence mesurée ici | voir §5 | |

---

## 4. Les 13 outils

`TOOL_SPECS` en déclare 13 : `os_ui`, `system_network`, `system_control`, `system_logs`, `system_info`, `system_processes`, `system_disk_usage`, `system_find_files`, `system_apps`, `system_open`, `system_kill_process`, `system_files`, `system_os`. Sous Windows : **11 opérationnels**, `os_ui` exige le shell Herald, `system_os` est Linux seul.

### Les deux options

**Option A : charger le plugin tel quel comme outils Hermes.**
Le plugin attend le runtime Hermes : `register(ctx)` appelle `ctx.register_tool` et `ctx.register_skill` ; `permissions._confirm` importe `tools.approval` ; `bridge_enabled` lit `hermes_cli.config` et `util.hermes_home` lit `hermes_constants` (ces deux-là retombent sur des valeurs par défaut en cas d'échec). **cordis n'a pas ce runtime** (§0 n°1).
- *A1, Hermes à côté de Jarod* : le plugin charge sans modification, mais c'est Hermes qui tient la boucle d'agent, plus Jarod. Hors sujet.
- *A2, un hôte Python* : un petit processus importe le plugin avec un faux `ctx` (≈ 60 lignes), un faux module `tools.approval` qui rappelle Jarod pour l'accord, et expose les outils soit en MCP stdio (le client MCP de cordis existe : `plugins/mcp/src/mcp.ts`, profil `mcpServers`), soit en JSON-RPC.
  - Limites : (1) **règle Python** (§1) : appel en plein tour de chat ; (2) **aucun interpréteur Python embarqué** (STATE.md:45 : « interpréteur Python … non embarqués ») : il faut Python 3.11 sur la machine, par exemple le venv de Hermes, donc une dépendance à Hermes ; (3) tout outil MCP est enregistré `dangerous: true` (`mcp.ts:354`) : même `system_info` demande l'accord à chaque appel, sauf « Toujours autoriser » par outil ; (4) les paliers de Herald se confondent avec ceux de Jarod ; (5) deux journaux d'audit ; (6) `runtime-python-plugin` n'est **pas porté** dans cordis (`plan.md:84` le prévoit, `settings.ts:580` parle de « dette de portage »).
  - Dans **Jarod-one**, `runtime-python` existe (interpréteur absolu et haché, JSON-RPC ndjson), mais Jarod-one est gelé.

**Option B : porter dans `plugin-tools` de cordis (TypeScript).**
Nouveau fichier d'outils intégrés (`ToolDef` : `name`, `description`, `parameters` JSON Schema, `dangerous`, `available()`, `source`, `run`). Les **17 scripts PowerShell** de `winps.py` se recopient presque tels quels. Les ≈ 300 lignes de parseurs purs de `windows.py` sont à réécrire en TypeScript, avec leurs jeux d'essai (`tests/test_windows_host.py`, y compris les sorties `netsh` en FR/EN/DE/IT) à convertir en Vitest.
- Ce qui change : sortie en chaîne ; `dangerous` booléen au lieu de 4 paliers ; pas de palier `act` ; pas de chemins protégés mais un confinement ; l'audit des outils non dangereux est à ajouter ; `NEVER_ALWAYS` à étendre (kill, quit, trash) ; le modèle d'accord de Jarod (règles par outil, « Toujours » refusé pour certains) remplace `permissions.yaml`.
- **Recommandée** : B respecte la règle Python, n'ajoute pas de dépendance, et profite du mode Plan, du garde unifié et de `available()` (qui permet de masquer l'ensemble avec un interrupteur, comme pour les outils RAG, UI-PARITE § 19).

### Table de synthèse

| # | Outil | Actions | Palier(s) Herald | Dépendances Windows | A (tel quel) | B (port) | Effort B | Validé sur Hermes réel (Windows 11) |
|---|---|---|---|---|---|---|---|---|
| 1 | `system_info` | 1 | read | PowerShell + CIM | possible via A2 | oui | S | oui |
| 2 | `system_processes` | top, find, port | read | PowerShell + CIM, `Get-NetTCPConnection` | A2 | oui | M | oui |
| 3 | `system_disk_usage` | 1 | read (chemin vérifié) | Python pur (`os.scandir`) | A2 | oui | S | oui |
| 4 | `system_find_files` | 1 | read | ripgrep (fourni par Hermes) sinon parcours Python | A2 | oui, ripgrep non garanti | M | oui |
| 5 | `system_apps` | installed, running, quit | read ; quit = destructive | `Get-StartApps`, `Get-Process` | A2 | oui | M | lecture oui ; `quit` non |
| 6 | `system_open` | app, url, path, reveal, editor, settings | act | `os.startfile`, `explorer /select`, `ms-settings:` | A2 | oui | M | `settings` oui ; le reste non |
| 7 | `system_kill_process` | pid, port, name | destructive | PowerShell `Kill()` / `CloseMainWindow()` | A2 | oui | S–M | pid inexistant seulement |
| 8 | `system_files` | mkdir, move, copy, trash, batch | mutate ; trash = destructive | Python (`shutil`) + `Microsoft.VisualBasic` (corbeille) | A2 | oui | M | corbeille oui |
| 9 | `system_network` | status, bluetooth | read | `Get-NetIPConfiguration`, `netsh wlan`, `Get-PnpDevice` | A2 | oui | M | oui (matériel Wi-Fi/BT absent : essais sur jeux d'essai) |
| 10 | `system_control` | 8 actions Windows sur 19 | read ou act | COM Core Audio via C# `Add-Type`, registre, WinRT, `user32` | A2 | oui | M | lecture, volume, mode sombre, toast, Réglages, veille écran oui ; `lock_screen` **non appelé** |
| 11 | `system_logs` | log, crashes, crash_report | read | `Get-WinEvent` | A2 | oui | S | oui |
| 12 | `system_os` | 30 | mixte | CLI `herald-os` Linux | **non applicable** | **non applicable** | n/a | n/a |
| 13 | `os_ui` | run, list, state | selon la commande | socket de contrôle du shell Herald (`tcp://127.0.0.1:<port>` + jeton) | non (exige le shell Herald) | **L** : à reconstruire | L | oui, avec le shell Herald (153 commandes lues, pages ouvertes) |

### Fiches

Dans chaque fiche : *Entrée* / *Sortie* = contrat JSON ; *Protégés* = chemins soumis à `authorize` ; *Limites* = ce qui est connu ou non vérifié.

#### 1. `system_info` — palier read
- *Entrée* : aucune. *Sortie* : `{os, build, chip, cpu_cores, memory_total_bytes, memory_used_bytes, load_average: null, uptime_seconds, disks:[{mount,total_bytes,used_bytes,free_bytes}], battery:{percent,state}|null, hostname, arch, user, home}`.
- *Protégés* : aucun. *Dépendances* : `Get-CimInstance` (Win32_OperatingSystem, Processor, LogicalDisk, Battery) ; `platform`, `socket` de Python.
- *A* : A2 seulement. *B* : script `SYSTEM_INFO` repris ; hostname, arch, user, home viennent du module `os` de Node. Pas de moyenne de charge sous Windows (`null`).
- *Risques* : 1,6 s mesurées (§5). Jarod n'a rien d'équivalent (§2).

#### 2. `system_processes` — palier read
- *Entrée* : `{action: top|find|port, sort: cpu|memory, name, port, limit ≤ 100}`. *Sortie* : `top` → `{sort, processes:[{pid,ppid,user,name,cpu_percent,mem_percent,rss_bytes,command}]}` ; `find` → `{name, processes}` ; `port` → `{port, listeners:[{pid,command,user,port,protocol}], note}`.
- *Dépendances* : `Win32_Process` (deux échantillons à 0,5 s pour le CPU), `Invoke-CimMethod GetOwner` (au plus 40 lignes), `Get-NetTCPConnection` / `Get-NetUDPEndpoint`.
- *Risques* : **9 à 10 s mesurées** pour `top`, la lecture du propriétaire en cause probable (non isolée). À optimiser avant d'en faire un outil de conversation (`Get-Process` à la place de CIM, propriétaire à la demande).

#### 3. `system_disk_usage` — palier read, chemin contrôlé
- *Entrée* : `{path (~ accepté), depth 1–3, limit ≤ 100}`. *Sortie* : `{path, total_bytes|null, timed_out, entries:[{path,bytes}], note}`.
- *Protégés* : `path`. *Dépendances* : Python pur, délai de 90 s, liens et jonctions non suivis (balises de reparse `0xA0000003`, `0xA000000C`).
- *B* : parcours `fs` de Node ; **à vérifier** : si `lstat` de Node signale bien les jonctions comme des liens.
- *Écart de modèle* : opère hors du dossier de travail, alors que les outils de Jarod sont confinés (décision produit, §6).

#### 4. `system_find_files` — palier read
- *Entrée* : `{text, name, kind: any|image|screenshot|document|pdf|video|audio|folder|code|archive, when: today|yesterday|this_week|last_7_days|this_month, since, until, scope, extensions[], limit ≤ 200}`. *Sortie* : `{count, files:[{path,size,modified,kind}], note}`.
- *Dépendances* : ripgrep (`rg.exe` fourni par Hermes sous `<HERMES_HOME>\tools\ripgrep-*`, sinon `PATH`) ; à défaut, parcours Python avec échéance de 25 s ; dossiers par défaut : Bureau, Documents, Téléchargements, Images, Vidéos, Musique (OneDrive compris, AppData exclu) ; date de création Windows (`st_ctime`).
- *Limites* : **`scope` n'est pas vérifié contre les chemins protégés** (`_read` ne passe aucun chemin) : le tool ne renvoie que des noms de fichiers, mais la recherche de contenu (`text`) lit les fichiers sous `scope`. Si le port la conserve, c'est un choix à faire ; sinon la corriger.
- *B* : le tableau `kind` → extensions et le calcul de bornes de dates (`search.py`) sont à réécrire. ripgrep n'est pas garanti hors Hermes (le livrer ou se rabattre sur le parcours).

#### 5. `system_apps` — read ; `quit` = destructive
- *Entrée* : `{action: installed|running|quit, filter, name, force}`. *Sortie* : `{count, apps:[{name,path,bundle_id,running,pid}]}` (300 max) ; `quit` → `{app, forced}`.
- *Dépendances* : `Get-StartApps` (les entrées en double sont fusionnées par nom), `Get-Process` avec fenêtre, `CloseMainWindow()` puis `Kill()`.
- *Limites* : « installées » = entrées du menu Démarrer, pas toutes les applications. `quit` n'a été exercé que par ses tests.

#### 6. `system_open` — palier act, chemin contrôlé
- *Entrée* : `{target: app|url|path|reveal|editor|settings, app, url, path, editor, pane, args[]}`. *Sortie* : `{opened…}` selon la cible.
- *Dépendances* : `os.startfile` (ShellExecute), `explorer.exe /select,"…"`, `ms-settings:` (39 noms de volets). Protections : refus d'ouvrir un exécutable ou un script (`.exe .bat .ps1 .lnk .msi …`, liste `EXECUTABLE_SUFFIXES`), schémas d'URL limités à `http(s)`, `mailto`, `file`.
- *Limites* : la description et les éditeurs (`vscode`, `cursor`, `zed`) viennent de macOS ; la branche « dans le shell Herald » (`_open_in_shell`) est à supprimer dans Jarod. Seul `settings` a été exercé sur le vrai système.

#### 7. `system_kill_process` — palier destructive
- *Entrée* : `{pid | port | name, all, force}`. *Sortie* : `{stopped:[…], errors:[…], signal}`.
- *Garde-fous* : refuse les pid 0 et 4, `system`, `registry`, `smss`, `csrss`, `wininit`, `winlogon`, `services`, `lsass`, `lsaiso`, `dwm`, `svchost`, `fontdrvhost`, le processus de Hermes et son parent ; un nom doit désigner un seul processus sauf `all`. Demande toujours (clé de règle unique).
- *Limites* : le champ `signal` vaut « SIGTERM / SIGKILL » même sous Windows (cosmétique). **Le kill forcé d'un vrai processus n'a pas été exercé.** Risque de réutilisation de pid entre la liste et l'arrêt.

#### 8. `system_files` — mutate ; `trash` = destructive
- *Entrée* : `{action: mkdir|move|copy|trash|batch, path, to, paths[], operations:[{op,path,to}], dry_run}`. *Sortie* : `{applied:[…]}` ou, en essai à blanc, `{dry_run, tier, plan, problems, note}`.
- *Protégés* : **tous** les chemins touchés (source et destination). Écrase jamais (`FileExistsError`). Une confirmation par lot.
- *Dépendances* : `shutil`, et la corbeille via `Microsoft.VisualBasic.FileIO.FileSystem` (`SendToRecycleBin`). Option `AllDialogs` : **à vérifier en session non interactive** (une boîte de dialogue pourrait bloquer).
- *B* : `fs.cp`/`rename` de Node ; la corbeille reste en PowerShell ; Electron a `shell.trashItem` mais le noyau de Jarod ne dépend pas d'Electron.

#### 9. `system_network` — palier read
- *Entrée* : `{action: status|bluetooth}`. *Sortie* : `status` → `{online, default_interface, gateway, dns[], interfaces:[{name,device,mac,ipv4,default_route}], wifi:{interface,connected,ssid,phy_mode,channel,rate_mbps,signal_percent,security}|null}` ; `bluetooth` → `{bluetooth:{powered_on, connected:[], paired[], note}}`.
- *Limites* : `netsh wlan` est **traduit** : lecture positionnelle de repli, testée sur 4 langues avec des jeux d'essai seulement ; Windows n'indique pas quel appareil Bluetooth est connecté. 4,2 s mesurées.

#### 10. `system_control` — read ou act
- *Windows* : `audio` (lecture), `appearance` (lecture : mode sombre, écrans), `set_volume {percent, muted}`, `set_dark_mode {enabled}`, `notify {title, body}`, `open_settings {pane}`, `sleep_display`, `lock_screen`.
- *Non pris en charge sous Windows* (`HostNotSupported`) : `set_wifi`, `wifi_networks`, `wifi_connect`, `bluetooth_power`, `bluetooth_connect`, `bluetooth_disconnect`, `audio_devices`, `set_audio_output`, `set_brightness`, `power_profile`, `set_power_profile`. **Aucun équivalent Windows vérifié : pas d'estimation.** (Le panneau Son et la luminosité de l'application Electron sont une autre couche, hors du pont Python.)
- *Dépendances* : COM Core Audio (`IAudioEndpointVolume`) compilé par `Add-Type` ; registre `HKCU\…\Themes\Personalize` + diffusion `ImmersiveColorSet` ; toast WinRT sous l'identifiant de PowerShell ; `LockWorkStation` et `SC_MONITORPOWER` via `ctypes`.
- *Choix de palier à revoir* : Herald classe `set_volume`, `lock_screen`, `sleep_display` en **act** (sans demande). Jarod n'a pas ce palier.
- *Apport sur `media-control`* : volume **absolu** et lecture de l'état (mute compris), là où `media-control` ne sait qu'incrémenter.
- *Limites* : `lock_screen` jamais appelé ; l'apparence réelle du toast jamais observée.

#### 11. `system_logs` — palier read
- *Entrée* : `{action: log|crashes|crash_report, minutes ≤ 240, level: error|fault|any, process, limit ≤ 200, report}`. *Sortie* : `log` → `{minutes, level, process, lines[]}` ; `crashes` → `{crashes:[{report,app,time,module,exception_code}]}` ; `crash_report` → `{report, app, version, time, exception:{code,meaning}, faulting_module, module_version, fault_offset, process_id, app_path, module_path, message}`.
- *Dépendances* : `Get-WinEvent` sur Application et Système ; plantages = événement 1000 « Application Error » (7 jours). Table de 14 codes d'exception commentés.
- *Limites* : l'événement 1000 ne couvre pas les plantages .NET (1026) ni ceux des services. Le **skill `diagnose-crash`** (67 lignes) peut être repris comme skill Jarod ; il décrit aussi macOS et Linux, à élaguer.

#### 12. `system_os` — Linux uniquement
- Pilote la CLI `herald-os` de l'image Herald OS Linux (installation de logiciels, thèmes, rappels, suspension…). Sous Windows : `{"success": false, "error": "system_os is only available on Herald OS Linux"}`.
- **Non applicable à Jarod** (cordis ne cible pas Linux). Quelques actions (rappels, notification) ont un sens pour Jarod mais sans rapport avec ce code.

#### 13. `os_ui` — palier selon la commande
- *Entrée* : `{action: run|list|state, command, args{}}` ; le palier de chaque commande vient du **registre du shell** (`read|act|mutate|destructive`), les commandes inconnues sont traitées comme `mutate`. *Sortie* : `list` → `{commands:[{id,title,description,tier,args[]}]}` ; `state` → page et fenêtres ; `run` → `{result, command, …}`.
- *Protocole* : JSON par ligne vers le socket du shell, `tcp://127.0.0.1:<port>` sous Windows, jeton par lancement (`HERALD_OS_CONTROL_SOCKET/TOKEN` ou `herald-os\control.json`).
- *Réutilisation* : **aucune directe** (dépend du registre de 153 commandes du shell Herald). L'idée se porte : un outil `ui` qui expose les commandes de Jarod (`desktopCommands.ts`, commandes `/`). C'est un chantier d'interface, pas un port : **L**.

---

## 5. Latences mesurées (une exécution, cette machine, Windows 11 build 26300, usage normal)

Script exécuté via l'adaptateur Windows du pont, un appel par ligne :

| Appel | Durée | | Appel | Durée |
|---|---|---|---|---|
| `system_info` | 1,58 s | | `apps installées` | 0,61 s |
| `processes top cpu` (échantillon 0,5 s) | **9,92 s** | | `logs d'événements 10 min` | 0,43 s |
| `processes top memory` | **9,12 s** | | `crashs 7 jours` | 0,37 s |
| `port 80` | 1,32 s | | `apparence + écrans` | 0,55 s |
| `réseau` | 4,20 s | | `audio (lecture)` | 0,36 s |

Une seule exécution chacune, sans contrôle du froid/chaud. Les deux appels `processes` sont trop lents pour un tour de conversation et sont le premier point à travailler dans un port.

---

## 6. Plan d'intégration en trois phases

Principe commun, repris de la pratique de Jarod : écrire les barres de réussite **avant** de mesurer, et tester avec PowerShell simulé (comme dans Herald) puis une fois pour de vrai sur la machine.

### Phase 1 : lecture seule (6 outils)
`system_info`, `system_processes`, `system_disk_usage`, `system_network`, `system_logs`, `system_apps` (installed/running), en outils intégrés de `plugin-tools`, avec les scripts PowerShell de `winps.py` repris à l'identique.
- **Critère de validation testable** : (1) pour chaque outil, un test Vitest avec PowerShell simulé qui vérifie le JSON documenté en §4 ; (2) un test réel sur Windows 11 qui renvoie des données non vides ; (3) chaque appel produit une ligne d'audit lisible, y compris pour un outil non dangereux (c'est un ajout, voir décision 3) ; (4) `system_processes top` en moins de 5 s sur cette machine (seuil proposé, à confirmer) ; (5) `typecheck` et suite complète verts, sans régression des 1 108 tests desktop ni des autres.
- **À décider avant de commencer** : voir les décisions 1, 2, 3 et 4 du §7.

### Phase 2 : actions réversibles (palier act)
`system_open` (app, url, path, reveal, settings), `system_control` (volume absolu, mode sombre, notification, Réglages, veille écran ; `lock_screen` selon décision), `system_apps` `quit` non forcé.
- **Critère testable** : (1) aller-retour : lire le volume, le changer, relire, le rétablir, vérifier l'état initial ; même chose pour le mode sombre ; (2) les arguments voyagent en JSON dans l'environnement, jamais dans le texte du script (test sur un titre de notification contenant `'`, `"`, `$()`, `;`) ; (3) l'ouverture d'un `.exe`, `.ps1` ou `.lnk` est refusée ; (4) chaque action est auditée avec le palier choisi ; (5) la correspondance entre le palier Herald et le comportement de Jarod est un tableau dans les tests.
- **À décider** : décisions 5 et 6.

### Phase 3 : modification et destruction
`system_files` (mkdir, move, copy, trash, batch avec essai à blanc), `system_kill_process`, `system_apps` `quit` avec `force`.
- **Critère testable** : (1) un chemin protégé est refusé **avant** toute demande (test avec un approbateur qui échoue s'il est appelé) ; (2) l'essai à blanc produit exactement le plan appliqué ; (3) `trash` envoie dans la corbeille (élément retrouvé dans la corbeille) et ne supprime jamais définitivement ; (4) `kill` refuse les processus critiques et le processus de Jarod lui-même ; (5) aucun de ces outils n'accepte « Toujours » (ajout à `NEVER_ALWAYS`, une entrée existante ignorée) ; (6) un test de mutation sur le garde, à la manière des autres chantiers de Jarod.
- **À décider** : décisions 7 et 8.

Hors plan : `os_ui` (L, chantier d'interface, §4 n°13) et `system_os` (non applicable).

---

## 7. Décisions produit que cet inventaire suppose

À trancher par Jarod ; aucune n'est dans ses documents.

1. **Quelle version de Jarod ?** Ce plan vise cordis (actif, dernier commit 2026-10-06). Jarod-one est gelé à la révision `2e180305`. Sans objection, rien n'est fait dans Jarod-one.
2. **Intégré ou plugin ?** Un plugin utilisateur ne peut pas lancer de processus (§1). Les outils système sont donc intégrés, ce qui les fait entrer dans les gates, l'empreinte du paquet et la politique de licences.
3. **Audit des outils non dangereux.** Aujourd'hui, seuls les appels `dangerous` sont journalisés. Faut-il journaliser aussi les lectures système (modifier `executeGuardedTool`) ou accepter l'absence de trace ?
4. **Portée hors dossier de travail.** Les outils de Jarod sont confinés au dossier de travail ; les outils système voient toute la machine. Faut-il une liste de chemins protégés comme celle de Herald, ou un réglage par outil ? (Lié au défaut de `system_find_files`, §4 n°4.)
5. **Palier `act`.** Jarod n'a que « demander / ne pas demander ». Volume, mode sombre, veille de l'écran, verrouillage : demander à chaque fois (`dangerous: true`) ou laisser silencieux ? Et `lock_screen` est-il exposé à l'agent ?
6. **`media-control` de Jarod-one.** À remplacer par `system_control` (volume absolu et lu) ou à porter tel quel, comme prévu par `plan.md:83` ?
7. **Destructifs.** Ajouter `system_kill_process`, `system_files trash`, `system_apps quit` à `NEVER_ALWAYS` (recommandé, par cohérence avec `run_shell`), et définir ce que le mode Plan fait de chacun.
8. **Règle Python.** Si l'option A2 est préférée, la règle du 2026-09-28 doit être amendée explicitement. Je recommande B pour ne pas y toucher.

Décisions que cet inventaire suppose sans les trancher :

- **RAG / NPU hors périmètre.** Je suppose que `system_find_files` reste une recherche de fichiers et de contenu par ripgrep ou parcours, **sans passer par le RAG de Jarod** (`rag_search`, embeddings OpenVINO sur NPU, reranker en mode fantôme) : aucun appel au NPU. Si l'utilisateur veut « retrouve ma capture d'hier » en langage naturel, c'est un second chantier qui relierait les deux.
- **Publication des mises à jour.** Les nouveaux outils n'arrivent chez l'utilisateur que par une mise à jour. Or STATE.md:45 liste encore « signature Authenticode » et « dépôt de publication » comme **restes** ; le canal distant `electron-updater` est branché mais aucun dépôt n'est désigné. Un binaire non signé qui lance PowerShell est de plus susceptible de déclencher SmartScreen ou un antivirus : **à vérifier**, je n'ai aucune mesure.
- **i18n.** Les descriptions d'outils et les erreurs de Herald sont en anglais. Jarod a un réglage `language` (fr|en) pour le noyau, distinct de la langue de l'interface (`desktop.json`, `APP_LOCALES` sans « fr »). Les descriptions sont lues par le modèle, les erreurs par le modèle puis l'utilisateur. Le journal d'événements Windows et les libellés `netsh` suivent la langue du système : l'analyse de `wlan` est robuste sur fr/en/de/it (jeux d'essai), pas au-delà.
- **Licence et provenance.** Herald est sous MIT (© 2026 Luke The Dev). Jarod note la provenance de chaque portage (dépôt, révision, licence) ; un port devrait garder l'avis de copyright et citer la révision de Herald (`6e088b6` sur la branche `feature/windows-port`, non publiée).

---

## 8. Ce qui reste à vérifier

- Le transport de chat par tableau de bord de cordis : effectivement inactif à l'exécution ? (§0 n°1)
- Jonctions vues comme liens par `lstat` de Node (§4 n°3) ; boîte de dialogue de `AllDialogs` hors session interactive (§4 n°8).
- Kill forcé d'un vrai processus ; `lock_screen` ; apparence du toast ; Windows 10 et Windows non francophone (déjà listés dans `WINDOWS-PORT-NOTES.md`, « Still not validated »).
- Aucun test n'a été exécuté dans Jarod.

---

## 9. Phase 1 réalisée (2026-10-11) — résultats

Réalisée dans la copie `D:\store\projet\jarod-cordis` (branche `spike/hermes-gateway`, **rien de commité**). Fichiers nouveaux : `packages/plugins/tools/src/system/{ps,scripts,parse,disk,tools}.ts`, `packages/plugins/tools/test/system-read.test.ts`, `packages/plugins/agent/test/system-tools.test.ts`, `licenses/HERALD-OS.md`. Fichiers existants touchés (3 lignes utiles chacun) : `tools/src/registry.ts` (champ `audited` de `ToolDef`), `tools/src/index.ts` (enregistrement et export), `agent/src/agent.ts` (`executeGuardedTool` : `|| tool.audited`).

### Barres du § 6, une par une

| # | Barre | Résultat |
|---|---|---|
| 1 | Un test à PowerShell simulé par outil, vérifiant le JSON du § 4 | **tenu** : 6 outils, analyseurs sur données d'essai (Wi-Fi en anglais, en français et en langue inconnue lue par position), arguments, bornes, erreurs |
| 2 | Un test réel sur Windows 11, données non vides | **tenu** : `system_info`, `top` (CPU et mémoire), `find` (retrouve le processus du test), `port` (retrouve un port ouvert par le test), réseau, applications, journal, plantages |
| 3 | Chaque appel produit une ligne d'audit lisible, même non dangereux | **tenu** par `audited` : vérifié avec le vrai noyau (`automatique`, `ok:true` ou `ok:false`) ; une règle `ask` donne `accordé`, une règle `deny` sur `system` donne `refusé (règle)` ; le mode Plan les laisse tourner |
| 4 | `system_processes top` en moins de 5 s | **tenu** : 1,3 s (CPU), 0,6 s (mémoire) mesurées ; Herald : 9,9 s et 9,1 s |
| 5 | `typecheck` et suites vertes | typecheck vert (tools, agent, cli) ; suites : voir § 9.3 |

### 9.1 Pourquoi 1,3 s au lieu de 9,9 s

La lenteur de Herald n'était pas l'échantillonnage CPU mais la lecture du **propriétaire** de chaque processus (`Win32_Process.GetOwner`, ≈ 200 ms par processus, jusqu'à 40 lignes = 8 s). Mesures ici : `GetOwner` 15 lignes = 3,0 s ; lecture du jeton du processus (`OpenProcessToken`) = 69 ms pour tous les processus ; `tasklist /v` = 56 s (écarté). Le port garde le même contrat de sortie. Écart : le propriétaire est vide pour un processus système auquel un compte ordinaire n'a pas accès (observé : `svchost`, certains `python`).

### 9.2 Décisions prises par défaut (à contester si besoin)

| Décision du § 7 | Prise | Pourquoi |
|---|---|---|
| 1 Version | cordis | seul actif |
| 2 Intégré / plugin | **intégré** (`plugin-tools`) | un plugin utilisateur ne peut pas lancer de processus |
| 3 Audit des lectures | **oui, par un champ `audited` opt-in** de `ToolDef` | ne change rien pour les autres outils ; un seul `else if` dans `executeGuardedTool` |
| 4 Portée hors dossier de travail | liste d'emplacements protégés de Herald, vérifiée **avant** toute lecture, par le nom donné puis par le chemin réel (une jonction ne contourne pas) | seul `system_disk_usage` prend un chemin |
| 8 Règle Python | respectée : tout en TypeScript, PowerShell lancé par `child_process` | |

Conséquence à connaître : la liste protégée refuse aussi `C:\Windows`, `Program Files` et `ProgramData` pour la mesure de disque (même choix que Herald) ; mesurer ces dossiers n'est donc pas possible.

### 9.3 Limites et points ouverts

- `system_find_files` n'est **pas** dans la phase 1 du plan (il y figure au § 4 mais pas dans la liste des 6) ; non porté. Le défaut noté au § 4 n°4 (`scope` non vérifié contre les chemins protégés) reste à trancher avant de le porter.
- `system_disk_usage` sur le dossier personnel entier est allé jusqu'au délai de 90 s sur cette machine (observé dans un premier essai du test d'audit : 95 s au total ; la taille du dossier n'a pas été mesurée) : l'outil le dit (`timed_out`, mesure partielle) mais le défaut `~` est un mauvais défaut ici. À revoir.
- Jonctions : Node les rend bien comme des liens (`lstat`) — **vérifié** avec une vraie jonction (`mklink /J`) ; la question du § 8 est close pour ce point.
- Pas d'interrupteur global (type `available` lié à un réglage) : seule la désactivation par outil de l'application existe (`disabledTools`).
- Descriptions d'outils en français (décision i18n du § 7 non tranchée : un seul jeu de textes).
- Non testé : Windows 10, Windows non francophone (le Wi-Fi n'est testé qu'avec des jeux d'essai), matériel Bluetooth/Wi-Fi (absents de la machine d'essai : `powered_on: null`).

---

## 10. Phases 2 et 3 réalisées (2026-10-11) — résultats

Même copie `D:\store\projet\jarod-cordis`, toujours **rien de commité**. Les fichiers existants touchés sont maintenant : `tools/src/registry.ts` (champs `audited` et `precheck` de `ToolDef`), `tools/src/index.ts` (enregistrement et exports), `agent/src/agent.ts` (`executeGuardedTool` : `|| tool.audited`, et l'appel de `precheck` avant la demande d'accord). Nouveaux : `tools/src/system/{act,destroy,files,proc,prepared,scripts-act}.ts`, `tools/test/system-{act,destroy}.test.ts`. `NEVER_ALWAYS` n'est **pas** modifié (voir 10.3).

### 10.1 Ce qui existe

| Outil | Palier de Jarod | Remarque |
|---|---|---|
| `system_state` | lecture, auditée | volume, mode sombre, écrans |
| `system_control` | `dangerous` (accord à chaque appel) | `set_volume`, `set_dark_mode`, `notify`, `sleep_display` ; **`lock_screen` n'est pas exposé** |
| `system_open` | `dangerous` | app, url, path, reveal, editor, settings ; via l'Explorateur, jamais par un interpréteur |
| `system_quit_app` | `dangerous` | fermeture polie, ou `force=true` |
| `system_files_plan` | lecture, auditée | l'essai à blanc |
| `system_files` | `dangerous`, une demande par lot | mkdir, move, copy, trash, batch ; n'écrase rien ; corbeille avec contrôles |
| `system_kill_process` | `dangerous` | par pid, port ou nom ; polie ou `force=true` |

Non porté : `system_find_files` (voir 9.3), `system_os` (Linux), `os_ui`.

Deux mécanismes ajoutés au noyau, additifs (un outil qui ne les déclare pas ne change pas) :
- **`audited`** : une ligne d'audit pour un outil non dangereux.
- **`precheck`** : appelé après la validation des arguments et **avant** la demande d'accord. S'il lève, l'appel est refusé sans rien demander (journal : `refusé (règle)`) ; le texte qu'il rend remplace la description de l'outil dans la demande d'accord. Les outils des phases 2 et 3 s'en servent pour dire en une phrase ce qui va se passer (« Ouvrir D:\JAROD-OS avec son application par défaut », « Arrêter net node (pid 4242) ») et pour refuser d'emblée un chemin protégé ou un processus critique. `prepared.ts` retient l'empreinte de ce qui a été présenté ; si au moment d'agir elle a changé (un dossier de destination est apparu, un pid a été réattribué), l'exécution est refusée.

### 10.2 Barres du § 6

| Phase | Barre | Résultat |
|---|---|---|
| 2 | (1) aller-retour volume et mode sombre | **tenu, avec réserve** : lire, écrire la **même** valeur, relire — identique. Je n'ai pas changé votre volume ni votre thème pour de bon |
| 2 | (2) arguments en JSON, jamais dans le script (titre avec `'`, `"`, `$()`, `;`, XML) | **tenu** (test sur la notification et sur le nom d'un processus) |
| 2 | (3) l'ouverture d'un `.exe`, `.ps1`, `.lnk` est refusée | **tenu** ; en plus : `file:` refusé, un interpréteur (`cmd`, `powershell`, `wt`, `python`…) refusé comme « application avec laquelle ouvrir », pas d'arguments libres |
| 2 | (4) chaque action auditée avec le palier | **tenu** : `accordé` / `refusé` / `refusé (règle)` / `bloqué (mode Plan)`, vérifié avec le vrai noyau |
| 2 | (5) tableau palier Herald → comportement de Jarod | § 10.1 ; Herald : act = silencieux ; Jarod : accord à chaque appel (levable par une règle `allow`) |
| 3 | (1) un chemin protégé est refusé avant toute demande, approbateur qui échoue s'il est appelé | **tenu** (vrai noyau, `~/.ssh`) |
| 3 | (2) l'essai à blanc = exactement le plan appliqué | **tenu** : même code, avec simulation du lot (un dossier créé par la 1re opération reçoit la 2e) |
| 3 | (3) `trash` envoie à la corbeille (élément retrouvé) et ne supprime jamais définitivement | **tenu sur le chemin normal** : fichier et dossier envoyés, retrouvés dans la vraie corbeille, restaurés. **Réserve** : les refus (disque non fixe, corbeille coupée, stratégie, capacité) n'ont pas pu être exercés : tous vos disques sont fixes et la corbeille est active partout |
| 3 | (4) `kill` refuse les critiques et Jarod lui-même | **tenu** : pid 0, 4, Jarod, son parent, un pid protégé (simulés) ; pid 4, Jarod et l'Explorateur réel (vrais) ; `System` sur le port 80 (simulé) ; Jarod refusé même avec l'approbation automatique (vrai noyau) |
| 3 | (5) aucun de ces outils n'accepte « Toujours » (`NEVER_ALWAYS`) | **NON FAIT** : voir 10.3 |
| 3 | (6) test de mutation sur le garde | **fait** : 15 mutants (6 phase 2, 9 phase 3) ; 13 détectés, 2 survivants (10.4) |

Essais réels : un processus `node` créé par le test arrêté par pid puis par port ; un dossier et un fichier jetables envoyés à la corbeille puis restaurés ; une fenêtre de l'Explorateur ouverte sur `D:\JAROD-OS` puis fermée ; depuis l'interface de Herald (passerelle de l'essai), « quels processus consomment le plus de mémoire ? » (sans accord) puis « ouvre le dossier de travail » (carte d'accord avec la phrase de l'action, puis ouverture réelle). Rien n'a été laissé : dossiers temporaires, corbeille, processus.

### 10.3 Décision qui vous revient : `NEVER_ALWAYS`

Les tests de dérive du dépôt figent la liste à **six outils**, « décision de l'utilisateur » pour `web_fetch` (`desktop/test/approvals-failclosed.test.ts` RN1 ; `agent/test/approval-failclosed.test.ts` RN6). Je n'y ai pas touché. Conséquence : pour `system_files`, `system_kill_process` et `system_quit_app`, le bouton « Toujours autoriser » de l'application de bureau reste possible, et l'approbation automatique (`autoApproveTools`) les exécute sans demande (le garde « pas Jarod lui-même » et les chemins protégés s'appliquent quand même). Par la passerelle de l'essai (Jarod-OS), « Toujours » n'est jamais proposé. Pour trancher : ajouter ces trois noms à `never-always.ts` (avec un motif) et mettre à jour les deux tests de dérive.

### 10.4 Limites, survivants et réserves

- **Mutants survivants** : (a) `force: false` de la copie de repli d'un `move` entre deux disques — défense en profondeur, la collision est déjà un problème du plan, et le chemin de repli ne se déclenche que d'un disque à l'autre, ce que les essais n'ont pas fait ; (b) le contrôle `NukeOnDelete` de la corbeille — non testable sans modifier le registre de votre corbeille.
- **Non exercés pour de vrai** : `set_dark_mode` et `set_volume` avec une valeur différente, `notify` (toast), `sleep_display`, `system_open` vers Réglages/URL/éditeur/application (résolution vérifiée sur cette machine avec un lanceur factice : VS Code via le registre « App Paths », Notepad++, Brave, Paint ; seul le lancement d'un dossier par l'Explorateur a été fait pour de vrai), `move` entre deux disques.
- **Choix de résolution** : `app="notepad"` ouvre Notepad++ (correspondance partielle sur la liste du menu Démarrer, comme chez Herald).
- **Liste noire d'interpréteurs** (`INTERPRETERS`) : faite de bonne foi, donc incomplète par nature ; la vraie barrière est l'accord de l'utilisateur et le fait que l'argument passé est toujours un chemin existant ou une adresse web.
- **Chemins protégés** : `C:\Windows`, `Program Files`, `ProgramData` et leurs enfants sont refusés aussi pour déplacer, copier, mesurer, ouvrir ; tout dossier qui **contient** un emplacement protégé l'est aussi (on ne peut donc pas déplacer ni mettre à la corbeille le dossier personnel entier).
- **Capacité de la corbeille** : un élément plus gros que la capacité réglée (8 Go sur `G:`, 50 Go sur `C:` ici) est refusé plutôt que supprimé ; la mesure d'un gros dossier est limitée à 20 s.
- **Pas d'`os_ui`, pas de `find_files`** (§ 9.3). **Aucun test sur Windows 10 ni hors français.**
