# JAROD-CAPABILITY-AUDIT.md

Audit de capacités de **Jarod-OS** (anciennement Herald OS), dépôt `herald-os`, branche `feature/windows-port`.
Mission : cartographier l'état réel du code pour permettre à un analyste externe de sélectionner **10 dépôts GitHub** apportant des capacités nouvelles ou améliorant des capacités insuffisantes.

**Date de l'audit :** 2026-10-15
**HEAD audité :** `0d3194208edfb69ab9d5b342982b31878ce17a41`
**Règle appliquée :** le code au HEAD est la seule source de vérité. Aucune déduction depuis un nom de fichier, un README ou l'ancien `D:\JAROD-OS\AUDIT-JAROD-OS.md`.
**Aucun fichier source n'a été modifié. Aucun commit, aucun push. Aucun dépôt GitHub n'est recommandé dans ce document.**

---

## 1. Résumé exécutif

Jarod-OS est un **système d'exploitation agentique** construit en trois couches nettement séparées, chacune avec son propre langage et son propre contrat :

| Couche | Technologie | Emplacement | Rôle |
|---|---|---|---|
| **Shell** | Electron 44 + React 19 + TypeScript | `apps/desktop/` | Interface : fenêtres, pages, menu, capture, terminal, thème, IPC |
| **Noyau (passerelle)** | Node 24 + Cordis (IoC) + TypeScript | `jarod-core/` | Agent, outils, fournisseurs, mémoire, RAG, planificateur, MCP, workflows |
| **Bridge système** | Python 3 | `plugins/herald-os-bridge/` | 13 outils d'action sur la machine, garde de permissions à 4 niveaux, journal d'audit |

Ces trois couches ne se parlent **jamais** par import de code : elles se parlent par (a) le protocole HTTP/WS de la passerelle, identique à `hermes serve`, et (b) un socket de contrôle local authentifié par jeton. Le noyau est compilé en **un seul fichier** `gateway.mjs` par esbuild (`jarod-core/scripts/bundle-gateway.mjs:1-8`) et embarqué dans l'installateur (`apps/desktop/package.json`, `extraResources.jarod-core`).

**Ce qui est solide et vérifié :**

- 277 fichiers de test noyau, **2590 tests passés** ; 121 fichiers de test shell, **756 tests passés** ; 185 tests Python du bridge. Tous exécutés pendant cet audit (§12).
- Architecture de plugins **réellement découverte et injectée** (`jarod-core/packages/kernel/src/registry.ts:31-66`, `lifecycle.ts:52-96`), 19 plugins noyau déclarés par `package.json` avec `jarod.plugin` + `order`.
- Garde de permissions **fail-closed** à 4 niveaux (read/act/mutate/destructive) avec chemins protégés refusés **avant** toute demande d'accord (`plugins/herald-os-bridge/bridge/permissions.py:225-244`).
- Chiffrement au repos réel : SQLite via `better-sqlite3-multiple-ciphers` en `chacha20` (`jarod-core/packages/plugins/storage/src/db.ts:552`).
- Deux scripts de vérification de bout en bout passent sur la machine : `verify-windows.ps1` (6/6) et `verify-jarod-os.ps1` (8/8).

**Ce qui est incomplet et le restera sans travail :**

- Les **embeddings et le reranker ne fonctionnent pas dans l'application installée** : leurs workers (OpenVINO/onnxruntime, lancés par `tsx`) sont volontairement exclus du bundle (`jarod-core/scripts/bundle-gateway.mjs:9-13`).
- **Quatre capacités déclarées dans les réglages ne sont pas portées** et l'admettent en commentaire : LSP, webhooks entrants, auto-amélioration, tick d'automatisation (`jarod-core/packages/contracts/src/settings.ts`, champs `lsp`, `webhooks`, `autoImprovement`, `automationTickMs`).
- **Aucun OAuth pour MCP** (recherche `oauth` sur `jarod-core/packages/plugins/mcp/src/` : zéro occurrence).
- **Aucune automatisation d'interface Windows** (UIAutomation / pywinauto) : le bridge sait lancer, tuer, énumérer, ouvrir — pas piloter un contrôle d'une fenêtre tierce.
- Différenciation de l'arrière-plan : le paquet AppX est produit **non signé**, le DMG macOS est `sign: false`.

**Le point le plus important pour la suite :** Jarod-OS possède déjà **cinq contrats d'écosystème explicites** (`jarod-core/packages/contracts/src/ecosystem.ts`) — embeddings denses, embeddings creux, index vectoriel, reranker, parseur de documents et décisions typées — conçus exactement pour brancher un moteur externe **sans fork** : « Un moteur indisponible ou hors budget DÉGRADE (repli sur la pile actuelle), il ne bloque jamais » (`ecosystem.ts:24-25`). C'est le seam d'intégration le plus mûr du projet, et il est aujourd'hui **inutilisé pour trois des cinq contrats**.

---

## 2. État exact des dépôts

### 2.1 Dépôt principal

| Champ | Valeur |
|---|---|
| **Chemin local** | `C:\Users\San\herald-os` |
| **Branche active** | `feature/windows-port` |
| **Commit HEAD** | `0d3194208edfb69ab9d5b342982b31878ce17a41` |
| **Message HEAD** | `docs(handoff): translations at 71, and the indentation trap` |
| **Date HEAD** | 2026-10-14 23:04:43 +0200 |
| **État git** | 1 fichier non suivi : `"audit jarod15-10.txt"` (le brief de mission, pas du code) |
| **Remote** | `origin` → `https://github.com/PAVADI234/herald-os` (fetch et push) |
| **Avance vs origin/main** | 107+ commits (déclaré dans `HANDOFF.md`) ; **rien n'a été poussé** |

Vérification du bundle de sauvegarde `D:\jarod-os-2026-10-14.bundle` : `HEAD` du bundle = `0d3194208edfb69ab9d5b342982b31878ce17a41`, **identique** au HEAD du dépôt de travail. Le bundle est donc à jour et constitue une sauvegarde valide de l'état audité.

### 2.2 Gestionnaire de paquets, workspaces, runtimes

| Élément | Valeur constatée |
|---|---|
| **Workspaces (racine)** | `apps/*`, `packages/*` — `package.json:19-22` |
| **Gestionnaire racine** | npm 11.19.0 (`package-lock.json` présent) |
| **Gestionnaire noyau** | pnpm **12.6.0** — déclaré `packageManager` dans `jarod-core/package.json:7`, `pnpm-lock.yaml` présent |
| **Node** | v26.7.0 sur la machine ; `engines.node: ">=22.12.0"` (racine) et `">=22"` (noyau) |
| **Workspaces noyau** | `jarod-core/pnpm-workspace.yaml` → `packages/*`, `packages/plugins/*` |
| **Compilation noyau** | esbuild 0.28.2 → un seul `gateway.mjs`, cible `node24` |

### 2.3 Scripts déclarés (détectés, non inventés)

**Racine** (`package.json:38-53`) :
`bootstrap`, `sync-upstream`, `dev`, `build`, `typecheck` (tous workspaces), `test` (tous workspaces), `lint` (biome), `typecheck:core` (`pnpm --dir jarod-core -r typecheck`), `test:core` (`pnpm --dir jarod-core -r test`), `test:bridge` (`node scripts/run.mjs test-bridge`), `dist:mac`, `dist:win`.

**Shell** (`apps/desktop/package.json:13-28`) :
`dev`, `dev:renderer`, `dev:electron`, `build`, `start`, `bundle:core`, `bundle:pinokio`, `typecheck` (deux projets tsc), `test` (vitest), `dist:mac`, `dist:linux`, `dist:win`, `i18n:report`.

**Noyau** (`jarod-core/package.json:11-20`) :
`test`, `typecheck`, `skills:count`, `check:ignored`, `decisions:index`, `check:staged`, `bundle:gateway`.

**Vérification** : `scripts/verify-windows.ps1`, `scripts/verify-windows.test.ps1`, `jarod-core/scripts/verify-jarod-os.ps1`.

### 2.4 Architecture des packages

```
herald-os/ (racine, npm workspaces)
├── apps/desktop/                  @herald-os/desktop — le shell Electron/React
│   ├── electron/                  processus principal : backend, IPC, plugins, thème, capture, wm
│   ├── preload/index.ts           surface IPC typée exposée au renderer (391 lignes)
│   ├── src/                       renderer React (commands/, features/, components/, store/)
│   └── shared/                    types IPC partagés main↔renderer
├── packages/hermes-client/        @herald-os/client — client de la passerelle
├── jarod-core/                    LE NOYAU (copie indépendante de jarod-cordis)
│   ├── packages/contracts/        @jarod/contracts — types, schémas Zod, écosystème
│   ├── packages/kernel/           @jarod/kernel — JarodApp, découverte et cycle de vie
│   ├── packages/bridge/           @jarod/bridge — handlers de pilotage, sans Electron
│   ├── packages/cli/              @jarod/cli — CLI + passerelle (gateway/) + serveur MCP
│   └── packages/plugins/          19 plugins @jarod/plugin-*
├── plugins/herald-os-bridge/      bridge système PYTHON (host/, permissions, audit, tools)
├── pinokio-runtime/               hôte Pinokio (host.cjs) embarqué au packaging Windows
├── packaging/arch/                empaquetage Arch Linux
├── linux/                         provisionnement de l'image Linux (niri, omakase, plymouth)
└── upstream/hermes-agent/         copie figée de Hermes Agent (sha épinglé)
```

**Les 19 plugins du noyau**, avec leur ordre de chargement déclaré :

| Ordre | Plugin | Rôle |
|---|---|---|
| 10 | `storage` | SQLite chiffré, clés dérivées, migrations |
| 20 | `scheduler` | planifications, jobs, webhooks |
| 30 | `permissions` | garde unifié fail-closed |
| 35 | `embeddings` | embeddings (OpenVINO, worker isolé) |
| 40 | `rag` | index vectoriel, pièces jointes, coffre, parseurs |
| 50 | `skills` | skills et hub |
| 60 | `llm` | fournisseurs, routeur, moteur llama.cpp, HF |
| 66 | `voice` | STT, TTS, wake word |
| 70 | `tools` | registre d'outils, navigateur, recherche d'outils |
| 75 | `mcp` | serveurs MCP (stdio + HTTP) |
| 80 | `agent` | boucle agentique, sous-agents, sessions |
| 85 | `gateways` | Telegram, Discord, Slack, e-mail, WhatsApp |
| 90 | `workflows` | workflows durables, runner isolé |
| — | `automation`, `kanban`, `memory`, `persona`, `updates`, `vision` | (ordres respectifs présents dans chaque `package.json`) |

### 2.5 Shell et noyau : même dépôt, dépôts séparés, ou embarqués ?

**Réponse sans ambiguïté : même dépôt git, deux projets de paquets distincts, embarqués à la compilation.**

- **Même dépôt** : `apps/desktop/` et `jarod-core/` vivent dans le même clone, mais **ne partagent aucun workspace npm** — la racine déclare `apps/*` et `packages/*` (pas `jarod-core/*`), et `jarod-core/` a son **propre** `pnpm-workspace.yaml` (`jarod-core/pnpm-workspace.yaml`) et son propre `pnpm-lock.yaml`. C'est un **monorepo à deux gestionnaires de paquets**.
- **Dépôts séparés ?** Non. Le noyau est décrit comme « Copie indépendante issue de jarod-cordis » (`jarod-core/package.json:6`) — une **copie**, pas un sous-module : `jarod-core/.git` n'existe pas.
- **Embarqué au packaging** : oui, et c'est explicite. `apps/desktop/package.json` `extraResources` copie `../../jarod-core/dist/gateway` → `jarod-core` **et** `../../jarod-core/dist/gateway/node_modules` → `jarod-core/node_modules`. Le shell le retrouve par `resolveJarodCore()` (`apps/desktop/electron/backend/jarod-core.ts:44-83`), qui cherche `<resourcesPath>/jarod-core/gateway.mjs`.
- **Lien passerelle** : le shell **lance le noyau comme un processus enfant** (`apps/desktop/electron/backend/manager.ts`) et lui parle par HTTP/WS avec le **même protocole que `hermes serve`**. Le commentaire du seam est explicite : « It answers the same protocol as `hermes serve`, so the shell talks to it the same way. Hermes stays available as an option: HERALD_OS_BACKEND=hermes, or no core in the build. » (`apps/desktop/electron/backend/jarod-core.ts:6-11`).

**Conséquence architecturale majeure : Hermes est un backend de repli de premier rang.** `selectBackend()` (`jarod-core.ts:85-92`) rend `jarod` si un noyau est présent dans le build, sinon `hermes`, et `HERALD_OS_BACKEND=jarod|hermes` force le choix. Le shell fonctionne donc **sans** le noyau Jarod.

### 2.6 Le backend « Hermes » et l'upstream figé

- `upstream/hermes-agent/` est une copie de `NousResearch/hermes-agent`, **épinglée** : `UPSTREAM.lock` → `sha=f97608f178d1ffeca59860195ab7da295f7c8e5f`. Le lock précise : « Only apps/shared/src is compiled into Herald OS; the Python runtime comes from the user's Hermes install ($HERMES_HOME/hermes-agent) and is updated with `hermes update` » (`upstream/UPSTREAM.lock:1-5`).
- Le runtime Hermes réellement installé sur la machine a été observé par la vérification : `Hermes Agent v0.22.0 (2026.9.24) · stable · local e06df9c2eae6` (sortie de `verify-windows.ps1`).

---

## 3. Architecture actuelle

### 3.1 Flux principal

```
Utilisateur
  │  événements clavier / souris / voix
  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ SHELL — Electron 44 (apps/desktop)                                       │
│                                                                          │
│  renderer React (src/)                                                   │
│    src/features/**, src/commands/** (registre de commandes)              │
│    src/store/** (nanostores)                                             │
│      │                                                                   │
│      │  window.heraldOS.*  ← surface typée, contextBridge                │
│      ▼                                                                   │
│  preload/index.ts:1-391   exposeInMainWorld('heraldOS', api):391         │
│      │                                                                   │
│      │  ipcRenderer.invoke / .send / .on   (canaux déclarés dans         │
│      ▼                                      shared/ipc.ts — const IPC)    │
│  processus principal electron/main.ts                                    │
│    registerCoreIpc():246  →  ipcMain.handle(...)                        │
│    BackendManager:107     →  démarre/arrête le noyau                     │
│    PluginHost:130         →  plugins widget (herald-plugin://)           │
│    OsControlServer:174    →  socket de contrôle local, jeton             │
│      │                                                                   │
│      │  HTTP + WebSocket (127.0.0.1, port éphémère) + jeton              │
│      ▼                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
         │
         │  même protocole que `hermes serve`
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ NOYAU — gateway.mjs (jarod-core compilé en un fichier)                   │
│                                                                          │
│  packages/cli/src/gateway/server.ts   (53 Ko) — serveur HTTP/WS          │
│  packages/cli/src/gateway/ws.ts       — flux temps réel                  │
│  packages/cli/src/gateway/main.ts     — point d'entrée, profil,          │
│                                          garde JAROD_HOME / --real-profile│
│      │                                                                   │
│      ▼                                                                   │
│  JarodApp extends Context  (packages/kernel/src/app.ts:8)                │
│      │                                                                   │
│      │  Cordis : injection par service, `ctx.<nom>`                       │
│      ▼                                                                   │
│  start() — lifecycle.ts:52                                               │
│    discoverPlugins()  registry.ts:38   → lit jarod.plugin + order        │
│    loadPlugin()       registry.ts:59   → import() dynamique              │
│    app.plugin(...)    → fibres Cordis, échec = échec du démarrage        │
│      │                                                                   │
│      ├── ctx.llm       (plugin-llm, order 60)   → modèle                 │
│      ├── ctx.tools     (plugin-tools, order 70) → outils                 │
│      ├── ctx.agent     (plugin-agent, order 80) → boucle agentique       │
│      ├── ctx.rag       (plugin-rag, order 40)   → mémoire documentaire   │
│      ├── ctx.memory    (plugin-memory)          → mémoire                │
│      ├── ctx.mcp       (plugin-mcp, order 75)   → serveurs MCP           │
│      └── … 19 plugins                                                    │
│      │                                                                   │
│      ▼                                                                   │
│  appel d'outil                                                           │
│      │                                                                   │
│      ▼                                                                   │
│  GARDE UNIFIÉ  ctx.permissions.gate(...)  — plugin-permissions           │
│    règles utilisateur → « déclaré au registre → allow » → `* → deny`     │
└──────────────────────────────────────────────────────────────────────────┘
         │
         │  outils du bridge exposés via le REGISTRE HERMES
         │  (13 outils herald_os, voir §3.3) — PAS par IPC noyau
         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ BRIDGE SYSTÈME — Python (plugins/herald-os-bridge)                       │
│                                                                          │
│  tools.py:83   _guarded()  → authorize() puis execute() puis audit       │
│  permissions.py:225  authorize()                                        │
│     1. protected_path() — refus AVANT toute demande (permissions.py:229) │
│     2. policy.mode(tier) — allow / confirm / deny                       │
│     3. _confirm() → tools.approval.request_tool_approval (permissions:214)│
│      │                                                                   │
│      ▼                                                                   │
│  host() — adaptateur par OS (host/windows.py, host/winps.py, search.py)  │
│      │                                                                   │
│      ▼                                                                   │
│  WINDOWS  (PowerShell, taskkill, winget, presse-papiers, réseau…)        │
│      │                                                                   │
│      ▼                                                                   │
│  audit.record()  audit.py:33                                             │
│     → <HERMES_HOME>\herald-os\audit.jsonl  (1 ligne JSON par appel)      │
│     → rotation à 5 Mio  (audit.py:14, :51)                               │
│     → arguments sensibles caviardés  (audit.py:16, :22)                  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Frontières : protocole, authentification, erreurs, streaming, annulation, timeouts, reprise, audit, contrat

| # | Frontière | Protocole | Direction | Authentification | Format d'erreur | Streaming | Annulation | Timeout | Reprise | Audit | Contrat |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **F1** | Utilisateur → renderer | DOM / IPC de Chromium | entrant | aucune (session locale) | Error Boundary React (`src/components/error-boundary.tsx`) | n/a | n/a | n/a | recharge du renderer (`recovery.ts`) | non | `src/shared/ipc.ts` |
| **F2** | renderer → preload | `contextBridge` (surface figée) | bidirectionnel | aucune (contexte isolé) | exception JS remontée | `onXxx(listener)` → `Unsubscribe` | retrait du listener | n/a | re-render | non | `preload/index.ts:1-391` |
| **F3** | preload → main | `ipcRenderer.invoke` / `.send` / `.on` | bidirectionnel | `senderFrame` validé côté main | rejet de la promesse | `IPC.backendState`, `IPC.ws`… | `AbortSignal` quand passé | selon handler | `backend.restart()` | partiel (`log('main', …)`) | `src/shared/ipc.ts` (const `IPC`) |
| **F4** | main → noyau | **HTTP + WebSocket** sur `127.0.0.1` | bidirectionnel, main initie | **jeton** dans la requête | code HTTP + corps JSON | **WS** (`gateway/ws.ts`) | `AbortSignal` (contrat outil) | par requête | `restart()` + relance | `gateway.json` écrit 0600 + `icacls` | `packages/cli/src/gateway/protocol.ts` (13,6 Ko) |
| **F5** | main ↔ bridge | **socket de contrôle local**, `tcp://127.0.0.1:<port>` sous Windows | bidirectionnel | **jeton** `osControlToken()`, comparé par `sameToken()` | `{ ok:false, error }` | non | non | attente ≤ 3 s au démarrage (`main.ts:551`) | relance du serveur | `log('audit', …)` | `shell/os-control.ts` |
| **F6** | noyau → modèle | HTTP `POST /v1/chat/completions` (OpenAI-compat) ou SDK Anthropic | sortant | **clé API** (`secret.ts`) | erreur du fournisseur + disjoncteur | **SSE** | `AbortSignal` | par fournisseur | **disjoncteur** : 3 échecs → 60 s d'exclusion (`routing.ts:30`) | `usage.ts` | `contracts/src/llm.ts` |
| **F7** | noyau → outils | appel de fonction en processus | interne | garde de permissions | `isError` sur le message | non | `tctx.signal` | par outil | `checkpoints` (`/rewind`) | `events` Cordis | `packages/plugins/tools/src/` |
| **F8** | outils → bridge | **registre d'outils Hermes** (63 outils `herald_os`) | noyau → Python | `authorize()` du bridge | JSON `{ok:false, error}` | non | non | `_OS_TIMEOUT_SHORT` 60 s / `_OS_TIMEOUT_LONG` 1200 s (`tools.py`) | non | **`audit.jsonl`** | `plugins/herald-os-bridge/plugin.yaml` |
| **F9** | bridge → Windows | `subprocess` / PowerShell / API Win32 via `host/windows.py` | sortant | ACL du processus utilisateur | exception → résultat d'outil | non | `taskkill /T /F` | paramétrable | non | hérité de F8 | `bridge/host/base.py` |
| **F10** | main → plugins widget | **protocole personnalisé `herald-plugin://`** | bidirectionnel | vérification de permission côté main | `pluginCall` rejette | non | non | non | `plugins.watch()` | `plugins.onChanged` | `electron/plugins/host.ts` |
| **F11** | services externes → noyau | webhooks / gateways (Telegram, Discord, Slack, e-mail, WhatsApp) | entrant | liste blanche d'identifiants + signature | gérée par `plugin-gateways` | non | non | poll (`email.pollSeconds`) | reconnexion | `events` | `contracts/src/settings.ts` (sections `telegram`, `discord`, `slack`, `email`, `whatsapp`) |
| **F12** | noyau → MCP | **stdio** et **HTTP** | sortant | **aucun OAuth** (voir CAP-27) | erreur du serveur MCP | non | non | non | `mcp.sync()` | non | `contracts/src/settings.ts` (`McpServerConfig`) |

### 3.3 Flux secondaires

**Mémoire et RAG.** `plugin-storage` (order 10) ouvre SQLite chiffré ; `plugin-rag` (order 40) fournit `ctx.rag` avec index vectoriel, pièces jointes chiffrées, coffre de secrets et parseurs (`jarod-core/packages/plugins/rag/src/index.ts:1-7`). L'index vectoriel vit **dans la même base**, délibérément : « It lives in this database on purpose: the file is already encrypted at rest » (`storage/src/db.ts:171`). Un mode **fantôme** (`VectorShadow`) permet de faire tourner un moteur concurrent sans l'utiliser (`rag/src/index.ts:47-49`).

**Sous-agents.** Outil `delegate_task` enregistré par `plugin-agent` : « Confie une tâche de recherche ou d'analyse autonome à un sous-agent (outils en lecture seule, contexte séparé) » (`packages/plugins/agent/src/index.ts`, enregistrement de `delegate_task`). Le fichier `subagents.ts` existe et est exporté.

**Planificateur et automatisations.** `plugin-scheduler` (order 20) ; les outils cron sont enregistrés par `plugin-agent` via `cronTools(ctx.scheduler, …)`. Les webhooks (`WebhookRunner`) existent **dans le code du plugin** mais **rien ne les démarre** — voir CAP-22.

**Fournisseurs locaux/cloud.** `ProviderRouter` (`llm/src/providers.ts:23`) + `RoutingService` (chaîne de repli + disjoncteur) + `Router`. Modules dédiés : `lmstudio.ts`, `llama-server.ts`, `engine.ts`, `local.ts`, `local-models.ts`, `huggingface.ts`, `gguf-fit.ts`, `openai.ts`, `anthropic.ts`, `runtimes.ts`. **Aucun fichier `ollama.ts` ni `vllm.ts`** : Ollama est joignable par `catalogLocalModels('ollama')` (`preload/index.ts`) mais n'a pas de module de fournisseur propre.

**Voix.** `plugin-voice` (order 66) : `capture.ts`, `speech.ts`, `voice.ts`, `wakeword.ts`, `wakeword-isolated.ts`, `wakeword-worker.cjs`, `whisper-server.ts`, `priority.ts`. Le worker de wake word est **explicitement copié** dans le bundle (`bundle-gateway.mjs`, liste `WORKERS` : `["voice","wakeword-worker.cjs"]`).

**Vision.** `plugin-vision` : un seul fichier `vision.ts`. 1 seul test.

**Navigateur.** Contrat `BrowserPort` dans `contracts/src/browser.ts:26-48` (types seulement, sans dépendance croisée), implémenté côté Electron par `AgentBrowser implements BrowserPort` (`apps/desktop/electron/agent-browser/agent-browser.ts:279`). Liste **fermée** de touches autorisées (`contracts/src/browser.ts:51-52`).

**MCP.** `McpManager` (`mcp/src/mcp.js`), injecté `["storage","tools"]`, démarrage non bloquant : « MCP servers can be slow to boot: don't block startup on them » (`mcp/src/index.ts`).

**Fichiers et documents.** `plugin-rag` : `chunker.ts`, `parser-builtin.ts`, `parser-fallback.ts`, `parser-route.ts`, `parser-worker.ts`, `zip.ts`. Le noyau a aussi un serveur MCP **sortant** (`packages/cli/src/mcp-server.ts`) et un mode ACP (`acp-agent.ts`, `acp-events.ts`, `acp-permission.ts`) — **compatibilité Claude Code**.

**Applications locales.** `pinokio-runtime/host.cjs` + `PinokioService` (`electron/pinokio/service.ts`), démarré à la demande (ADR-022, `main.ts:108-113`).

**Notifications et demandes d'accord.** Côté shell : `NotificationDaemon` (sert `org.freedesktop.Notifications`), `ShellTray`, historique de notifications persistant. Côté bridge : `permissions.py:214` `_confirm()` délègue à `tools.approval.request_tool_approval` — « so Jarod-OS renders the same approval card for a bridge action as for a shell command » (`permissions.py:8-10`).

---

## 4. Capacités fonctionnelles vérifiées

État « Fonctionnelle et vérifiée » = code présent **et** test exécuté **et** passé pendant cet audit.

| Domaine | Capacité | Preuve `fichier:ligne` | Test exécuté |
|---|---|---|---|
| A. Modèles | Sélection de modèle persistante, sans secret dans la config brute | `packages/plugins/llm/src/providers.ts:23` | `verify-jarod-os.ps1` 8/8 (PASS) |
| A. Modèles | Découverte des modèles LM Studio, filtrage des embeddings | `llm/src/lmstudio.ts`, `llm/src/local-models.ts` | `verify-jarod-os.ps1` (PASS « pas de Whisper ») |
| A. Modèles | Chaîne de repli avec disjoncteur (3 échecs → 60 s) | `llm/src/routing.ts:30,77,85` | `plugin-llm` 21 fichiers / 292 tests |
| A. Modèles | Moteur llama.cpp : installation, préréglages, estimation GGUF | `llm/src/engine.ts`, `gguf-fit.ts` | `plugin-llm` 292 tests |
| A. Modèles | Téléchargement Hugging Face | `llm/src/huggingface.ts`, `hf-transfer.ts` | `plugin-llm` 292 tests |
| B. Agent | Boucle agentique et runtime de tours | `plugins/agent/src/agent.ts`, `runtime.ts` | `plugin-agent` 41 fichiers / 256 tests |
| B. Agent | Sous-agents à outils restreints | outil `delegate_task` dans `plugin-agent/src/index.ts` | `plugin-agent` 256 tests |
| B. Agent | Compaction du contexte, à la demande du modèle | outil `compact` dans `plugin-agent/src/index.ts` | `plugin-agent` 256 tests |
| B. Agent | Garde anti-boucle | `plugins/agent/src/loop-guards.ts` | `plugin-agent` 256 tests |
| B. Agent | Verrou de profil (un seul processus vivant par profil) | `plugins/agent/src/runtime-lock.ts`, `app.ts:8-13` | `plugin-agent` 256 tests |
| C. Mémoire | Base chiffrée `chacha20`, migration en place | `storage/src/db.ts:552,566,682` | `plugin-storage` 7 fichiers / 52 tests |
| C. Mémoire | Fuite de contenu vers disque (`spill`) | `plugins/agent/src/spill.ts` | `plugin-agent` 256 tests |
| C. RAG | Segmentation, parseurs routés, repli | `rag/src/chunker.ts`, `parser-route.ts`, `parser-fallback.ts` | `plugin-rag` 22 fichiers / 164 tests |
| C. RAG | Coffre de secrets avec liste de domaines | `rag/src/vault.ts` ; `contracts/src/settings.ts` (`VaultEntry`) | `plugin-rag` 164 tests |
| D. Windows | 13 outils système exposés au registre Hermes | `plugins/herald-os-bridge/plugin.yaml:10-22`, `tools.py:1093` | `verify-windows.ps1` : « toolset herald_os: 13 tools » |
| D. Windows | Journal d'audit réellement écrit | `audit.py:33` | `verify-windows.ps1` : `tool=system_info tier=read decision=allowed ok=True` |
| D. Windows | Refus des processus critiques | `plugins/herald-os-bridge/bridge/host/windows.py` | `test-bridge` 185 passés |
| D. Windows | Recherche de fichiers bornée (rg puis parcours borné) | `bridge/host/search.py` | `test-bridge` 185 passés |
| E. Navigateur | Port navigateur isolé, 14 touches fermées | `contracts/src/browser.ts:26-52`, `electron/agent-browser/agent-browser.ts:279` | 121 fichiers shell / 756 tests |
| E. Navigateur | Refus d'hôtes locaux (anti-SSRF/DNS rebinding) | `agent-browser/agent-browser.ts:139,310` | 756 tests shell |
| F. Voix | Wake word avec worker isolé et embarqué | `bundle-gateway.mjs` liste `WORKERS`, `voice/src/wakeword-isolated.ts` | `plugin-voice` 9 fichiers / 71 tests |
| F. Voix | Priorité de voix (arbitrage TTS/RAG) | `contracts/src/index.ts:14` (`VoicePriority`), `voice/src/priority.ts` | `plugin-voice` 71 tests |
| G. Applications | Catalogue d'installation et lancement | `electron/catalog/`, `src/features/applications/app-catalog.ts` | `app-catalog.test.ts` dans les 756 |
| G. Applications | Runtime Pinokio embarqué (Windows) | `apps/desktop/package.json` `extraResources` → `pinokiod` | `pinokio-runtime/host.cjs` + 14 fichiers shell |
| H. Extensions | Registre de plugins du noyau, ordre déterministe, échec bruyant | `kernel/src/registry.ts:38-66`, `lifecycle.ts:52-96` | `packages/kernel` 2 fichiers / 14 tests |
| H. Extensions | Mode « plugins regroupés » pour l'application empaquetée | `kernel/src/registry.ts:31` `setBundledPlugins` | `packages/kernel` 14 tests |
| H. Extensions | Serveur MCP sortant | `packages/cli/src/mcp-server.ts` | `packages/cli` 42 fichiers / 448 tests |
| H. Extensions | Compatibilité Claude Code (ACP) | `gateway/acp-agent.ts`, `acp-permission.ts` | `packages/cli` 448 tests |
| H. Extensions | JSON-RPC sur stdio | `gateway/jsonrpc-stdio.ts` | `packages/cli` 448 tests |
| I. Sécurité | Chemins protégés refusés avant demande d'accord | `permissions.py:225-233`, `builtin_protected` `:88-92` | `test-bridge` 185 passés |
| I. Sécurité | « destructive » ne peut jamais être pré-autorisé | `permissions.py:117-119` + clé unique par appel `:238-240` | `test-bridge` 185 passés |
| I. Sécurité | Caviardage des secrets à l'audit | `audit.py:16,22` | `test-bridge` 185 passés |
| I. Sécurité | Rotation du journal d'audit à 5 Mio | `audit.py:14,51` | `test-bridge` 185 passés |
| I. Sécurité | Schéma privilégié `herald-plugin://` | `electron/main.ts:92` | 756 tests shell |
| I. Sécurité | Instance unique verrouillée | `electron/single-instance.ts`, `main.ts:65` | `single-instance.test.ts` |
| I. Sécurité | Confinement des écritures du shell (option `docker`) | `contracts/src/settings.ts` (`ShellPolicy`, `DockerOptions`) | `packages/contracts` 31 tests |
| J. Qualité | Typecheck shell et noyau sans erreur | — | `tsc` × 2 et `pnpm -r typecheck` → **exit 0** |
| J. Qualité | Vérification Windows de bout en bout | `scripts/verify-windows.ps1` | **6/6 PASS** |
| J. Qualité | Vérification du sélecteur de modèles bout en bout | `jarod-core/scripts/verify-jarod-os.ps1` | **8/8 PASS** |
| J. Qualité | Audit matériel/logiciel de la machine | `electron/setup/audit.ts` (11 tests) | `audit.test.ts` dans les 756 |
| J. Qualité | i18n (fr + en, rapport de couverture) | `apps/desktop/src/locales/`, `scripts/i18n-report.mjs` | 756 tests shell |

---

## 5. Capacités partielles

| Domaine | Capacité | Ce qui existe | Ce qui manque | Preuve `fichier:ligne` |
|---|---|---|---|---|
| A. Modèles | **Embeddings dans l'application installée** | Plugin complet, worker isolé, 98 tests passés | `openvino-node`, `openvino-genai-node`, `onnxruntime-node` sont dans la liste `ABSENT` du bundle → **non disponibles dans l'app installée** | `jarod-core/scripts/bundle-gateway.mjs:9-13` |
| A. Modèles | **Reranker** | Contrat typé + wirer + rapport fantôme | Binaire NPU non embarqué ; contrat non branché par défaut | `contracts/src/ecosystem.ts` (contrat reranker), `gateway/wire-reranker.ts` (16,8 Ko, non bundlé) |
| A. Modèles | **Ollama / vLLM comme fournisseurs** | `catalogLocalModels('ollama')` côté shell | **Aucun module `ollama.ts` ni `vllm.ts`** ; seul LM Studio et llama.cpp ont un module | `apps/desktop/preload/index.ts` (catalog.localModels) ; liste de `llm/src/` |
| A. Modèles | Coût et usage | `usage.ts` (gateway), `BudgetLimits` | Plafond par conversation, non agrégé par fournisseur | `contracts/src/settings.ts` (`SessionBudgetConfig`) |
| B. Agent | Workflows durables | `plugin-workflows` (order 90), `runner.cjs` embarqué | 3 fichiers de test seulement pour tout le domaine | `jarod-core/scripts/bundle-gateway.mjs` (WORKERS: workflows/runner.cjs) |
| B. Agent | Compensation après échec partiel / idempotence | `checkpoints` (avant édition), `jobs` (statuts pending/running/done/failed) | Pas de transaction compensatoire ni de reprise idempotente visible | `contracts/src/index.ts:86` (`JobStatus`) |
| C. RAG | Index vectoriel | `VectorIndex` en mémoire + `Turbovec` (sidecar externe) | L'index en mémoire est **le** défaut ; `turbovec` est un chemin explicite jamais deviné | `rag/src/index.ts:47-49`, `rag/src/vector-index.ts` |
| C. RAG | Isolation par profil | Un profil = un dossier de données = une base | L'isolation est **physique**, pas dans le schéma : pas d'ACL de collection visible | `contracts/src/ecosystem.ts` (allowlist décrite), `agent/src/runtime-lock.ts` |
| D. Windows | **UI Automation** | `system_apps` (quitter), `system_open` (lancer), `system_control` | Aucun pilotage de contrôle de fenêtre tierce (UIAutomation / pywinauto) | `tools.py:1093-1107` (liste des 13 outils) |
| D. Windows | Registre, tâches planifiées, services | Adaptateurs génériques + PowerShell | Pas d'outil dédié par domaine | `plugins/herald-os-bridge/bridge/host/windows.py` |
| D. Windows | Alimentation | `set_power_profile`, `sleep_display`, `lock_screen` | Pas de mise en veille prolongée / redémarrage planifié | `tools.py:653-740`, `SYSTEM_OS_TIERS:818` |
| E. Navigateur | Profils et cookies | `browserPersistent` (session gardée, confirmation native) | Pas de gestion multi-profils ; « Oublier » efface tout | `contracts/src/settings.ts` (`browserVisible`, `browserPersistent`) |
| E. Navigateur | Reprise après modification du DOM | `BrowserSnapshot` relu après chaque action ; `wait(seconds, text)` | **Index d'éléments instable** : `BrowserElement.index` est un ordinal, pas un identifiant durable | `contracts/src/browser.ts:12-19,44` |
| E. Navigateur | Playwright/CDP | Implémentation Electron **maison** | Recherche `playwright|puppeteer` dans `agent-browser/` et `plugin-tools/src` : **zéro occurrence** | `electron/agent-browser/agent-browser.ts:279` |
| F. Voix | STT en flux | Capture + `whisper-server.ts` | Le streaming audio passe par un WebSocket dédié ; pas de VAD documenté | `voice/src/capture.ts`, `whisper-server.ts` |
| F. Voix | Identification du locuteur | — | Absente | `voice/src/` (8 fichiers, aucun speaker-id) |
| F. Voix | Suppression du bruit | — | Absente | `voice/src/` |
| F. Vision | Analyse d'écran | `plugin-vision` (1 fichier) + capture shell | **1 seul test** pour tout le domaine ; la description d'image est déléguée à un modèle | `packages/plugins/vision/src/vision.ts` |
| G. Applications | Environnements isolés | `ShellPolicy.environment: "local" | "docker"` | Défaut `local` ; Docker optionnel, non testé ici | `contracts/src/settings.ts` (`DEFAULT_SHELL_POLICY`) |
| G. Applications | Gestionnaire de runtimes | `runtimes.ts` (sonde), `catalog` | Pas de `uv`/`conda` visible côté Jarod (Pinokio gère son propre runtime) | `llm/src/runtimes.ts`, `pinokio-runtime/host.cjs` |
| G. Applications | Vérification de provenance | Catalogue local + `plugin-updates` (31 tests) | Pas de vérification de signature de paquet d'installation | `plugins/updates/src/` |
| H. Extensions | Permissions par extension | `pluginTrust` par empreinte de contenu | Portée aux plugins **Hermes**, pas aux plugins widget du shell | `contracts/src/settings.ts` (`PluginTrustEntry`) |
| H. Extensions | Signature des extensions | — | Aucune | `plugins/updates/src/` |
| H. Extensions | Catalogue MCP | Ajout serveur par ajout manuel | Pas de catalogue distant | `contracts/src/settings.ts` (`McpServerConfig`) |
| I. Sécurité | Signature du paquet | `asar: true`, `asarUnpack` | AppX **non signé**, DMG `sign: false` | `apps/desktop/package.json` (`mac.dmg.sign`, `win.target`) |
| I. Sécurité | Mises à jour signées | `plugin-updates` + canal stable/beta | Pas de signature de mise à jour observée | `contracts/src/settings.ts` (`updates`) |
| J. Qualité | Observabilité | `log.ts`, `logTail`, `crash/watch.ts`, `events/bus.ts` | OpenTelemetry absent ; pas de métriques | `electron/log.ts`, `electron/crash/watch.ts` |
| J. Qualité | CI multi-OS | `windows-latest` ajouté aux matrices (déclaré) | **Aucun répertoire `.github/workflows` trouvé à la racine** — voir §9 D-07 | `HANDOFF.md` |
| J. Qualité | Tests de mutation | `stryker` présent dans `D:/Jarod-one`, **pas** dans `herald-os` | Absent de ce dépôt | — |

---

## 6. Capacités absentes

Recherchées avec **plusieurs termes** dans le code du HEAD ; liste des termes employés indiquée pour chaque ligne.

| # | Capacité absente | Termes recherchés | Preuve de l'absence |
|---|---|---|---|
| CAP-01 | **Automatisation d'interface Windows** (piloter un bouton/champ d'une application tierce) | `UIAutomation`, `uiautomation`, `pywinauto`, `IUIAutomation`, `pyautogui`, `SendKeys` | Zéro occurrence dans `plugins/herald-os-bridge/` ; les 13 outils (`tools.py:1093-1107`) s'arrêtent à lancer/tuer/énumérer/ouvrir |
| CAP-02 | **OAuth pour les serveurs MCP distants** | `oauth`, `OAuth`, `PKCE`, `access_token`, `refresh_token`, `authorization_code` | Zéro occurrence dans `jarod-core/packages/plugins/mcp/src/` ; `McpServerConfig` n'a qu'un champ `headers` manuel |
| CAP-03 | **Signature de code des artefacts distribués** | `sign`, `signtool`, `codesign`, `notarize`, `certificate` | `apps/desktop/package.json` : `dmg.sign: false`, AppX sans certificat (`publisher: "CN=JarodOS"` fictif) |
| CAP-04 | **Télémétrie / métriques applicatives** | `opentelemetry`, `prom-client`, `statsd`, `metric`, `histogram`, `span` | Zéro occurrence dans `apps/desktop/electron/` et `jarod-core/packages/` |
| CAP-05 | **Rapport de crash vers un service** | `sentry`, `crashpad`, `bugsnag`, `crash reporter` | `crash/watch.ts` journalise **localement** ; aucun envoi |
| CAP-06 | **VAD (détection d'activité vocale) explicite** | `vad`, `silero`, `webrtc-vad`, `energy_threshold` | Zéro occurrence dans `jarod-core/packages/plugins/voice/src/` |
| CAP-07 | **Identification du locuteur** | `speaker`, `diarization`, `embedding voice`, `voiceprint` | Zéro occurrence dans `voice/src/` et `contracts/` |
| CAP-08 | **Suppression du bruit audio** | `denoise`, `noise_suppression`, `rnnoise`, `ns=` | Zéro occurrence dans `voice/src/` |
| CAP-09 | **Reconnaissance optique locale** (hors `system_os ocr`) | `tesseract`, `paddleocr`, `rapidocr`, `easyocr` | Zéro occurrence ; `system_os ocr` est **Linux seulement** (`tools.py`, `system_os_handler`) |
| CAP-10 | **Vérification de signature de paquet logiciel** | `verify signature`, `Authenticode`, `Get-AuthenticodeSignature`, `sigcheck` | Zéro occurrence dans `plugins/herald-os-bridge/bridge/host/` |
| CAP-11 | **Historique/presse-papiers chiffré** | `clipboard encrypt`, `clipboard vault` | `electron/clipboard*` (historique exposé par `preload/index.ts` `clipboard.history`) sans chiffrement propre |
| CAP-12 | **Registre de provenance RAG (citations)** | `citation`, `provenance`, `source_url`, `cite` | `SearchHit` (`contracts/src/domain.ts`) n'a **pas** de champ de provenance ; `rag_chunks` gère l'ACL mais le résultat d'outil ne cite pas |
| CAP-13 | **Export/import chiffré du profil** | `export profile`, `import profile`, `portability` | `gateway/portability.ts` existe (3,4 Ko) mais **le mot de passe de trousseau n'est pas un réglage** (`settings.ts` exclut les secrets de l'import) |
| CAP-14 | **MSIX signé** | `msix`, `MSIX` | `WINDOWS-PORT-NOTES.md` documente que electron-builder 26.15.3 n'a **pas** de cible `msix` → AppX non signé |
| CAP-15 | **Chiffrement de bout en bout du relay distant** | `e2e`, `noise protocol`, `double ratchet`, `x25519` | `contracts/src/settings.ts` (`RemoteConfig`) : `publicKey` stockée, mais aucun protocole de session |
| CAP-16 | **Bac à sable de test dédié** | `sandbox`, `firejail`, `AppContainer`, `job object`, `low integrity` | `contracts/src/settings.ts` a `DockerOptions` pour le shell, mais **aucun** bac à sable dédié aux tests |
| CAP-17 | **Détection de prompt injection** | `prompt injection`, `injection guard`, `jailbreak`, `sanitize input` | Zéro occurrence dans `jarod-core/packages/plugins/` (hors commentaires de conception) |
| CAP-18 | **Filtrage de sortie réseau (exfiltration)** | `egress`, `allowlist network`, `dlp` | `VaultEntry.domains` limite **l'envoi d'un secret** ; aucun contrôle de sortie global |
| CAP-19 | **Rotation/retenue des journaux applicatifs** | `rotation`, `retention`, `maxsize`, `logrotate` | Seul `audit.jsonl` tourne (5 Mio, `audit.py:51`) ; les logs applicatifs ne tournent pas |
| CAP-20 | **Gestion de la mémoire longue non documentaire** | `temporal memory`, `decay`, `forget` | `MemoryType` = `fact|preference|context|conversation` (`contracts/src/domain.ts`) ; pas d'oubli programmé |
| CAP-21 | **CI à la racine du dépôt** | `.github/workflows` | Aucun workflow trouvé à `C:\Users\San\herald-os\.github\` (voir §9 D-07) |
| CAP-22 | **Démarrage des webhooks entrants** | `WebhookService`, `start()`, `webhooks` | `contracts/src/settings.ts` déclare le champ `webhooks` et son statut : « **NON PORTÉ (démarrage)** — `WebhookService` (plugin-scheduler) est porté et testé, mais RIEN ne le démarre dans le kernel ni dans `jarod serve` » |
| CAP-23 | **Language servers (LSP)** | `lsp`, `LspConfig`, `diagnoseAfterEdit` | `contracts/src/settings.ts` : « **STATUT : NON PORTÉ** — dette de portage, pas une exclusion. Rien ne lit ce réglage » |
| CAP-24 | **Auto-amélioration (recherche GitHub hebdomadaire)** | `autoImprovement`, `auto-improvement` | `contracts/src/settings.ts` : « **STATUT : EXCLU** — décision CLI Q1 du 2026-10-02. Les modules `auto-improvement*` ne sont pas portés et `jarod improve` est retiré de l'aide » |
| CAP-25 | **Tick d'automatisation configurable** | `automationTickMs` | `contracts/src/settings.ts` : « **NON PORTÉ** — le plugin `automation` et `bundled-plugins.ts` ne sont pas portés : rien ne lit ce réglage » |
| CAP-26 | **Accès contrôlé au lecteur `S:`** | `S:\`, `S:/`, `hermes_home` | Aucune mention de `S:` dans le code. Aucun profil réel touché pendant cet audit (interdiction respectée) |
| CAP-27 | **Compression/résumé des très longues conversations côté noyau** | `compact`, `compactThreshold` | Le mécanisme **existe** (`compactThreshold: 240_000`, outil `compact`) — donc **partiel**, pas absent (voir CAP-09 §5) |
| CAP-28 | **Tests avec modèle réel en CI** | `real model`, `--real-profile` | Le drapeau `--real-profile` existe et est **explicitement refusé** sans lui (`gateway/main.ts:23-27`) ; aucun test ne l'active |

> **Note de méthode.** Les lignes CAP-22 à CAP-25 ne sont pas des déductions : le dépôt **documente lui-même** ces quatre statuts dans les commentaires de `contracts/src/settings.ts`. C'est une dette de portage assumée, pas une découverte de cet audit.

---

## 7. Interfaces d'extension

### 7.1 Contrats d'écosystème — **le seam le plus important**

`jarod-core/packages/contracts/src/ecosystem.ts` définit **cinq contrats** conçus pour brancher un moteur externe sans fork. Le fichier énonce lui-même les règles (`ecosystem.ts:1-27`) :

| Seam | Symbole exact | Fichier:ligne | Stabilité | Test qui le protège | Risque | Contrat JSON à modifier ? | Sidecar ? | Repli ? |
|---|---|---|---|---|---|---|---|---|
| Embeddings | `EmbeddingProvider<K>` (`.embed`, `.describe`, `.info`, `.available`) | `contracts/src/ecosystem.ts` | **Haute** (schéma Zod `strictObject`) | `packages/contracts` 31 tests | Faible | **Non** | **Oui** (déjà conçu pour) | Oui — « DÉGRADE, ne bloque jamais » |
| Génération d'index | `embeddingGeneration(spec)` | `contracts/src/ecosystem.ts` | Haute (fonction pure) | 31 tests | Faible | Non | Oui | Oui |
| Index vectoriel | `VectorIndexKind` = `memory\|turbovec\|sqlite-vec\|usearch` | `contracts/src/ecosystem.ts` | **Haute** (énumération déjà ouverte) | 31 tests | Faible | **Non** | Oui | Oui (`memory`) |
| Reranker | `RerankerProvider`, lu paresseusement par `rag` | `rag/src/index.ts:76-78` | Moyenne (lecture par `ctx.root`) | `plugin-rag` 164 tests | Moyen (lecture hors `inject`) | Non | Oui | Oui (rapport fantôme) |
| Parseur de documents | `rag.doclingPython`, `rag.doclingWorker`, `rag.pdfiumWorker` (chemins explicites) | `contracts/src/settings.ts` (section `rag`) | Moyenne | `plugin-rag` 164 tests | Moyen (chemins absolus obligatoires) | Non | **Oui** (worker) | Oui (`parser-fallback.ts`) |

**Pourquoi c'est décisif :** le contrat déclare que l'identifiant de chunk est un entier JSON sûr (≤ 2⁵³−1), **exprès** pour traverser un stdio/IPC vers un sidecar (`ecosystem.ts:20-23`). Et SQLite reste la source : « un index ne garde que l'identifiant numérique stable du chunk (`rag_chunks.id`, AUTOINCREMENT, jamais réutilisé) et son vecteur ; tout index se reconstruit (`rebuild`) depuis la base » (`ecosystem.ts:15-19`). **Un moteur externe peut donc être ajouté, testé, et retiré sans migration.**

### 7.2 Registre d'outils

| Seam | Symbole | Fichier:ligne | Stabilité | Notes |
|---|---|---|---|---|
| Registre d'outils | `ctx.tools.registry` (`tools.register({name, description, parameters, run, source, dangerous})`) | `plugins/tools/src/` ; usage : `plugins/agent/src/index.ts` | Haute | `parameters` = JSON Schema standard → **tout outil externe s'y branche sans modifier le noyau** |
| Enregistrement d'un handler | `tools.register({...})` | `plugins/agent/src/index.ts` (ex. `delegate_task`, `compact`) | Haute | `dangerous: true` déclenche l'accord utilisateur |
| Recherche d'outils | `ctx.tools.toolSearch`, `toolSearchTools()` | `plugins/tools/src/`, réglage `toolSearch: "auto"\|"on"\|"off"` | Moyenne | Réglage `toolSearch` dans `contracts/src/settings.ts` |

### 7.3 Handlers du bridge (côté Python)

| Seam | Symbole | Fichier:ligne | Stabilité | Notes |
|---|---|---|---|---|
| Ajouter un outil | `ToolSpec(name, schema, handler, emoji)` + tuple `TOOL_SPECS` | `plugins/herald-os-bridge/bridge/tools.py:1093-1107` | **Haute** | Ajouter une ligne au tuple suffit ; le schéma est du JSON Schema |
| Niveau de permission | `Tier` (`READ`/`ACT`/`MUTATE`/`DESTRUCTIVE`) | `bridge/permissions.py:29-33` | **Haute** | L'octet qui compte : un nouvel outil choisit son niveau |
| Politique | `parse_policy(data, platform)` → `Policy` | `bridge/permissions.py:139` | Haute (fonction pure documentée « pure; unit-tested ») | `protected_paths` s'ajoute sans toucher au code |
| Adaptateur d'OS | `host()` + `HostAdapter` | `bridge/host/base.py` | Moyenne | `host/windows.py`, `host/winps.py`, `host/search.py` |
| Audit | `audit.record(...)` | `bridge/audit.py:33` | Haute | Un nouvel outil hérite de l'audit **gratuitement** via `_guarded()` (`tools.py:83`) |
| Interruption propre | `HostNotSupported` | `bridge/host/` | Haute | Transforme une indisponibilité en résultat d'outil, jamais un crash |

### 7.4 Plugins, skills, MCP

| Seam | Symbole | Fichier:ligne | Stabilité |
|---|---|---|---|
| Découverte de plugins noyau | `jarod.plugin` + `jarod.order` dans `package.json` | `kernel/src/registry.ts:38-57` | **Haute** — « plus de tarballs » |
| Injection d'un plugin empaqueté | `setBundledPlugins(entries)` | `kernel/src/registry.ts:31` | Haute |
| Cycles de vie | `start(app)` / `stop(started)` / `ctx.effect()` | `kernel/src/lifecycle.ts:52,92` | Haute |
| Skills | `ctx.skills`, `ctx.skillsHub`, `skillTools()` | `plugin-skills`, `plugin-agent` | Moyenne |
| Skills livrées | `plugins/herald-os-bridge/skills/` : `diagnose-crash`, `herald-os`, `herald-os-tailor` | `plugins/herald-os-bridge/skills/` | Haute (dossier de fichiers) |
| MCP client | `McpManager` | `mcp/src/mcp.js`, `mcp/src/index.ts` | Haute |
| MCP serveur | `packages/cli/src/mcp-server.ts` | 16,6 Ko | Moyenne |
| Transports | stdio (`jsonrpc-stdio.ts`), HTTP/WS (`server.ts`, `ws.ts`), ACP (`acp-*.ts`) | `packages/cli/src/gateway/` | Moyenne |
| IPC Electron | `contextBridge.exposeInMainWorld('heraldOS', api)` | `preload/index.ts:391` | **Haute** — surface figée et typée |
| Canaux IPC | `const IPC = {...}` | `src/shared/ipc.ts` | Haute |
| Plugins widget | `PluginHost`, protocole `herald-plugin://` | `electron/plugins/host.ts`, `main.ts:92` | Moyenne |
| Commandes du shell | registre `src/commands/index.ts` (23 modules) | `src/commands/` | Haute |

### 7.5 Seams explicitement déclarés comme **non portés** (ne pas confondre avec des seams disponibles)

`lsp`, `webhooks`, `autoImprovement`, `automationTickMs` — tous dans `contracts/src/settings.ts`, tous annotés « NON PORTÉ » ou « EXCLU » en commentaire. **Un intégrateur ne doit pas les traiter comme des points d'accroche actifs.**

---

## 8. Sécurité et invariants

### 8.1 Modèle de menace tel qu'il est implémenté

| Contrôle | Implémentation | Preuve |
|---|---|---|
| **Fail-closed sur chemins protégés** | Le refus intervient **avant** toute demande d'accord à l'utilisateur : `protected_root()` puis `Decision(False, "protected", …)` | `permissions.py:229-233` |
| **Chemins protégés Windows** | Clés SSH/GnuPG, `%APPDATA%\Microsoft\{Credentials,Protect,SystemCertificates}`, `%LOCALAPPDATA%\Microsoft\{Credentials,Vault}`, `%PROGRAMDATA%\Microsoft\Crypto`, `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%` | `permissions.py:73-84` |
| **Chemins protégés POSIX** | `~/.ssh`, `~/.gnupg`, `$HERMES_HOME/.env`, `$HERMES_HOME/auth.json`, `/System`, `/usr`, `/bin`, `/sbin`, `/etc`, `/Library`, `/boot`, `/var/lib`, `/lib`, `/proc`, `/sys` | `permissions.py:46-70` |
| **`destructive` jamais pré-autorisable** | Si le fichier de politique dit `allow` sur `destructive`, `mode()` **force** `confirm` | `permissions.py:117-119` |
| **Clé de règle unique par appel destructif** | `herald_os:{tool}:{action}:{uuid4[:8]}` → « always allow » ne peut pas coller | `permissions.py:238-240` |
| **Refus « personne pour demander »** | Si `tools.approval` est indisponible : `Decision(False, "blocked", …)` | `permissions.py:216-219` |
| **Caviardage des secrets** | Clés contenant `password`, `passphrase`, `secret`, `token`, `psk` → `"[redacted]"` | `audit.py:16,22` |
| **Bornes d'audit** | 400 caractères par argument, fichier plafonné à 5 Mio avec rotation en `.jsonl.1` | `audit.py:14,15,51` |
| **Audit qui n'échoue jamais bruyamment** | `record()` attrape tout et écrit sur `stderr` : un échec d'audit ne casse pas l'action | `audit.py` (docstring : « Never raises ») |
| **Pas de shell arbitraire dans le moteur** | `spawn(bin, args, { shell: false })` — commentaire : « spawn sans shell : une ligne de commande concaténée est une injection qui attend » | `llm/src/index.ts`, constructeur de `LlamaServerSupervisor` |
| **Validation des noms d'appareils/SSID** | `_CONTROL_NAME` refuse un nom commençant par `-` (pour qu'il ne soit pas pris pour une option) | `tools.py:644-651` |
| **Validation des identifiants catalogue/plugin** | `_CATALOG_ID`, `_PLUGIN_ID`, `_PLUGIN_URL` par expressions régulières | `tools.py:815-817` |
| **Confirmation doublement requise (`system_os`)** | `install/remove/update/suspend` + le shell herald-os lui-même demande confirmation | docstring `system_os`, `SYSTEM_OS_TIERS:818` |
| **Anti-SSRF/DNS rebinding (navigateur)** | `hostAllowed()` refuse `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa` | `agent-browser.ts:139,310` |
| **Liste fermée de touches navigateur** | 14 touches, « pas de combinaisons, pas de raccourcis système » | `contracts/src/browser.ts:44-52` |
| **Surface IPC figée** | `contextBridge` avec objet littéral et types ; `nodeIntegration` non activé côté renderer | `preload/index.ts:51-391` |
| **Schéma privilégié contrôlé** | `herald-plugin` déclaré `standard + secure + supportFetchAPI` | `main.ts:92` |
| **Instance unique** | Verrou pris **avant** toute donnée ou socket : « First, before anything touches data or opens a socket » | `main.ts:63-65` |
| **Refus de navigation** | `will-navigate` est intercepté ; seules les actions de récupération connues passent | `main.ts` (`watchRenderer`) |
| **`shell.openExternal` restreint** | `if (/^https?:\/\//i.test(url))` sinon `throw` | `main.ts` (`IPC.shellOpenExternal`) |
| **Garde du shell (confinement d'écriture)** | `WriteScope = "off" | "workspace"` ; `workspace` = confinement **exigé**, sinon la commande est refusée | `contracts/src/settings.ts` (`ShellPolicy`) |
| **Coffre à domaines** | `VaultEntry.domains` limite les hôtes auxquels un secret peut être envoyé ; `allowShell` explicite | `contracts/src/settings.ts` (`VaultEntry`) |
| **Chiffrement au repos** | SQLite `chacha20` ; la clé est dérivée et stockée hors des réglages | `storage/src/db.ts:552` |
| **Refus du profil réel** | Sans `JAROD_HOME` **et** sans `--real-profile`, la passerelle refuse de démarrer (code 2) | `gateway/main.ts:23-27` |
| **Jeton de contrôle** | `osControlToken()` + `sameToken()` ; « every client is the backend » | `main.ts:174-179` |
| **Fichier de secret 0600** | `writeSecretFile` / `removeSecretFile`, + `icacls` sous Windows | `gateway/secret-file.ts` |
| **Installeur** | `nsis.perMachine: false` (installation par utilisateur, pas d'élévation) | `apps/desktop/package.json` (`nsis`) |

### 8.2 Invariants que toute intégration future doit respecter

1. **Un outil qui agit passe par `_guarded()`** (`tools.py:83`). Toute capacité ajoutée hors de ce chemin contourne permissions **et** audit simultanément.
2. **Le niveau `destructive` ne se pré-autorise pas.** Ne pas chercher à rendre une action destructive silencieuse.
3. **Le noyau ne dépend d'aucun moteur concret** (`ecosystem.ts:5-8`). Un moteur externe passe par un contrat, jamais par un import direct dans le kernel.
4. **SQLite reste la source de vérité.** Un index externe se reconstruit depuis la base ; il ne la remplace pas.
5. **Un moteur indisponible dégrade, il ne bloque pas** (`ecosystem.ts:24-25`). Toute intégration doit avoir un chemin de repli.
6. **Jamais `shell: true`.** Les `spawn` du noyau passent un tableau d'arguments.
7. **Le disque `S:` n'est pas un dépôt.** Aucun profil réel, aucun secret, aucun fichier d'identifiants ne doit être lu par un outil ajouté.
8. **Une valeur de réglage hors bornes est ramenée dans ses bornes, jamais propagée** (`normalizeAutoImprovementConfig`, `auto-improvement-config.ts`) — modèle à suivre pour tout nouveau réglage.

---

## 9. Dette et doublons

Chaque ligne est classée : **défaut réel**, **choix volontaire**, **limitation documentée**, **dette acceptable**, ou **hypothèse non vérifiée**.

| ID | Constat | Preuve `fichier:ligne` | Classement |
|---|---|---|---|
| D-01 | **Deux gestionnaires de paquets dans un dépôt** : npm à la racine, pnpm dans `jarod-core/`, avec des `package-lock.json` **et** `pnpm-lock.yaml` distincts. Deux installations, deux arbres de dépendances. | `package.json:19-22` vs `jarod-core/pnpm-workspace.yaml` | **Défaut réel** (mais coût de correction élevé = dette acceptable) |
| D-02 | **4 réglages déclarés et jamais lus** : `lsp`, `webhooks`, `autoImprovement`, `automationTickMs`. Ils apparaissent dans les types, donc un profil peut les porter, mais rien ne les consomme. | `contracts/src/settings.ts` (commentaires « NON PORTÉ » / « EXCLU ») | **Limitation documentée** — le dépôt l'admet explicitement |
| D-03 | **Workers d'embeddings et de reranker absents du bundle.** Conséquence : `rag.enabled` peut être vrai, l'index se construit, mais l'embedding échoue dans l'application installée. | `jarod-core/scripts/bundle-gateway.mjs:9-13` (listes `ABSENT`) | **Limitation documentée** + **défaut réel d'expérience** |
| D-04 | **Test instable (flaky) dans `plugin-embeddings`.** Premier passage : échec `AssertionError: expected [Function] to throw an error` sur `expect(() => process.kill(pid, 0)).toThrow()` (le processus worker n'était pas encore mort après 300 ms). Second passage : **98 passés | 3 ignorés**. Le test dépend d'une course de temporisation au démontage. | `jarod-core/packages/plugins/embeddings/test/isolated-plugin.test.ts:55` | **Défaut réel** (test non déterministe) |
| D-05 | **`plugin-vision` sous-testé** : 1 fichier de test, 1 test, pour un domaine entier (analyse d'image). | `packages/plugins/vision/test/` | **Défaut réel** (couverture) |
| D-06 | **`plugin-workflows` sous-testé** : 3 fichiers, 29 tests, pour le domaine « workflows durables / compensation / idempotence ». | `packages/plugins/workflows/test/` | **Défaut réel** (couverture) |
| D-07 | **Aucun workflow CI trouvé à la racine du dépôt**, alors que `WINDOWS-PORT-NOTES.md` déclare avoir ajouté `windows-latest` aux matrices. Le répertoire `.github` existe mais aucun fichier `workflows/*.yml` n'a été trouvé. | `C:\Users\San\herald-os\.github\` (inspection directe) vs `WINDOWS-PORT-NOTES.md` | **Hypothèse non vérifiée** — soit les workflows sont plus profonds, soit la déclaration est en avance sur le code |
| D-08 | **Providers presque identiques** : LM Studio et llama.cpp ont chacun leur module, mais Ollama n'a **que** l'entrée `catalogLocalModels('ollama')` côté shell, sans module de fournisseur noyau. Asymétrie entre les trois serveurs locaux. | `llm/src/lmstudio.ts`, `llm/src/llama-server.ts` ; `preload/index.ts` (`catalog.localModels`) | **Défaut réel** (incohérence d'abstraction) |
| D-09 | **Deux sources de vérité pour les réglages** : `contracts/src/settings.ts` (desktop/CLI) et les sections de configuration du noyau. Le commentaire du pont est explicite : « `SettingsService.patch` n'écrit que les clés qu'il connaît, donc une clé absente des défauts est jetée EN SILENCE ». Un intégrauteur qui ajoute une clé hors `DEFAULT_SETTINGS` la perdra. | `contracts/src/settings.ts` (commentaire sur `webhooks`) | **Défaut réel** (piège d'intégration), atténué par la documentation |
| D-10 | **`agent-browser` est une implémentation maison** d'un problème résolu par des bibliothèques matures. La fonctionnalité marche, mais l'index d'élément est instable (`element.index` = ordinal) : toute modification du DOM entre deux appels invalide la cible. | `contracts/src/browser.ts:12-19`, `agent-browser.ts:279` | **Défaut réel** (fragilité fonctionnelle) |
| D-11 | **Deux systèmes de plugins distincts dans le même produit** : les plugins noyau Cordis (`jarod-core/packages/plugins/`) et les plugins widget du shell (`herald-plugin://`). Les permissions par extension (`pluginTrust`) ne couvrent que les **premiers** (plugins Hermes). | `kernel/src/registry.ts:38` vs `electron/plugins/host.ts` ; `contracts/src/settings.ts` (`PluginTrustEntry`) | **Choix volontaire** (deux surfaces différentes), mais **piège de sécurité** : un plugin widget n'a pas le même modèle de confiance |
| D-12 | **Code de récupération de crash local uniquement.** `CrashWatcher` alimente le shell et les hooks ; rien ne sort de la machine. Bon pour la vie privée, insuffisant pour diagnostiquer un défaut de terrain. | `electron/crash/watch.ts` | **Choix volontaire** (cohérent avec le positionnement local-first) |
| D-13 | **`system_os` est Linux seulement** et renvoie un échec explicite ailleurs. Un utilisateur Windows voit donc 12 outils sur 13 fonctionner, et un outil qui refuse. | `tools.py` (`system_os_handler` : `if host().platform != "linux"`) | **Choix volontaire** (le code le dit) |
| D-14 | **`PINOKIO` chargé à la demande**, et son absence ne casse pas le boot. Un commentaire de `D:\Jarod V2` (dépôt **distinct**, non audité ici) mentionne un incident inverse. Aucune trace équivalente dans `herald-os`. | `main.ts:108-113` | **Hypothèse non vérifiée** pour `herald-os` |
| D-15 | **Aucun test de mutation** dans ce dépôt (`stryker` est présent dans un autre projet de la machine, pas ici). | Absence de `stryker.conf.*` | **Défaut réel** (couverture) |
| D-16 | **Signature absente sur tous les artefacts distribués** : AppX non signé, DMG `sign: false`. Un utilisateur Windows verra un avertissement SmartScreen. | `apps/desktop/package.json` | **Défaut réel** |
| D-17 | **`upstream/hermes-agent/` est une copie figée de ~5 Mo** committée dans le dépôt, avec un `.herald-os-upstream-sha`. Risque de dérive silencieuse entre la copie et le runtime Hermes réellement installé (`v0.22.0`, sha `e06df9c2eae6` observé vs `f97608f1` épinglé). | `upstream/UPSTREAM.lock`, `upstream/herald-os-upstream-sha` | **Dette acceptable** si `sync-upstream` est exécuté ; **à surveiller** |
| D-18 | **Un outil qui échappe au garde ?** Vérification : les 13 outils du bridge passent tous par `_guarded()` (`tools.py:1093-1107` → `_guarded` à `:83`). Aucun contournement trouvé. Côté noyau, le garde unifié est instancié dans `plugin-agent` (`ctx.permissions.gate(skills)`) et couvre le registre. **Aucun outil hors garde identifié.** | `tools.py:83,1093-1107` ; `plugin-agent/src/index.ts` (`gate: ctx.permissions.gate(...)`) | **Constat favorable** (vérifié, pas d'échappement) |
| D-19 | **Mécanismes que Jarod ne devrait PAS remplacer par une dépendance** : le garde `authorize()`+`_guarded()`+`audit.jsonl` (propre, testé, 185 tests) ; le disjoncteur de repli (`routing.ts`, 292 tests) ; la découverte de plugins Cordis ; le chiffrement SQLite `chacha20` en place ; le pont d'approbation unifié avec Hermes. Remplacer l'un de ces cinq introduirait une régression de sécurité ou de contrat. | Voir preuves ci-dessus | **Recommandation** |
| D-20 | **`DECISIONS.md` fait 716 Ko.** Le noyau porte un journal de décisions d'un demi-mégaoctet, plus `scripts/decisions-index.ts` pour l'indexer. Signe d'un projet à forte discipline de traçabilité, mais coûteux à parcourir. | `jarod-core/DECISIONS.md` (716 572 octets) | **Choix volontaire** |

---

## 10. Matrice des opportunités

Chaque ligne est une **recherche** à mener par un analyste externe. Aucun nom de dépôt n'est proposé.

| ID | Capacité recherchée | Problème Jarod résolu | Priorité | Mots-clés GitHub (anglais) | Langages acceptables | Runtime acceptable | Licence acceptable | Type d'intégration | API/protocole souhaité | Windows natif requis | Offline requis | GPU/NPU requis | Confiance requise | Critères d'acceptation | Rejet immédiat |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OPP-01 | Index vectoriel embarqué, persistant, filtrable | `VectorIndex` est en mémoire et se perd au redémarrage ; `Turbovec` est un sidecar | **haute** | `vector index sqlite`, `ann index embedded`, `hnsw library`, `sqlite-vec` | Rust, C, C++, TypeScript | natif ou sidecar | MIT, Apache-2.0, BSD-2/3 | library ou sidecar | API `insert/remove/search(k, allowList)` sur identifiants entiers ≤ 2⁵³−1 | oui | oui | non (CPU accepté) | élevée | Reconstruit depuis SQLite ; allowlist d'identifiants ; repli sur l'index mémoire ; ≤ 5 Mo de binaire | AGPL/SSPL pour embarqué ; format propriétaire ; dépendance serveur |
| OPP-02 | Embeddings locaux exécutables sans Python ni `tsx` | Les workers d'embeddings sont absents du bundle → RAG inutilisable dans l'app installée | **critique** | `onnx runtime embedding`, `sentence-transformers onnx`, `text embedding inference native`, `bge-m3 onnx` | C++, Rust, TypeScript (napi) | napi/Node ou sidecar | MIT, Apache-2.0 | library ou sidecar | `embed(texts[], role) → Float32Array[]` conforme au contrat `EmbeddingProvider` | oui | oui | oui (GPU ou NPU) mais CPU acceptable | élevée | S'exécute depuis un bundle esbuild sans `tsx` ; respecte `EmbeddingModelSpec` (dim, pooling, normalize, quantization) | Nécessite un interpréteur Python ; télécharge un modèle au premier appel sans consentement |
| OPP-03 | Reranker local, léger, exécutable en Node | Le contrat reranker existe mais n'a pas de moteur livrable | **haute** | `cross-encoder reranker onnx`, `bge-reranker onnx`, `text reranking library` | C++, Rust, TypeScript | napi ou sidecar | MIT, Apache-2.0 | library ou sidecar | `rerank(query, passages, k) → scores` + `EngineInfo{name,version,device}` | oui | oui | optionnel | moyenne | Modèle ≤ 500 Mo ; dégrade proprement (contrat `available: false`) | Requiert CUDA exclusif ; licence non commerciale |
| OPP-04 | Automatisation d'interface Windows (UIAutomation) | CAP-01 : Jarod ne peut pas cliquer un bouton dans une application tierce | **critique** | `uiautomation python`, `windows accessibility tree`, `ui automation driver`, `windows gui automation` | Python, C#, Rust | sidecar ou CLI | MIT, Apache-2.0, BSD | sidecar | Arbre d'accessibilité + invocation d'un motif (Invoke/Toggle/Value) ; **jamais** de clic par coordonnées seules | **oui (obligatoire)** | oui | non | élevée | Enregistré comme outil du bridge à un niveau `Tier` explicite ; chemins/fenêtres protégés respectés ; audit automatique via `_guarded()` | AGPL embarqué ; nécessite un service cloud ; injecte des événements sans arbre d'accessibilité |
| OPP-05 | OAuth 2.0 / découverte pour clients MCP | CAP-02 : seuls les serveurs MCP sans authentification ou à en-tête manuel sont joignables | **haute** | `mcp oauth client`, `oauth2 pkce client`, `dynamic client registration`, `protected resource metadata` | TypeScript, Rust | library | MIT, Apache-2.0 | library | OAuth 2.1 + PKCE + Dynamic Client Registration ; jetons dans le **coffre** (`VaultEntry`), jamais dans les réglages | oui | oui | non | élevée | Jetons hors des réglages exportables ; liste d'hôtes explicite ; repli sur l'en-tête manuel | Stocke des jetons en clair ; impose un compte propriétaire |
| OPP-06 | Détection d'activité vocale (VAD) locale | CAP-06 : l'entrée audio est capturée en continu sans segmentation | **moyenne** | `voice activity detection onnx`, `silero vad`, `webrtcvad`, `streaming vad` | C++, Rust, TypeScript | napi ou WASM | MIT, Apache-2.0, BSD | library | `isSpeech(Float32Array) → bool` en flux, latence < 30 ms | oui | oui | non | élevée | Fonctionne sur trames de 10–30 ms ; pas de dépendance réseau | AGPL embarqué ; binaire opaque |
| OPP-07 | Suppression de bruit temps réel | CAP-08 : aucune réduction de bruit avant STT | **basse** | `noise suppression realtime`, `rnnoise`, `deepfilternet`, `speech enhancement onnx` | C, C++, Rust | napi ou sidecar | MIT, BSD | library | `denoise(Float32Array) → Float32Array` 48 kHz | oui | oui | optionnel | moyenne | CPU temps réel ; désactivable | Licence non commerciale ; latence > 50 ms |
| OPP-08 | Reconnaissance optique locale multiplateforme | CAP-09 : `system_os ocr` est Linux seulement | **moyenne** | `ocr onnxruntime`, `tesseract wasm`, `paddleocr onnx`, `text detection recognition` | C++, Rust, Python | napi, WASM ou sidecar | MIT, Apache-2.0, BSD | library ou sidecar | `ocr(pngBytes, langHints) → texte + boîtes` | oui | **oui (obligatoire)** | optionnel | élevée | Aucun appel réseau ; langues FR+EN ; ≤ 200 Mo | Envoie l'image à un service ; télémétrie obligatoire |
| OPP-09 | Orchestration durable de workflows avec compensation | CAP-05 : `plugin-workflows` a 29 tests pour tout le domaine ; pas de transaction compensatoire | **haute** | `durable execution workflow`, `saga pattern orchestration`, `workflow checkpointing`, `idempotent task orchestrator` | Go, Java, TypeScript, Rust | sidecar | MIT, Apache-2.0 | sidecar ou référence | Activités idempotentes, compensations déclarées, reprise après arrêt brutal | oui | oui | non | élevée | Sidecar local, pas de service managé ; modèle de reprise lisible ; exporte un état inspectable | Service cloud obligatoire ; licence BUSL/SSPL si embarqué |
| OPP-10 | Détection de prompt injection / assainissement d'entrée | CAP-17 : aucune défense contre l'injection indirecte (page web, document, sortie d'outil) | **haute** | `prompt injection detection`, `indirect prompt injection classifier`, `llm input sanitization`, `guardrails library` | Python, TypeScript, Rust | library ou sidecar | MIT, Apache-2.0 | library | Classifieur ou jeu de motifs décidant **avant** l'envoi au modèle ; sortie typée, pas de texte libre | oui | oui | non | moyenne | Marque une entrée comme non fiable sans bloquer ; journalise le motif ; pas de dépendance à un service | Nécessite un appel API par requête ; pas de licence |
| OPP-11 | Contrôle d'égression réseau / allowlist de sortie | CAP-18 : `VaultEntry.domains` limite un secret mais pas la sortie globale | **moyenne** | `egress allowlist proxy`, `http proxy local`, `network egress control`, `mitm allowlist` | Go, Rust, TypeScript | sidecar | MIT, Apache-2.0, BSD | sidecar | Proxy HTTP/HTTPS local avec allowlist d'hôtes explicite et journal | oui | oui | non | élevée | Mode observation d'abord (n'bloque rien) ; l'utilisateur approuve les hôtes | Déchiffre le trafic sans consentement ; service cloud |
| OPP-12 | Redaction/classification de données sensibles avant envoi au modèle | Aucune détection de PII avant l'appel distant (le caviardage n'existe que pour l'audit local) | **haute** | `pii detection library`, `data redaction preflight`, `named entity redaction`, `sensitive data scanner` | Python, TypeScript, Rust | library ou sidecar | MIT, Apache-2.0 | library | `redact(text) → texte + spans typés` ; **locale**, sans modèle cloud par défaut | oui | **oui (obligatoire)** | non | moyenne | Fonctionne hors ligne ; langues FR+EN ; explique ce qui a été masqué | Envoie le texte à un service d'analyse |
| OPP-13 | Signature et vérification de mise à jour | CAP-03, CAP-14 : tous les artefacts sont non signés | **critique** | `code signing windows`, `signtool alternative`, `update signature verification`, `minisign tauri updater` | Rust, Go, C++ | dev-tool | MIT, Apache-2.0, BSD | dev-tool | Format de manifeste signé + vérification côté client avant installation | oui | oui | non | élevée | Vérifie **avant** d'installer ; refuse une signature absente ; clé publique hors du dépôt | Nécessite un service payant ; clé privée dans le dépôt |
| OPP-14 | Observabilité locale (traces, métriques, rotation) | CAP-04, CAP-19 : pas de métriques, pas de rotation des logs applicatifs | **moyenne** | `opentelemetry local exporter`, `file exporter otel`, `log rotation library`, `structured logging` | TypeScript, Go, Rust | library | MIT, Apache-2.0 | library | OTLP **vers un collecteur local** ; rotation par taille et par âge | oui | **oui (obligatoire)** | non | élevée | Exportateur fichier local, pas de point de terminaison distant par défaut ; désactivable | Exige un backend SaaS ; télémétrie par défaut |
| OPP-15 | Indexation incrémentale de documents hétérogènes | Le pipeline ré-indexe ; les parseurs sont maison (`parser-*.ts`) | **moyenne** | `document parser library`, `document ingestion incremental`, `pdf docx xlsx extraction`, `document chunking strategy` | Python, Rust, TypeScript | library ou sidecar | MIT, Apache-2.0, BSD | sidecar | `parse(bytes, mime) → texte structuré + tableaux + provenance` | oui | **oui (obligatoire)** | non | élevée | Déjà anticipé par `ecosystem.documentParser` ; chemins de worker explicites ; repli texte conservé | AGPL/SSPL embarqué ; modèle × serveur obligatoire |
| OPP-16 | Orchestration de sous-agents avec budget et annulation | `delegate_task` existe mais sans graphe ni budget explicite côté outil | **moyenne** | `multi agent orchestration`, `agent supervisor tree`, `budgeted agent delegation`, `agent cancellation` | Python, TypeScript, Go | library ou sidecar | MIT, Apache-2.0 | library ou référence | Arbre de tâches, budget par nœud, annulation propagée, sortie typée | oui | oui | non | moyenne | S'intègre au registre d'outils existant ; ne crée pas un second système de permissions | AGPL ; impose son propre runtime LLM |
| OPP-17 | Bac à sable d'exécution Windows natif | CAP-16 : seul Docker est proposé pour le shell, aucun bac à sable de test | **haute** | `windows sandbox execution`, `appcontainer isolation`, `job object sandbox`, `restricted token process` | C++, Rust, C# | sidecar | MIT, Apache-2.0 | sidecar ou library | Exécuter une commande avec capacités minimales (pas de réseau, écriture dans un dossier jetable) | **oui (obligatoire)** | oui | non | **très élevée** | Ne contourne pas `executeGuardedTool`/`authorize()` ; rend un code de sortie et une trace ; repli explicite si indisponible | Contourne le garde ; nécessite un pilote noyau signé non auditable |
| OPP-18 | Vision locale (description d'image hors ligne) | `plugin-vision` a 1 test ; la description est déléguée à un fournisseur | **moyenne** | `local vision model onnx`, `image captioning onnxruntime`, `vlm local inference`, `clip onnx` | C++, Rust, Python | napi ou sidecar | MIT, Apache-2.0 | library ou sidecar | `describe(pngBytes, question) → texte` + `EngineInfo` | oui | **oui (obligatoire)** | oui (mais CPU acceptable) | moyenne | Aucun envoi réseau par défaut ; respecte le mode `imageDescription.mode = "auto"` | Envoie l'image à un service ; licence non commerciale |
| OPP-19 | Synchronisation/merge de base de données locale sans perte | `import-hermes-history.py` importe l'historique Hermes ; aucune stratégie de fusion générique | **basse** | `sqlite merge conflict`, `crdt local first sync`, `offline first sync library`, `bidirectional sync` | Rust, TypeScript, Go | library | MIT, Apache-2.0 | library | Fusion déterministe avec détection de conflit et journal | oui | oui | non | moyenne | Ne perd aucune ligne existante ; testable sur base synthétique | Exige un serveur central |
| OPP-20 | Clavier/raccourcis natifs Windows sans `Win+` | `WINDOWS-PORT-NOTES.md` documente que Windows réserve `Win+` : aucun raccourci global de cette famille | **basse** | `windows global hotkey library`, `low level keyboard hook`, `registerhotkey wrapper` | C++, Rust, C# | napi | MIT, Apache-2.0 | library | Enregistrement de raccourcis non réservés + repli utilisateur | **oui** | oui | non | élevée | Ne capture pas les raccourcis système ; désactivable ; journalisé | Installe un pilote clavier |

---

## 11. Dépôts déjà étudiés ou exclus

Ces dépôts sont **exclus de la recherche future**. Ils ne doivent pas être reproposés.

| Dépôt | Statut | Raison concise |
|---|---|---|
| `anywhere-labs/dsh-next` / `fentz26/dsh-next` | **déjà évalué** | Agent desktop déjà examiné ; périmètre recoupant l'interface agentique de Jarod-OS |
| `NousResearch/hermes-agent-self-evolution` | **exclu** | Correspond au domaine `autoImprovement`, que Jarod-OS a **volontairement exclu** (décision CLI Q1 du 2026-10-02, `contracts/src/settings.ts`) |
| `linshenkx/prompt-optimizer` | **déjà évalué** | Optimisation de prompts : hors périmètre (Jarod-OS ne gère pas de pipeline d'optimisation de prompts) |
| `harness/harness` | **déjà évalué** | Plateforme CI/CD ; Jarod-OS n'a pas de CI à la racine (D-07) mais ce n'est pas un besoin du produit |
| `browser-use/browser-harness` | **déjà évalué** | Recoupe `agent-browser` (implémentation maison existante) |
| `browser-use/browser-use` | **déjà évalué** | Même périmètre que `browser-harness` ; nécessiterait de remplacer `BrowserPort` |
| `pinokiocomputer/pinokio` | **déjà utilisé** | `pinokio-runtime/host.cjs` est embarqué dans l'installateur Windows (`extraResources`) et piloté par `PinokioService` |
| `kaonomi-net/mari` | **déjà évalué** | Périmètre agentique recoupé |
| `modelcontextprotocol/typescript-sdk` | **déjà utilisé** | `@modelcontextprotocol/client` figure dans les `devDependencies` de `jarod-core/packages/cli/package.json` |
| `microsoft/playwright` | **déjà évalué** | Candidat évident pour remplacer `agent-browser` ; étudié, écarté à ce stade |
| `pywinauto/pywinauto` | **déjà évalué** | Candidat évident pour CAP-01 (UI Automation Windows) ; étudié, écarté à ce stade |
| `k2-fsa/sherpa-onnx` | **déjà évalué** | Candidat STT/wake word ; étudié, écarté à ce stade |
| `microsoft/markitdown` | **déjà évalué** | Conversion de documents ; recoupe `parser-*.ts` du `plugin-rag` |
| `data-privacy-stack/presidio` | **déjà évalué** | Candidat pour la rédaction de PII (OPP-12) ; étudié, écarté à ce stade |
| `promptfoo/promptfoo` | **déjà évalué** | Évaluation de prompts ; hors périmètre produit |
| `open-telemetry/opentelemetry-js` | **déjà évalué** | Candidat observabilité (OPP-14) ; étudié, écarté à ce stade |
| `microsoft/winget-cli` | **déjà utilisé** | Référencé par l'audit matériel : « une commande de correction exacte (winget sous Windows) » (`HANDOFF.md`) |
| `temporalio/temporal` | **déjà évalué** | Candidat workflows durables (OPP-09) ; étudié, écarté à ce stade (sidecar lourd) |
| `microsoft/autogen` | **déjà évalué** | Candidat orchestration multi-agents (OPP-16) ; étudié, écarté à ce stade |
| `NousResearch/hermes-agent` | **déjà utilisé** | `upstream/hermes-agent/` est une copie **épinglée** (sha `f97608f1`), et Hermes est un **backend de repli de premier rang** (`selectBackend`) |
| `anywhere-labs/dsh-desktop` | **déjà évalué** | Shell desktop recoupant `apps/desktop` |
| `co-l/openfox` | **déjà surveillé** | Une copie existe sur la machine (`D:\openfox-desktop`, HEAD `7b3d4325`) ; surveillé, non intégré |
| `fathah/hermes-desktop` | **déjà évalué** | Shell desktop pour Hermes ; recoupe directement le périmètre de `apps/desktop` |

**Total : 23 dépôts exclus.** L'analyste externe doit en proposer **10 autres**, non listés ci-dessus.

---

## 12. Résultats des commandes

Toutes les commandes ci-dessous ont été **réellement exécutées** pendant cet audit, sur la machine hôte (Windows 11, Node v26.7.0, npm 11.19.0, pnpm 12.6.0, Python 3.11 par Hermes). Aucune n'a été inventée. Aucun fournisseur payant n'a été appelé, aucun profil réel touché.

| # | Commande exacte | Répertoire | Durée | Code sortie | Résultat | Erreur brute pertinente |
|---|---|---|---|---|---|---|
| 1 | `npm run typecheck --workspace apps/desktop` | `C:\Users\San\herald-os` | ~9 s | **0** | 2 projets tsc (`tsconfig.json` + `tsconfig.electron.json`), aucune erreur | — |
| 2 | `pnpm -r typecheck` | `C:\Users\San\herald-os\jarod-core` | ~6,4 s | **0** | **24 packages** typecheckés sans erreur | — |
| 3 | `npm run test --workspace apps/desktop` | `C:\Users\San\herald-os` | 8,28 s | **0** | **121 fichiers passés · 756 tests passés · 2 ignorés** | — |
| 4 | `pnpm -r test` | `C:\Users\San\herald-os\jarod-core` | ~5 min (dépasse 180 s) | **1** (1er passage) / **0** (2ᵉ) | **277 fichiers · 2590 passés · 16 ignorés · 1 échec attendu** | Voir encadré ci-dessous |
| 5 | `node scripts/run.mjs test-bridge` | `C:\Users\San\herald-os` | 4,95 s | **0** | **185 passés, 9 ignorés** (les ignorés sont des variantes `AF_UNIX` indisponibles sous Windows) | — |
| 6 | `powershell -File scripts/verify-windows.ps1` | `C:\Users\San\herald-os` | ~20 s | **0** | **6/6 étapes passées** : runtime Hermes v0.22.0 détecté · plugin lié et activé · `GET /api/status` sur `127.0.0.1:51380` · toolset `herald_os` = **13 outils**, `enabled=True` · appel d'outil réel `system_info` exécuté par le registre · **ligne d'audit écrite** `tool=system_info tier=read decision=allowed ok=True` | — |
| 7 | `powershell -File scripts/verify-jarod-os.ps1 -TimeoutSeconds 150` | `C:\Users\San\herald-os\jarod-core` | ~40 s | **0** | **8/8 étapes passées** : passerelle joignable · modèles LM Studio découverts `["gemma-3-4b-it","qwen3-8b"]` sans l'embedding · Whisper local non proposé · bascule de fournisseur effective · réglage relu par la passerelle · `config/raw` à jour · **`config/raw` sans aucun secret** · réglage **persistant** après réouverture | — |
| 8 | Inspection des artefacts construits | `C:\Users\San\herald-os\apps\desktop\release\` | — | — | Présents : `JarodOS-Setup-0.1.0-alpha.1-win-x64.exe` (136,9 Mo), `JarodOS-0.1.0-alpha.1-win-x64.appx` (193,9 Mo), `JarodOS-Setup-…exe.blockmap`, `win-unpacked/` | — |
| 9 | Inspection du noyau compilé | `C:\Users\San\herald-os\jarod-core\dist\` | — | — | `gateway/` présent (sortie de `bundle:gateway`) | — |

### Détail de l'échec de la commande 4 (transparence)

**Premier passage :**

```
FAIL  test/isolated-plugin.test.ts > plugin embeddings : worker isolé
      > rag.enabled vrai : un worker est lancé, l'URL est celle du port fixe,
        embed() passe par lui, l'arrêt du noyau le tue
AssertionError: expected [Function] to throw an error
 ❯ test/isolated-plugin.test.ts:55:40
    55|     expect(() => process.kill(pid, 0)).toThrow();
```

**Second passage (par paquet) :** `packages/plugins/embeddings` → **11 fichiers passés | 2 ignorés**, **98 tests passés | 3 ignorés**.

**Interprétation :** le test attend que le processus worker soit *mort* 300 ms après `shutdown(app)`. Sur cette machine, la mort du processus a dépassé la fenêtre de 300 ms au premier passage. Le second passage passe. C'est donc un **test non déterministe (flaky)**, pas une régression ni un échec préexistant attribuable au HEAD. Classé **D-04** au §9.

### Détail des totaux du noyau (commande 4)

| Paquet | Fichiers | Tests |
|---|---|---|
| `contracts` | 3 | 31 |
| `kernel` | 2 | 14 |
| `plugin-storage` | 7 | 52 |
| `plugin-persona` | 1 | 2 |
| `plugin-permissions` | 4 | 26 |
| `plugin-kanban` | 1 | 9 |
| `plugin-skills` | 4 | 14 |
| `plugin-updates` | 2 | 31 |
| `plugin-embeddings` | 11 (2 ignorés) | 98 passés, 3 ignorés |
| `plugin-memory` | 2 | 25 |
| `plugin-rag` | 22 | 164 passés, 13 ignorés |
| `plugin-llm` | 21 | 292 |
| `plugin-vision` | 1 | 1 |
| `plugin-scheduler` | 8 | 60 |
| `plugin-voice` | 9 | 71 |
| `plugin-tools` | 15 | 224 |
| `plugin-mcp` | 2 | 10 |
| `plugin-agent` | 41 | 256 |
| `plugin-workflows` | 3 | 29 |
| `plugin-gateways` | 13 | 81 |
| `bridge` | 35 | 426 |
| `cli` | 42 | 448 (+1 échec attendu) |
| `tests` (intégration) | 26 | 226 |
| **TOTAL** | **277** | **2590 passés · 16 ignorés · 1 échec attendu (2607)** |

### Distinction échec préexistant / nouvel échec

- **Aucun nouvel échec introduit par cet audit** : l'audit n'a modifié aucun fichier source.
- **Un test instable préexistant** documenté (D-04).
- **Aucun échec préexistant attribuable au portage Windows** dans les suites exécutables : les 16 tests ignorés du noyau et les 9 du bridge sont ignorés **par conception** (ils exigent des dispositifs Linux/macOS absents ici), pas en échec.

---

## 13. Non vérifié

Éléments qui **n'ont pas pu être exécutés** pendant cet audit. Aucun n'est présenté comme passant.

| # | Élément non vérifié | Pourquoi | Procédure de reproduction |
|---|---|---|---|
| NV-01 | **Lancement de l'application graphique installée** (fenêtre, pages, thème) | Nécessite une session interactive ; l'audit s'est interdit d'ouvrir l'application | Lancer `C:\Users\San\AppData\Local\Programs\Jarod-OS\Jarod-OS.exe`, vérifier le boot, l'ouverture de chaque page et l'écriture du journal |
| NV-02 | **Appel réel à un modèle de chat** (local ou cloud) | Interdit : aucun profil réel, aucun fournisseur payant | `jarod-core\scripts\verify-jarod-os.ps1` vérifie **la découverte** des modèles et la bascule, pas une génération |
| NV-03 | **Embeddings et RAG de bout en bout** | Les workers sont absents du bundle installé (D-03) | Dans un checkout de développement, `pnpm -r test --filter @jarod/plugin-embeddings` ; dans l'app installée, le chemin est réputé indisponible |
| NV-04 | **Reranker de bout en bout** | Binaire NPU non embarqué ; contrat non branché par défaut | `jarod-core/packages/cli/src/gateway/wire-reranker.ts` (non bundlé) |
| NV-05 | **Voix en direct** (micro, wake word, TTS audible) | Nécessite une entrée audio et un utilisateur | Activer la voix dans les réglages, prononcer le mot-clé, vérifier la transcription et la lecture |
| NV-06 | **Navigateur isolé sur un site réel** | Nécessite une session graphique | Demander une navigation à l'agent, vérifier l'isolation de session et le refus des hôtes locaux |
| NV-07 | **Interaction avec un service externe** (Telegram, Discord, Slack, e-mail, WhatsApp) | Exige des jetons réels, interdits à la lecture | Configurer une passerelle de test dans un profil jetable |
| NV-08 | **Signature / installation AppX sur un Windows propre** | Le paquet est non signé (D-16) ; l'installation exigerait de désactiver la vérification | Installer en mode développeur, ou signer avec un certificat de test |
| NV-09 | **CI distante** | Aucun workflow trouvé (D-07) | Vérifier l'existence réelle de `.github/workflows/` dans un clone frais |
| NV-10 | **Empaquetage macOS et Linux** | `dist:mac` et `dist:linux` exigent les hôtes correspondants | Exécuter sur macOS et Linux respectivement |
| NV-11 | **`bootstrap.ps1` / `sync-upstream.ps1`** | Non exécutés (ils modifient l'état d'une installation Hermes) | Exécuter `npm run bootstrap` puis relancer `verify-windows.ps1` |
| NV-12 | **Comportement de `system_kill_process` sur un processus réel** | Interdiction de tuer un processus non créé par l'audit | Test manuel avec un processus jetable lancé par l'opérateur |
| NV-13 | **Débit/latence (benchmarks)** | Aucun harnais de benchmark trouvé dans ce dépôt | À construire |
| NV-14 | **Accessibilité (lecteur d'écran, navigation clavier)** | Nécessite une session graphique et un outil d'accessibilité | Inspection manuelle + un audit dédié |

---

## 14. Hypothèses

Hypothèses formulées faute de pouvoir les vérifier ici, avec leur niveau de confiance et ce qui les infirmerait.

| # | Hypothèse | Confiance | Ce qui l'infirmerait |
|---|---|---|---|
| H-01 | Le HEAD audité (`0d31942`) est l'état « courant » du projet, et non un commit de travail intermédiaire | **élevée** | Un commit postérieur dans le bundle ou le dépôt local |
| H-02 | `C:\Users\San\herald-os` est bien le dépôt ayant produit les artefacts de `apps/desktop/release/` | **moyenne** | Les artefacts datent du 2026-10-14 21:20 ; le HEAD du 2026-10-14 23:04 ; **des commits ont donc suivi la construction**. L'installateur peut ne pas contenir le HEAD |
| H-03 | `D:\JAROD-OS` (qui ne contient que l'ancien audit) est le dossier de **travail des conversations** référencé par la passerelle, pas un dépôt | **élevée** | Un `package.json` ou un `.git` y apparaissant plus tard |
| H-04 | Les 9 tests ignorés du bridge sont ignorés par indisponibilité `AF_UNIX` sous Windows | **élevée** | La lecture des marqueurs de saut dans les fichiers de test |
| H-05 | `.github/workflows/` existe mais n'a pas été atteint par l'inspection | **faible** | Une inspection récursive complète ; l'inspection directe n'a rien trouvé |
| H-06 | Le portage Windows est complet pour le périmètre couvert par les suites exécutables | **moyenne** | NV-01 (session graphique) et NV-08 (installation) non vérifiés |
| H-07 | Les 4 réglages non portés (`lsp`, `webhooks`, `autoImprovement`, `automationTickMs`) ne sont lus par **aucun** code | **élevée** | Le dépôt l'écrit lui-même en commentaire (`contracts/src/settings.ts`), mais l'absence de lecture n'a pas été prouvée par recherche exhaustive sur tout l'arbre |
| H-08 | L'absence d'OAuth MCP n'est pas compensée par un mécanisme dans le SDK client | **moyenne** | Recherche limitée à `jarod-core/packages/plugins/mcp/src/` et aux types de `settings.ts` |
| H-09 | `plugin-vision` (1 test) et `plugin-workflows` (29 tests) sont fonctionnels malgré la faible couverture | **faible** | Une revue ligne à ligne de ces deux plugins |
| H-10 | Aucun outil du noyau n'échappe au garde unifié | **élevée** | D-18 conclut à l'absence d'échappement après inspection du chemin `tools.register` + `ctx.permissions.gate(...)` ; une injection dynamique d'outil non passée par le registre l'infirmerait |

---

## 15. Top 15 des opportunités

Classement par valeur attendue pour Jarod-OS. **Aucun nom de dépôt.**

| Rang | ID | Opportunité | Pourquoi maintenant | Indicateur de succès |
|---|---|---|---|---|
| 1 | OPP-02 | **Embeddings locaux exécutables sans Python ni `tsx`** | Le RAG est **livré inopérant dans l'application installée** : c'est le seul défaut qui rend une capacité annoncée indisponible pour l'utilisateur final | `rag.enabled = true` produit des vecteurs dans l'app installée, et la recherche rend des résultats |
| 2 | OPP-04 | **Automatisation d'interface Windows** | Le bridge sait déjà lancer, tuer, énumérer et ouvrir. Il ne sait pas **agir dans** une application tierce — c'est la limite la plus visible pour un « système d'exploitation agentique » | Un outil enregistré qui invoque un contrôle d'une fenêtre tierce, avec `Tier` explicite et ligne d'audit |
| 3 | OPP-13 | **Signature et vérification des mises à jour** | Tous les artefacts sont non signés : tout utilisateur Windows voit un avertissement SmartScreen, et rien ne garantit qu'une mise à jour est authentique | Un installateur signé et une mise à jour refusée si la signature manque |
| 4 | OPP-01 | **Index vectoriel embarqué et persistant** | L'index actuel vit en mémoire ; le seul moteur alternatif est un sidecar. Le contrat autorise déjà exactement ce remplacement | L'index survit à un redémarrage et se reconstruit depuis SQLite |
| 5 | OPP-09 | **Orchestration durable avec compensation** | 29 tests pour tout le domaine « workflows », et aucune transaction compensatoire : un échec partiel laisse un état incertain | Un workflow interrompu reprend ou compense, avec un état inspectable |
| 6 | OPP-10 | **Détection d'injection de prompt** | L'agent lit des pages web et des documents puis agit sur le système : le vecteur d'attaque le plus sérieux du produit n'a aujourd'hui aucune défense | Une entrée non fiable est marquée avant d'atteindre le modèle, et le motif est journalisé |
| 7 | OPP-17 | **Bac à sable d'exécution Windows** | Seul Docker est proposé, et par défaut tout tourne `local` : un outil de test n'a aucun confinement | Une commande s'exécute avec capacités minimales sans contourner `authorize()` |
| 8 | OPP-12 | **Rédaction de données sensibles avant envoi** | Le caviardage n'existe que pour l'audit **local** ; rien ne protège l'appel au modèle distant | Une détection locale de PII masque avant l'envoi, hors ligne, en expliquant ses choix |
| 9 | OPP-05 | **OAuth 2 PKCE pour MCP** | Sans lui, seuls les serveurs MCP sans authentification sont joignables : le catalogue MCP distant est de facto inaccessible | Un serveur MCP distant authentifié, jetons dans le coffre, absents des réglages exportables |
| 10 | OPP-03 | **Reranker local léger** | Le contrat existe et le mode fantôme aussi ; il manque un moteur livrable | Un reranker qui rapporte son `EngineInfo{name,version,device}` et dégrade proprement |
| 11 | OPP-15 | **Indexation de documents hétérogènes** | Les parseurs sont maison et le contrat `documentParser` attend déjà un moteur | Un parseur branché sur le contrat, avec provenance et repli texte conservé |
| 12 | OPP-06 | **Détection d'activité vocale** | La voix est un domaine mis en avant, sans segmentation d'entrée | Une entrée audio segmentée, latence < 30 ms, hors ligne |
| 13 | OPP-14 | **Observabilité locale** | Aucune métrique, aucune rotation des logs applicatifs : un défaut de terrain est indiagnostiquable | Exportateur **local** + rotation par taille et par âge, désactivable |
| 14 | OPP-08 | **OCR local multiplateforme** | `system_os ocr` est Linux seulement ; l'analyse d'écran est un usage central | OCR hors ligne FR+EN sur Windows, sans appel réseau |
| 15 | OPP-18 | **Vision locale hors ligne** | `plugin-vision` a 1 test et la description d'image part chez un fournisseur | Une description d'image produite localement, jamais envoyée par défaut |

**Familles d'opportunités à privilégier pour la recherche de dépôts :** (a) inférence **native Node** (napi/WASM) pour les modèles (embeddings, reranker, VAD, OCR, vision) ; (b) **automatisation d'interface Windows** avec arbre d'accessibilité ; (c) **durabilité** (workflows compensables) ; (d) **intégrité** (signature, vérification de mise à jour) ; (e) **défense** (injection de prompt, égress, rédaction de PII).

---

## 16. Annexe JSON

```json
{
  "audit": {
    "date": "2026-10-15",
    "repositories": [
      {
        "path": "C:/Users/San/herald-os",
        "branch": "feature/windows-port",
        "head": "0d3194208edfb69ab9d5b342982b31878ce17a41",
        "dirty": true
      },
      {
        "path": "C:/Users/San/AppData/Local/hermes/hermes-agent",
        "branch": "stable",
        "head": "e06df9c2eae6",
        "dirty": false
      }
    ]
  },
  "capabilities": [
    {
      "id": "CAP-01",
      "domain": "D. Systeme Windows",
      "name": "Automatisation d'interface Windows (arbre d'accessibilite, invocation de controle)",
      "status": "absent",
      "priority": "critical",
      "evidence": ["plugins/herald-os-bridge/bridge/tools.py:1093", "plugins/herald-os-bridge/bridge/tools.py:818"],
      "integrationSeams": ["ToolSpec at plugins/herald-os-bridge/bridge/tools.py:1093", "authorize at plugins/herald-os-bridge/bridge/permissions.py:225"]
    },
    {
      "id": "CAP-02",
      "domain": "H. Extensions et interoperabilite",
      "name": "OAuth 2.1 PKCE pour serveurs MCP distants",
      "status": "absent",
      "priority": "high",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "jarod-core/packages/plugins/mcp/src/index.ts"],
      "integrationSeams": ["McpServerConfig at jarod-core/packages/contracts/src/settings.ts", "McpManager at jarod-core/packages/plugins/mcp/src/mcp.js"]
    },
    {
      "id": "CAP-03",
      "domain": "J. Qualite et exploitation",
      "name": "Signature de code des artefacts distribues",
      "status": "absent",
      "priority": "critical",
      "evidence": ["apps/desktop/package.json", "WINDOWS-PORT-NOTES.md"],
      "integrationSeams": ["electron-builder build.mac.dmg.sign at apps/desktop/package.json", "electron-builder build.win.target at apps/desktop/package.json"]
    },
    {
      "id": "CAP-04",
      "domain": "J. Qualite et exploitation",
      "name": "Metriques et traces applicatives (OpenTelemetry local)",
      "status": "absent",
      "priority": "medium",
      "evidence": ["apps/desktop/electron/log.ts", "apps/desktop/electron/crash/watch.ts"],
      "integrationSeams": ["log at apps/desktop/electron/log.ts", "CrashWatcher at apps/desktop/electron/crash/watch.ts"]
    },
    {
      "id": "CAP-05",
      "domain": "B. Agent et orchestration",
      "name": "Compensation apres echec partiel et idempotence des workflows",
      "status": "partial",
      "priority": "high",
      "evidence": ["jarod-core/packages/plugins/workflows/package.json", "jarod-core/packages/contracts/src/index.ts:86"],
      "integrationSeams": ["ctx.workflows at jarod-core/packages/plugins/workflows/src/index.ts", "JobStatus at jarod-core/packages/contracts/src/index.ts:86"]
    },
    {
      "id": "CAP-06",
      "domain": "F. Voix et multimodal",
      "name": "Detection d'activite vocale (VAD)",
      "status": "absent",
      "priority": "medium",
      "evidence": ["jarod-core/packages/plugins/voice/src/capture.ts", "jarod-core/packages/plugins/voice/src/speech.ts"],
      "integrationSeams": ["ctx.voice at jarod-core/packages/plugins/voice/src/index.ts", "VoicePriority at jarod-core/packages/contracts/src/index.ts:14"]
    },
    {
      "id": "CAP-07",
      "domain": "F. Voix et multimodal",
      "name": "Identification du locuteur",
      "status": "absent",
      "priority": "low",
      "evidence": ["jarod-core/packages/plugins/voice/src/voice.ts"],
      "integrationSeams": ["ctx.voice at jarod-core/packages/plugins/voice/src/index.ts"]
    },
    {
      "id": "CAP-08",
      "domain": "F. Voix et multimodal",
      "name": "Suppression du bruit audio",
      "status": "absent",
      "priority": "low",
      "evidence": ["jarod-core/packages/plugins/voice/src/capture.ts"],
      "integrationSeams": ["ctx.voice at jarod-core/packages/plugins/voice/src/index.ts"]
    },
    {
      "id": "CAP-09",
      "domain": "F. Voix et multimodal",
      "name": "OCR local multiplateforme",
      "status": "absent",
      "priority": "medium",
      "evidence": ["plugins/herald-os-bridge/bridge/tools.py:1000", "jarod-core/packages/plugins/vision/src/vision.ts"],
      "integrationSeams": ["ToolSpec at plugins/herald-os-bridge/bridge/tools.py:1093", "ctx.vision at jarod-core/packages/plugins/vision/src/index.ts"]
    },
    {
      "id": "CAP-10",
      "domain": "G. Applications et recettes",
      "name": "Verification de provenance et de signature des paquets logiciels",
      "status": "absent",
      "priority": "medium",
      "evidence": ["plugins/herald-os-bridge/bridge/host/windows.py", "jarod-core/packages/plugins/updates/src/index.ts"],
      "integrationSeams": ["host() at plugins/herald-os-bridge/bridge/host/base.py", "ctx.updates at jarod-core/packages/plugins/updates/src/index.ts"]
    },
    {
      "id": "CAP-11",
      "domain": "C. Memoire et RAG",
      "name": "Provenance et citations dans les resultats de recherche",
      "status": "partial",
      "priority": "high",
      "evidence": ["jarod-core/packages/contracts/src/domain.ts", "jarod-core/packages/plugins/rag/src/rag.ts"],
      "integrationSeams": ["SearchHit at jarod-core/packages/contracts/src/domain.ts", "ctx.rag at jarod-core/packages/plugins/rag/src/index.ts"]
    },
    {
      "id": "CAP-12",
      "domain": "I. Securite",
      "name": "Detection d'injection de prompt (directe et indirecte)",
      "status": "absent",
      "priority": "high",
      "evidence": ["jarod-core/packages/plugins/agent/src/runtime.ts", "jarod-core/packages/plugins/tools/src/index.ts"],
      "integrationSeams": ["ctx.permissions.gate at jarod-core/packages/plugins/permissions/src/index.ts", "tools.register at jarod-core/packages/plugins/tools/src/"]
    },
    {
      "id": "CAP-13",
      "domain": "I. Securite",
      "name": "Controle d'egression reseau (allowlist de sortie)",
      "status": "absent",
      "priority": "medium",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "jarod-core/packages/plugins/rag/src/vault.ts"],
      "integrationSeams": ["VaultEntry at jarod-core/packages/contracts/src/settings.ts", "ctx.rag.vault at jarod-core/packages/plugins/rag/src/index.ts"]
    },
    {
      "id": "CAP-14",
      "domain": "I. Securite",
      "name": "Redaction de donnees sensibles avant envoi au modele",
      "status": "absent",
      "priority": "high",
      "evidence": ["plugins/herald-os-bridge/bridge/audit.py:16", "jarod-core/packages/contracts/src/secrets.ts"],
      "integrationSeams": ["_compact_args at plugins/herald-os-bridge/bridge/audit.py:19", "secret keys at jarod-core/packages/contracts/src/secrets.ts"]
    },
    {
      "id": "CAP-15",
      "domain": "E. Navigateur",
      "name": "Reprise fiable apres modification du DOM (ciblage stable d'element)",
      "status": "fragile",
      "priority": "medium",
      "evidence": ["jarod-core/packages/contracts/src/browser.ts:12", "apps/desktop/electron/agent-browser/agent-browser.ts:279"],
      "integrationSeams": ["BrowserPort at jarod-core/packages/contracts/src/browser.ts:26", "AgentBrowser at apps/desktop/electron/agent-browser/agent-browser.ts:279"]
    },
    {
      "id": "CAP-16",
      "domain": "I. Securite",
      "name": "Bac a sable d'execution dedie aux tests",
      "status": "absent",
      "priority": "high",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "jarod-core/packages/plugins/tools/src/"],
      "integrationSeams": ["ShellPolicy at jarod-core/packages/contracts/src/settings.ts", "DockerOptions at jarod-core/packages/contracts/src/settings.ts"]
    },
    {
      "id": "CAP-17",
      "domain": "C. Memoire et RAG",
      "name": "Embeddings fonctionnels dans l'application installee",
      "status": "partial",
      "priority": "critical",
      "evidence": ["jarod-core/scripts/bundle-gateway.mjs:9", "jarod-core/packages/plugins/embeddings/package.json"],
      "integrationSeams": ["EmbeddingProvider at jarod-core/packages/contracts/src/ecosystem.ts", "ctx.embeddings at jarod-core/packages/plugins/embeddings/src/index.ts"]
    },
    {
      "id": "CAP-18",
      "domain": "C. Memoire et RAG",
      "name": "Reranker avec moteur livrable",
      "status": "partial",
      "priority": "high",
      "evidence": ["jarod-core/packages/contracts/src/ecosystem.ts", "jarod-core/packages/cli/src/gateway/wire-reranker.ts"],
      "integrationSeams": ["RerankerProvider at jarod-core/packages/contracts/src/ecosystem.ts", "reranker lazy read at jarod-core/packages/plugins/rag/src/index.ts:76"]
    },
    {
      "id": "CAP-19",
      "domain": "C. Memoire et RAG",
      "name": "Index vectoriel persistant et filtrable (embarque)",
      "status": "partial",
      "priority": "high",
      "evidence": ["jarod-core/packages/plugins/rag/src/vector-index.ts", "jarod-core/packages/plugins/rag/src/turbovec.ts"],
      "integrationSeams": ["VectorIndexKind at jarod-core/packages/contracts/src/ecosystem.ts", "VectorIndex at jarod-core/packages/plugins/rag/src/vector-index.ts"]
    },
    {
      "id": "CAP-20",
      "domain": "A. Modeles et fournisseurs",
      "name": "Fournisseurs Ollama et vLLM de premier rang",
      "status": "partial",
      "priority": "medium",
      "evidence": ["jarod-core/packages/plugins/llm/src/lmstudio.ts", "jarod-core/packages/plugins/llm/src/llama-server.ts", "apps/desktop/preload/index.ts:324"],
      "integrationSeams": ["ProviderRouter at jarod-core/packages/plugins/llm/src/providers.ts:23", "catalog.localModels at apps/desktop/preload/index.ts"]
    },
    {
      "id": "CAP-21",
      "domain": "B. Agent et orchestration",
      "name": "Webhooks entrants demarres",
      "status": "absent",
      "priority": "medium",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "jarod-core/packages/plugins/scheduler/package.json"],
      "integrationSeams": ["WebhookRunner at jarod-core/packages/plugins/scheduler/src/", "WebhooksConfig at jarod-core/packages/contracts/src/settings.ts"]
    },
    {
      "id": "CAP-22",
      "domain": "J. Qualite et exploitation",
      "name": "Language servers (LSP) portes",
      "status": "absent",
      "priority": "medium",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "jarod-core/packages/kernel/src/find-on-path.ts"],
      "integrationSeams": ["LspConfig at jarod-core/packages/contracts/src/settings.ts", "find-on-path at jarod-core/packages/kernel/src/find-on-path.ts"]
    },
    {
      "id": "CAP-23",
      "domain": "J. Qualite et exploitation",
      "name": "Auto-amelioration (recherche GitHub hebdomadaire) - capacite volontairement exclue, non portee",
      "status": "absent",
      "priority": "low",
      "evidence": ["jarod-core/packages/contracts/src/auto-improvement-config.ts", "jarod-core/packages/contracts/src/settings.ts"],
      "integrationSeams": ["normalizeAutoImprovementConfig at jarod-core/packages/contracts/src/auto-improvement-config.ts"]
    },
    {
      "id": "CAP-24",
      "domain": "J. Qualite et exploitation",
      "name": "Integration continue a la racine du depot",
      "status": "absent",
      "priority": "high",
      "evidence": ["WINDOWS-PORT-NOTES.md", "apps/desktop/package.json:24"],
      "integrationSeams": ["npm scripts at package.json:38", "verify-windows.ps1 at scripts/verify-windows.ps1"]
    },
    {
      "id": "CAP-25",
      "domain": "J. Qualite et exploitation",
      "name": "Tests de mutation",
      "status": "absent",
      "priority": "low",
      "evidence": ["apps/desktop/package.json:26", "jarod-core/package.json:11"],
      "integrationSeams": ["vitest config at apps/desktop/vitest.config.ts"]
    },
    {
      "id": "CAP-26",
      "domain": "F. Voix et multimodal",
      "name": "Vision locale (description d'image hors ligne)",
      "status": "partial",
      "priority": "medium",
      "evidence": ["jarod-core/packages/plugins/vision/src/vision.ts", "jarod-core/packages/contracts/src/settings.ts"],
      "integrationSeams": ["ctx.vision at jarod-core/packages/plugins/vision/src/index.ts", "ImageDescriptionConfig at jarod-core/packages/contracts/src/settings.ts"]
    },
    {
      "id": "CAP-27",
      "domain": "A. Modeles et fournisseurs",
      "name": "Cout et usage agrege par fournisseur",
      "status": "partial",
      "priority": "medium",
      "evidence": ["jarod-core/packages/cli/src/gateway/usage.ts", "jarod-core/packages/contracts/src/settings.ts"],
      "integrationSeams": ["SessionBudgetConfig at jarod-core/packages/contracts/src/settings.ts", "Usage at jarod-core/packages/contracts/src/domain.ts"]
    },
    {
      "id": "CAP-28",
      "domain": "G. Applications et recettes",
      "name": "Gestionnaire de runtimes (uv, conda, node)",
      "status": "partial",
      "priority": "low",
      "evidence": ["jarod-core/packages/plugins/llm/src/runtimes.ts", "pinokio-runtime/host.cjs"],
      "integrationSeams": ["RuntimeProbeService at jarod-core/packages/plugins/llm/src/runtimes.ts", "ctx.llm.runtimes at jarod-core/packages/plugins/llm/src/index.ts"]
    },
    {
      "id": "CAP-29",
      "domain": "H. Extensions et interoperabilite",
      "name": "Signature et permissions par extension (plugins widget)",
      "status": "partial",
      "priority": "medium",
      "evidence": ["apps/desktop/electron/plugins/host.ts", "jarod-core/packages/contracts/src/settings.ts"],
      "integrationSeams": ["PluginHost at apps/desktop/electron/plugins/host.ts", "PluginTrustEntry at jarod-core/packages/contracts/src/settings.ts"]
    },
    {
      "id": "CAP-30",
      "domain": "D. Systeme Windows",
      "name": "Gestion du registre, des services et des taches planifiees",
      "status": "partial",
      "priority": "medium",
      "evidence": ["plugins/herald-os-bridge/bridge/host/windows.py", "plugins/herald-os-bridge/bridge/host/winps.py"],
      "integrationSeams": ["HostAdapter at plugins/herald-os-bridge/bridge/host/base.py", "ToolSpec at plugins/herald-os-bridge/bridge/tools.py:1093"]
    },
    {
      "id": "CAP-31",
      "domain": "E. Navigateur",
      "name": "Gestion multi-profils et cookies du navigateur de l'agent",
      "status": "partial",
      "priority": "low",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts", "apps/desktop/electron/agent-browser/agent-browser.ts:279"],
      "integrationSeams": ["browserPersistent at jarod-core/packages/contracts/src/settings.ts", "AgentBrowser at apps/desktop/electron/agent-browser/agent-browser.ts:279"]
    },
    {
      "id": "CAP-32",
      "domain": "I. Securite",
      "name": "Chiffrement de bout en bout du relay distant",
      "status": "absent",
      "priority": "low",
      "evidence": ["jarod-core/packages/contracts/src/settings.ts"],
      "integrationSeams": ["RemoteConfig at jarod-core/packages/contracts/src/settings.ts"]
    },
    {
      "id": "CAP-33",
      "domain": "J. Qualite et exploitation",
      "name": "Rotation et retention des journaux applicatifs",
      "status": "partial",
      "priority": "medium",
      "evidence": ["plugins/herald-os-bridge/bridge/audit.py:14", "plugins/herald-os-bridge/bridge/audit.py:51"],
      "integrationSeams": ["record at plugins/herald-os-bridge/bridge/audit.py:33", "log at apps/desktop/electron/log.ts"]
    },
    {
      "id": "CAP-34",
      "domain": "B. Agent et orchestration",
      "name": "Budget et annulation propages dans la delegation aux sous-agents",
      "status": "partial",
      "priority": "medium",
      "evidence": ["jarod-core/packages/plugins/agent/src/subagents.ts", "jarod-core/packages/plugins/agent/src/index.ts"],
      "integrationSeams": ["delegate_task at jarod-core/packages/plugins/agent/src/index.ts", "AgentRuntime at jarod-core/packages/plugins/agent/src/runtime.ts"]
    },
    {
      "id": "CAP-35",
      "domain": "C. Memoire et RAG",
      "name": "Oubli et suppression programmes en memoire longue",
      "status": "partial",
      "priority": "medium",
      "evidence": ["jarod-core/packages/contracts/src/domain.ts", "jarod-core/packages/plugins/memory/src/"],
      "integrationSeams": ["MemoryType at jarod-core/packages/contracts/src/domain.ts", "ctx.memory at jarod-core/packages/plugins/memory/src/index.ts"]
    },
    {
      "id": "CAP-36",
      "domain": "C. Memoire et RAG",
      "name": "Export et import chiffre du profil",
      "status": "partial",
      "priority": "low",
      "evidence": ["jarod-core/packages/cli/src/gateway/portability.ts", "jarod-core/packages/cli/src/gateway/hermes-import.ts"],
      "integrationSeams": ["portability at jarod-core/packages/cli/src/gateway/portability.ts", "hermes-import at jarod-core/packages/cli/src/gateway/hermes-import.ts"]
    },
    {
      "id": "CAP-37",
      "domain": "D. Systeme Windows",
      "name": "Raccourcis globaux hors combinaisons reservees par Windows",
      "status": "partial",
      "priority": "low",
      "evidence": ["WINDOWS-PORT-NOTES.md", "apps/desktop/electron/ipc/voice.ts"],
      "integrationSeams": ["applyVoiceHotkey at apps/desktop/electron/ipc/voice.ts", "globalShortcut at apps/desktop/electron/main.ts:519"]
    },
    {
      "id": "CAP-38",
      "domain": "A. Modeles et fournisseurs",
      "name": "Streaming et annulation uniformes sur tous les fournisseurs",
      "status": "verified",
      "priority": "low",
      "evidence": ["jarod-core/packages/contracts/src/llm.ts", "jarod-core/packages/plugins/llm/src/index.ts"],
      "integrationSeams": ["ProviderRouter at jarod-core/packages/plugins/llm/src/providers.ts:23", "llm contract at jarod-core/packages/contracts/src/llm.ts"]
    },
    {
      "id": "CAP-39",
      "domain": "I. Securite",
      "name": "Garde de permissions fail-closed a 4 niveaux avec chemins proteges",
      "status": "verified",
      "priority": "low",
      "evidence": ["plugins/herald-os-bridge/bridge/permissions.py:225", "plugins/herald-os-bridge/bridge/tools.py:83"],
      "integrationSeams": ["authorize at plugins/herald-os-bridge/bridge/permissions.py:225", "_guarded at plugins/herald-os-bridge/bridge/tools.py:83"]
    },
    {
      "id": "CAP-40",
      "domain": "H. Extensions et interoperabilite",
      "name": "Decouverte et injection de plugins du noyau (Cordis)",
      "status": "verified",
      "priority": "low",
      "evidence": ["jarod-core/packages/kernel/src/registry.ts:38", "jarod-core/packages/kernel/src/lifecycle.ts:52"],
      "integrationSeams": ["discoverPlugins at jarod-core/packages/kernel/src/registry.ts:38", "setBundledPlugins at jarod-core/packages/kernel/src/registry.ts:31", "start at jarod-core/packages/kernel/src/lifecycle.ts:52"]
    }
  ],
  "opportunities": [
    {
      "id": "OPP-01",
      "capability": "Index vectoriel embarque, persistant et filtrable",
      "solves": ["CAP-19"],
      "priority": "high",
      "keywords": ["vector index sqlite", "ann index embedded", "hnsw library", "approximate nearest neighbour"],
      "preferredLanguages": ["Rust", "C", "C++", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["identifiants entiers JSON surs", "allowlist d'identifiants", "reconstruction depuis SQLite", "aucun acces reseau"],
      "acceptanceCriteria": ["l'index survit a un redemarrage", "se reconstruit depuis rag_chunks", "respecte VectorSearchRequest", "repli sur l'index memoire"],
      "rejectionCriteria": ["format proprietaire", "serveur obligatoire", "licence AGPL pour embarque"]
    },
    {
      "id": "OPP-02",
      "capability": "Embeddings locaux executables sans Python ni tsx",
      "solves": ["CAP-17"],
      "priority": "critical",
      "keywords": ["onnx runtime embedding", "sentence transformers onnx", "text embedding inference native", "napi inference"],
      "preferredLanguages": ["C++", "Rust", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucun telechargement implicite de modele", "aucun appel reseau au premier usage", "aucune execution de script tiers"],
      "acceptanceCriteria": ["fonctionne depuis un bundle esbuild sans tsx", "respecte EmbeddingModelSpec", "rapporte EngineInfo device effectif"],
      "rejectionCriteria": ["necessite un interpreteur Python", "telecharge un modele sans consentement", "binaire opaque sans source"]
    },
    {
      "id": "OPP-03",
      "capability": "Reranker local leger executable en Node",
      "solves": ["CAP-18"],
      "priority": "high",
      "keywords": ["cross encoder reranker onnx", "text reranking library", "bge reranker onnx"],
      "preferredLanguages": ["C++", "Rust", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["journal sans texte", "aucun envoi reseau"],
      "acceptanceCriteria": ["modele inferieur a 500 Mo", "degrade avec available false", "rapporte EngineInfo"],
      "rejectionCriteria": ["CUDA exclusif", "licence non commerciale", "service obligatoire"]
    },
    {
      "id": "OPP-04",
      "capability": "Automatisation d'interface Windows via arbre d'accessibilite",
      "solves": ["CAP-01"],
      "priority": "critical",
      "keywords": ["uiautomation python", "windows accessibility tree", "ui automation driver", "windows gui automation"],
      "preferredLanguages": ["Python", "C#", "Rust"],
      "integrationMode": "sidecar",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["Tier explicite par action", "passage par _guarded", "respect des chemins proteges", "audit automatique"],
      "acceptanceCriteria": ["invocation d'un motif d'accessibilite", "pas de clic par coordonnees seules", "ligne audit.jsonl ecrite"],
      "rejectionCriteria": ["contourne authorize", "shell arbitraire", "injection d'evenements sans arbre"]
    },
    {
      "id": "OPP-05",
      "capability": "Client OAuth 2.1 PKCE avec decouverte pour MCP",
      "solves": ["CAP-02"],
      "priority": "high",
      "keywords": ["mcp oauth client", "oauth2 pkce client", "dynamic client registration", "protected resource metadata"],
      "preferredLanguages": ["TypeScript", "Rust", "Go"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": false,
      "securityRequirements": ["jetons dans le coffre", "jetons hors des reglages exportables", "allowlist d'hotes"],
      "acceptanceCriteria": ["serveur MCP distant authentifie joignable", "jeton non present dans config/raw", "repli sur en-tete manuel"],
      "rejectionCriteria": ["stockage de jeton en clair", "compte proprietaire impose", "service cloud obligatoire"]
    },
    {
      "id": "OPP-06",
      "capability": "Detection d'activite vocale locale en flux",
      "solves": ["CAP-06"],
      "priority": "medium",
      "keywords": ["voice activity detection onnx", "silero vad", "webrtcvad", "streaming vad"],
      "preferredLanguages": ["C++", "Rust", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucune dependance reseau", "aucune donnee audio persistee"],
      "acceptanceCriteria": ["latence inferieure a 30 ms", "trames de 10 a 30 ms", "desactivable"],
      "rejectionCriteria": ["AGPL pour embarque", "binaire opaque", "service cloud"]
    },
    {
      "id": "OPP-07",
      "capability": "Suppression de bruit temps reel",
      "solves": ["CAP-08"],
      "priority": "low",
      "keywords": ["noise suppression realtime", "rnnoise", "speech enhancement onnx"],
      "preferredLanguages": ["C", "C++", "Rust"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucune donnee audio persistee", "desactivable"],
      "acceptanceCriteria": ["temps reel sur CPU", "48 kHz", "latence inferieure a 50 ms"],
      "rejectionCriteria": ["licence non commerciale", "latence superieure a 50 ms"]
    },
    {
      "id": "OPP-08",
      "capability": "OCR local multiplateforme hors ligne",
      "solves": ["CAP-09"],
      "priority": "medium",
      "keywords": ["ocr onnxruntime", "tesseract wasm", "paddleocr onnx", "text detection recognition"],
      "preferredLanguages": ["C++", "Rust", "Python", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucun appel reseau", "aucune image persistee hors demande"],
      "acceptanceCriteria": ["langues FR et EN", "taille inferieure a 200 Mo", "fonctionne hors ligne"],
      "rejectionCriteria": ["envoie l'image a un service", "telemetrie obligatoire", "binaire opaque"]
    },
    {
      "id": "OPP-09",
      "capability": "Orchestration durable de workflows avec compensation",
      "solves": ["CAP-05"],
      "priority": "high",
      "keywords": ["durable execution workflow", "saga pattern orchestration", "workflow checkpointing", "idempotent task orchestrator"],
      "preferredLanguages": ["Go", "TypeScript", "Rust", "Java"],
      "integrationMode": "sidecar",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["sidecar local", "aucun service manage", "etat inspectable"],
      "acceptanceCriteria": ["compensations declarees", "reprise apres arret brutal", "budget par noeud"],
      "rejectionCriteria": ["service cloud obligatoire", "licence BUSL si embarque", "duplique plugin-workflows sans gain"]
    },
    {
      "id": "OPP-10",
      "capability": "Detection d'injection de prompt directe et indirecte",
      "solves": ["CAP-12"],
      "priority": "high",
      "keywords": ["prompt injection detection", "indirect prompt injection classifier", "llm input sanitization", "guardrails library"],
      "preferredLanguages": ["Python", "TypeScript", "Rust"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["decision avant envoi au modele", "sortie typee sans texte libre", "journalisation du motif"],
      "acceptanceCriteria": ["marque une entree non fiable sans la bloquer", "hors ligne", "aucun appel API par requete"],
      "rejectionCriteria": ["necessite un appel API par requete", "sans licence", "detection opaque non explicable"]
    },
    {
      "id": "OPP-11",
      "capability": "Controle d'egression reseau par allowlist locale",
      "solves": ["CAP-13"],
      "priority": "medium",
      "keywords": ["egress allowlist proxy", "local http proxy", "network egress control"],
      "preferredLanguages": ["Go", "Rust", "TypeScript"],
      "integrationMode": "sidecar",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["mode observation sans blocage", "approbation utilisateur des hotes", "journal des sorties"],
      "acceptanceCriteria": ["journalise avant de bloquer", "allowlist explicite", "desactivable"],
      "rejectionCriteria": ["dechiffre sans consentement", "service cloud obligatoire"]
    },
    {
      "id": "OPP-12",
      "capability": "Redaction locale de donnees sensibles avant envoi au modele",
      "solves": ["CAP-14"],
      "priority": "high",
      "keywords": ["pii detection library", "data redaction", "sensitive data scanner", "offline anonymization"],
      "preferredLanguages": ["Python", "TypeScript", "Rust"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["fonctionne hors ligne", "explique ce qui est masque", "aucun envoi du texte a un tiers"],
      "acceptanceCriteria": ["langues FR et EN", "sortie typee avec spans", "aucune dependance reseau"],
      "rejectionCriteria": ["envoie le texte a un service d'analyse", "modele telecharge sans consentement"]
    },
    {
      "id": "OPP-13",
      "capability": "Signature et verification de mise a jour",
      "solves": ["CAP-03", "CAP-24"],
      "priority": "critical",
      "keywords": ["code signing windows", "update signature verification", "minisign", "sigstore"],
      "preferredLanguages": ["Rust", "Go", "C++", "TypeScript"],
      "integrationMode": "dev-tool",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["verification avant installation", "refus si signature absente", "cle publique hors du depot"],
      "acceptanceCriteria": ["installateur signe", "mise a jour refusee si signature invalide"],
      "rejectionCriteria": ["cle privee dans le depot", "service payant obligatoire"]
    },
    {
      "id": "OPP-14",
      "capability": "Observabilite locale avec rotation des journaux",
      "solves": ["CAP-04", "CAP-33"],
      "priority": "medium",
      "keywords": ["opentelemetry file exporter", "log rotation library", "structured logging", "local telemetry"],
      "preferredLanguages": ["TypeScript", "Go", "Rust"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["exportateur fichier local", "aucun point de terminaison distant par defaut", "desactivable"],
      "acceptanceCriteria": ["rotation par taille et par age", "desactive par defaut si distant"],
      "rejectionCriteria": ["backend SaaS exige", "telemetrie par defaut"]
    },
    {
      "id": "OPP-15",
      "capability": "Parseur de documents heterogenes avec provenance",
      "solves": ["CAP-11"],
      "priority": "medium",
      "keywords": ["document parser library", "incremental document ingestion", "pdf docx xlsx extraction", "document chunking strategy"],
      "preferredLanguages": ["Python", "Rust", "TypeScript"],
      "integrationMode": "sidecar",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["chemins de worker explicites", "repli texte conserve", "aucun envoi reseau"],
      "acceptanceCriteria": ["branche sur ecosystem.documentParser", "provenance conservee", "repli sur parser-fallback"],
      "rejectionCriteria": ["AGPL pour embarque", "modele et serveur obligatoires"]
    },
    {
      "id": "OPP-16",
      "capability": "Orchestration de sous-agents avec budget et annulation",
      "solves": ["CAP-34"],
      "priority": "medium",
      "keywords": ["multi agent orchestration", "agent supervisor tree", "budgeted agent delegation", "agent cancellation"],
      "preferredLanguages": ["Python", "TypeScript", "Go"],
      "integrationMode": "reference",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["s'integre au registre d'outils existant", "ne cree pas un second systeme de permissions", "sous-agents en lecture seule"],
      "acceptanceCriteria": ["arbre de taches", "budget par noeud", "annulation propagee via signal"],
      "rejectionCriteria": ["impose son propre runtime LLM", "duplique le garde de permissions", "service cloud"]
    },
    {
      "id": "OPP-17",
      "capability": "Bac a sable d'execution Windows natif",
      "solves": ["CAP-16"],
      "priority": "high",
      "keywords": ["windows sandbox execution", "appcontainer isolation", "job object sandbox", "restricted token process"],
      "preferredLanguages": ["C++", "Rust", "C#"],
      "integrationMode": "sidecar",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["ne contourne pas authorize", "capacites minimales", "echappement impossible vers chemins proteges"],
      "acceptanceCriteria": ["execution sans reseau et sans ecriture hors dossier jetable", "repli explicite si indisponible", "trace conservee"],
      "rejectionCriteria": ["contourne le garde", "pilote noyau non auditable", "desactive l'audit"]
    },
    {
      "id": "OPP-18",
      "capability": "Vision locale hors ligne (description d'image)",
      "solves": ["CAP-26"],
      "priority": "medium",
      "keywords": ["local vision model onnx", "image captioning onnxruntime", "vlm local inference", "clip onnx"],
      "preferredLanguages": ["C++", "Rust", "Python", "TypeScript"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucun envoi reseau par defaut", "respecte imageDescription.mode", "rapporte EngineInfo"],
      "acceptanceCriteria": ["description produite hors ligne", "CPU acceptable", "desactivable"],
      "rejectionCriteria": ["envoie l'image a un service", "licence non commerciale"]
    },
    {
      "id": "OPP-19",
      "capability": "Fusion de bases locales sans perte (offline first)",
      "solves": ["CAP-36"],
      "priority": "low",
      "keywords": ["sqlite merge conflict", "offline first sync library", "bidirectional sync", "local first database"],
      "preferredLanguages": ["Rust", "TypeScript", "Go"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["aucune ligne perdue", "detection de conflit", "journal"],
      "acceptanceCriteria": ["fonctionne sur base synthetique", "aucun serveur central"],
      "rejectionCriteria": ["serveur central obligatoire", "perte de donnees silencieuse"]
    },
    {
      "id": "OPP-20",
      "capability": "Raccourcis globaux Windows hors combinaisons reservees",
      "solves": ["CAP-37"],
      "priority": "low",
      "keywords": ["windows global hotkey library", "low level keyboard hook", "registerhotkey wrapper"],
      "preferredLanguages": ["C++", "Rust", "C#"],
      "integrationMode": "library",
      "licenseAllow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"],
      "licenseRejectForEmbedding": ["AGPL-3.0", "SSPL-1.0", "BUSL"],
      "windowsNative": true,
      "offlinePreferred": true,
      "securityRequirements": ["ne capture pas les raccourcis systeme", "desactivable", "journalise"],
      "acceptanceCriteria": ["aucun raccourci Win+ enregistre", "repli utilisateur documente"],
      "rejectionCriteria": ["installe un pilote clavier", "capture les raccourcis systeme"]
    }
  ],
  "excludedRepositories": [
    {
      "repository": "anywhere-labs/dsh-next",
      "reason": "already evaluated"
    },
    {
      "repository": "fentz26/dsh-next",
      "reason": "already evaluated"
    },
    {
      "repository": "NousResearch/hermes-agent-self-evolution",
      "reason": "excluded: auto-improvement deliberately excluded by Jarod-OS (CLI Q1 decision, 2026-10-02)"
    },
    {
      "repository": "linshenkx/prompt-optimizer",
      "reason": "already evaluated"
    },
    {
      "repository": "harness/harness",
      "reason": "already evaluated"
    },
    {
      "repository": "browser-use/browser-harness",
      "reason": "already evaluated"
    },
    {
      "repository": "browser-use/browser-use",
      "reason": "already evaluated"
    },
    {
      "repository": "pinokiocomputer/pinokio",
      "reason": "already used: pinokio-runtime/host.cjs is bundled in the Windows installer"
    },
    {
      "repository": "kaonomi-net/mari",
      "reason": "already evaluated"
    },
    {
      "repository": "modelcontextprotocol/typescript-sdk",
      "reason": "already used: @modelcontextprotocol/client is a devDependency of jarod-core/packages/cli"
    },
    {
      "repository": "microsoft/playwright",
      "reason": "already evaluated"
    },
    {
      "repository": "pywinauto/pywinauto",
      "reason": "already evaluated"
    },
    {
      "repository": "k2-fsa/sherpa-onnx",
      "reason": "already evaluated"
    },
    {
      "repository": "microsoft/markitdown",
      "reason": "already evaluated"
    },
    {
      "repository": "data-privacy-stack/presidio",
      "reason": "already evaluated"
    },
    {
      "repository": "promptfoo/promptfoo",
      "reason": "already evaluated"
    },
    {
      "repository": "open-telemetry/opentelemetry-js",
      "reason": "already evaluated"
    },
    {
      "repository": "microsoft/winget-cli",
      "reason": "already used: referenced by the machine audit for the Windows fix command"
    },
    {
      "repository": "temporalio/temporal",
      "reason": "already evaluated"
    },
    {
      "repository": "microsoft/autogen",
      "reason": "already evaluated"
    },
    {
      "repository": "NousResearch/hermes-agent",
      "reason": "already used: upstream/hermes-agent is pinned, and Hermes is a first-class fallback backend"
    },
    {
      "repository": "anywhere-labs/dsh-desktop",
      "reason": "already evaluated"
    },
    {
      "repository": "co-l/openfox",
      "reason": "already watched: a local checkout exists, not integrated"
    },
    {
      "repository": "fathah/hermes-desktop",
      "reason": "already evaluated"
    }
  ]
}
```

---

**Fin du rapport. Aucun fichier source n'a été modifié, aucun commit n'a été créé, aucun push n'a été effectué. En attente de validation.**
