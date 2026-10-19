# Jarod-OS : taille de la couture entre le shell de Herald et un noyau Jarod

Mesure en lecture seule, 2026-10-11. Question : si le shell de Herald garde son interface et que le moteur Hermes est remplacé par le noyau de jarod-cordis, qu'est-ce que le shell appelle réellement, et combien de cela le noyau sait-il déjà servir ?

## Méthode

- **Côté Herald** : extraction par script de tout ce que `apps/desktop/{src,electron,shared}` (329 fichiers TS/TSX hors tests) envoie au moteur. Un seul point d'entrée existe pour le RPC : `gatewayRequest()` de `src/store/gateway.ts` (10 fichiers l'importent). Aucun appel à méthode dynamique trouvé. Les événements viennent de `onGatewayEvent`, `onAnyGatewayEvent` et des ensembles `CHAT_EVENTS`, `SUBAGENT_EVENTS`, `STUDIO_EVENTS`. Le REST est repéré par les chaînes `/api/…`.
- **Côté Jarod** : présence d'un service ou d'un gestionnaire équivalent dans `packages/plugins/*` et `packages/desktop/src/main/handlers/*`. **J'ai vérifié qu'un service existe, pas que sa sémantique et ses formats de données correspondent.** Les formes exactes (`session.info`, charges des outils…) sont dans un fichier généré de 5 657 lignes que je n'ai pas comparé.

## La couture est un serveur local, pas du code partagé

Herald parle à son moteur par un serveur sur `127.0.0.1` : WebSocket JSON-RPC (`/api/ws?token=…`) pour les sessions et le flux, REST (`/api/…`, jeton `X-Hermes-Session-Token`) pour le reste (`docs/ARCHITECTURE.md`, « Backend lifecycle »).
Le mode **coexistence** existe déjà : `JAROD_OS_BACKEND_URL` + `JAROD_OS_BACKEND_TOKEN` (`electron/backend/coexist.ts`) font attacher le shell à un backend déjà lancé, sans le démarrer lui-même.
Conséquence : un « Jarod gateway » (serveur Node dans le noyau de Jarod parlant ce protocole) se teste avec le shell de Herald **sans modifier le shell**.

## Ce que le shell appelle (≈ 45 points d'entrée et 30 types d'événement, contre 244 méthodes dans le contrat complet : ≈ 18 %)

### RPC (19 méthodes)

| Méthode | Utilisée par | Équivalent dans Jarod (vérifié : existence) | Verdict |
|---|---|---|---|
| `session.create`, `session.resume`, `session.list`, `session.delete`, `session.interrupt` | `chat.ts`, `sessions.ts` | service de sessions, `handlers/sessions.ts` (`list-sessions`, `delete-session`, `get-session-messages`…) ; arrêt de tour via `AbortSignal` | couvert ; `resume` doit rendre un tour en cours (`inflight`) : à écrire |
| `prompt.submit` | `chat.ts` | exécution d'un tour de l'agent (`agent:submit`, DECISIONS 2026-09-26) | couvert |
| `commands.catalog`, `slash.exec` | `use-slash-catalog.ts`, `catalog.ts` | `plugins/agent/src/{commands,builtin-commands}.ts` | couvert ; format du catalogue à convertir |
| `config.get`, `config.set` | `AgentsSection.tsx` | service de réglages (DTO `Settings`, 54 clés) | à convertir : les clés de Hermes et celles de Jarod diffèrent |
| `model.options` | `AgentsSection.tsx` | routeur de modèles (`plugins/llm`), `handlers/models.ts` | couvert ; conversion |
| `llm.oneshot` | `continuity.ts` | aucun point d'entrée nommé trouvé ; les fournisseurs savent répondre | à écrire (petit) |
| `billing.state`, `usage.bars` | `usage.ts` | pas d'abonnement ; les jetons par tour existent (`anthropic.ts:181-195`) mais pas de « barres » | neutraliser (valeurs vides) ou écrire |
| `wake.start/stop/pause/resume/feed` | `wake.ts` | plugin vocal, mot d'activation sur NPU, `voice-capture-feed` (PHASE-3) | couvert ; conversion |

### Événements du flux (30 types)

| Groupe | Types | Verdict |
|---|---|---|
| Conversation (13) | `message.start/delta/interim/complete`, `thinking.delta`, `reasoning.delta`, `tool.start/complete`, `status.update`, `session.title/info/usage`, `error` | l'agent de Jarod émet déjà texte, pensée et outils à son renderer ; **conversion de forme** |
| Sous-agents (6) | `subagent.spawn_requested/start/progress/thinking/tool/complete` | `plugins/agent/src/subagents.ts` ; conversion |
| Missions | `todo.updated` | **aucun outil `todo` dans cordis** (il existe dans Jarod-one) : la page Missions n'aurait pas de source |
| Application | `cron.changed`, `notification.show/clear`, `request.cancel`, `wake.detected` | planificateur, notifications, vocal : couverts ; conversion |
| Spécifiques à Hermes (5) | `skin.changed`, `tool.generating`, `agent.terminal.output`, `terminal.close`, `preview.open` (Studio) | `skin.changed` à neutraliser ; les quatre du Studio viennent d'outils de Hermes Desktop qui n'existent pas dans Jarod : **absents** |

### Requêtes serveur → shell (4)

| Requête | Verdict |
|---|---|
| `approval` | couvert : l'accord des outils sensibles de Jarod (`hooks.approve`) |
| `secret` | probable : le coffre de Jarod ; à vérifier |
| `clarify` | **absent** dans cordis (l'outil `ask_user` n'est que dans Jarod-one) |
| `sudo` | sans objet sous Windows |

### REST (22 routes)

| Routes | Verdict |
|---|---|
| `/api/status` | trivial |
| `/api/config`, `/api/config/raw` | conversion (voir `config.get`) |
| `/api/cron/jobs`, `/api/cron/delivery-targets` | planificateur couvert |
| `/api/memory` | mémoire couverte |
| `/api/mcp/servers`, `/api/mcp/catalog`, `/api/mcp/catalog/install` | serveurs couverts ; le catalogue est à vérifier |
| `/api/tools/toolsets`, `…/memory`, `/api/tools/terminal/backend(s)` | Jarod active ou désactive des outils un par un, sans notion de « toolset » : conversion |
| `/api/messaging/platforms` | passerelles couvertes (Telegram, Discord, Slack) |
| `/api/sessions/{id}` | couvert |
| `/api/audio/transcribe` | couvert (whisper) |
| `/api/audio/speak`, `…/speak-stream`, `…/voice-live/*` | synthèse vocale locale seulement (SAPI) ; `speak-stream` et `voice-live` : **aucun équivalent trouvé** |
| `/api/providers/oauth` (+ sessions) | **absent à dessein** : Jarod masque les comptes et l'OAuth (« non disponible », UI-PARITE § 24) |
| `/api/analytics/usage` | absent |

## Bilan

- **À peu près 60 %** des entrées ont un service derrière elles dans le noyau. Elles demandent surtout de la **conversion** (noms de réglages, formes d'événements), pas de nouvelles fonctions.
- **À écrire** (petit à moyen) : `llm.oneshot`, la reprise de tour en cours, l'agrégation d'usage, un outil `todo`.
- **À neutraliser** (valeurs vides, le shell ne plante pas) : facturation, abonnements, `skin.changed`, `sudo`.
- **Absents** : `clarify`, les quatre événements du Studio (la fonction « build … » du shell), `speak-stream` et `voice-live`, l'OAuth des comptes.
- Le Studio (build d'applications avec terminal et aperçu) est le plus gros trou fonctionnel : il repose sur des outils que seul Hermes fournit.

## Ce que ça change pour `jarod-herald-reuse.md`

Si le shell de Herald est conservé, **`os_ui` redevient un petit portage** et non un chantier L : le serveur de commandes (153) vit dans le processus principal d'Electron, et `ui.py` n'est qu'un client JSON de ≈ 130 lignes (`tcp://127.0.0.1:<port>` + jeton). Un client TypeScript et un outil `os_ui` dans le noyau de Jarod suffisent : **S à M**. Les 12 autres outils restent à porter comme décrit (phases 1 à 3).

## Ce qui n'est pas mesuré

- Les formes exactes des charges (fichier généré de 5 657 lignes) : c'est là que se cache le travail de conversion.
- L'ampleur du Studio et des pages (Missions, Mémoire, Automatisations, Connexions) quand les données du noyau sont de forme différente.
- Les extractions sont des recherches de chaînes littérales : une méthode appelée par un nom construit à l'exécution ne serait pas vue (aucun appel dynamique trouvé dans les 10 fichiers qui importent `gateway.ts`).
- Le comportement réel du shell face à un serveur incomplet : il faut l'essayer.

## Étape suivante proposée : un essai de deux jours

Un serveur minimal dans le noyau de Jarod : `/api/status`, `/api/ws`, `session.create`, `prompt.submit`, les événements de conversation et `approval`. Critère : dans le shell de Herald lancé en mode coexistence, une phrase tapée arrive au noyau de Jarod, la réponse s'affiche en flux, un outil sensible demande un accord. Aucune modification du shell. Si cela marche, le reste est de la conversion ; sinon, on le saura avant d'avoir engagé le reste.

---

## Résultat de l'essai (2026-10-11)

**Réalisé** dans la copie `D:\store\projet\jarod-cordis`, branche `spike/hermes-gateway`, fichiers nouveaux seulement (non commités) : `packages/cli/src/gateway/{ws,protocol,server,main,demo}.ts` et trois fichiers de test (≈ 1 300 lignes). Serveur WebSocket écrit à la main (aucune dépendance ajoutée). Aucun fichier de `S:\` touché ; vos modifications en cours dans la copie sont intactes.

**Vérifié**
- 30 tests verts, typecheck du paquet propre. Un test de bout en bout lance le **vrai noyau** (profil temporaire, base chiffrée, agent, outils) derrière la passerelle avec un faux fournisseur de modèle et un vrai client WebSocket. Casser volontairement l'accord (`isApproved` → toujours vrai) fait échouer deux tests : ils détectent bien l'erreur. Les tests ont aussi révélé un défaut réel, corrigé (un second `prompt.submit` refusé effaçait le tour en cours).
- **Le vrai shell de Herald, sans aucune modification**, attaché par `JAROD_OS_BACKEND_URL` / `JAROD_OS_BACKEND_TOKEN` : il démarre et affiche « HERMES IS READY » ; une phrase tapée dans son champ de saisie arrive au noyau de Jarod et la réponse s'affiche en flux ; un outil sensible (`write_file`) fait apparaître la carte d'accord de Herald (« Allow once » / « Deny ») ; « Allow once » écrit le fichier, « Deny » ne l'écrit pas et le refus remonte dans la conversation. Les clics et la saisie sont des événements Chromium réels, dans la page seulement.

**Ce que le shell a demandé sans l'obtenir au démarrage** (répondu 404 / -32601, consigné) : `usage.bars`, `billing.state`, **`client.capabilities`** (absente de ma liste statique : l'extraction par recherche de chaînes sous-estimait la couture), `GET /api/memory`, `/api/cron/jobs`, `/api/analytics/usage`, `/api/config/raw`, `/api/providers/oauth`. Le shell reste utilisable : ses pages concernées affichent « not reachable » ou vide.

**Constats à traiter**
1. **Dossier de travail** : Herald envoie son propre dossier courant à `session.create` (ici le dossier personnel), et Jarod y confine ses outils fichiers : un `write_file` a écrit dans `C:\Users\San`. Pas un défaut du port, mais une décision : quel dossier de travail pour Jarod-OS ? (J'ai supprimé ce fichier de démonstration.)
2. **Historique** : à la reprise, les messages d'assistant qui ne portent que des appels d'outil reviennent avec un texte vide (le contrat de Hermes les représente autrement). Les conversations sont bien rangées dans la base de Jarod ; l'écran d'historique de Herald n'a pas été exercé (rechargée, la page ouvre une conversation neuve).
3. Hors essai : le Studio, `clarify`, la voix en flux, l'OAuth (voir plus haut).

**Mesure de l'effort** : le noyau de la conversation (sessions, tour en flux, accord) tient en ≈ 660 lignes de code hors tests (ws, protocol, server ; ≈ 780 avec les deux points d'entrée) et a marché sans toucher au noyau ni au shell. Le reste de la couture est de la conversion de formes, comme prévu. L'incertitude restante se déplace vers les pages (Mémoire, Automatisations, Connexions, Réglages) et le Studio.

**Incident de méthode** : `pnpm --filter … typecheck` a déclenché une installation automatique dans la copie (retéléchargement du runtime OpenVINO, recompilation de modules natifs). Lockfile et fichiers suivis inchangés ; je n'ai plus utilisé que les binaires locaux (`node_modules/.bin/tsc`, `vitest`).

### Suite de l'essai — pages Automatisations et Mémoire (2026-10-11)

Ajouté dans la passerelle (`gateway/rest.ts`, 2 routes en lecture, ≈ 60 lignes) : `GET /api/cron/jobs` (le planificateur réel de Jarod, `core.scheduler.list()`) et `GET /api/memory` (nombre d'entrées de `core.memory.list()`). Les règles de Jarod sont traduites dans le vocabulaire du shell : `daily` devient une expression cron, `interval`, `cron` et `once` passent tels quels ; une planification coupée est `paused`, sans prochain passage.

**Vérifié dans le vrai shell** (démo : une planification quotidienne 08:30 et une entrée de mémoire) :
- Automatisations : la carte « Bilan du matin », « Every morning at 8:30 », « Next run: Tomorrow, 8:30 », le détail en trois étapes. Accents corrects.
- Aperçu : « Memory up to date — 1 entry remembered ».
- Tests : 34 verts (4 de plus), typecheck propre ; une mutation (planification coupée rendue active) fait échouer un test.

**Constats, à traiter avant de dire que ces pages sont portées :**
1. **La page Mémoire du shell ne passe pas par la passerelle.** Elle lit et écrit `MEMORY.md` et `USER.md` dans `$HERMES_HOME/memories/` (`features/memory/memory-store.ts`), côté Herald. Résultat observé : la carte de l'Aperçu affiche 1 entrée (venue de Jarod), la page Mémoire « 0 memories ». Deux magasins ; choix à faire : refléter la mémoire de Jarod dans ces fichiers, ou adapter `memory-store.ts` pour interroger la passerelle.
2. **Les écritures ne sont pas servies** : « Run now », « Save changes », création, pause, suppression d'une automatisation renvoient 404 (consignées). Il faut `POST/PUT/DELETE /api/cron/jobs…` et l'historique `GET /api/cron/jobs/{id}/runs`.
3. Toujours non servis, vus pendant la navigation : `client.capabilities`, `usage.bars`, `billing.state` (le shell les traite comme optionnels et affiche « indisponible »), `GET /api/analytics/usage`, `/api/config/raw`, `/api/providers/oauth`, `/api/cron/delivery-targets`, `/api/tools/toolsets`. `/api/providers/oauth` n'est volontairement PAS servi vide : Jarod a du code OAuth côté desktop (`hermes-api.ts`, `account.ts`), je n'ai pas vérifié ce qu'il couvre.
4. Le serveur déclare maintenant `application/json; charset=utf-8` (PowerShell 5.1 lisait les accents en ISO-8859-1 sans cela).

### Décision prise — dossier de travail de Jarod-OS (2026-10-11)

Choix de l'utilisateur : `D:\JAROD-OS` (dossier vide à la date du choix). Mise en œuvre dans la passerelle : option `workspace` (`--workspace <dossier>` ou `JAROD_WORKSPACE`, absolu et existant, sinon refus avec code 2). Règle (`chooseWorkspace`, `protocol.ts`) : le dossier courant que Herald envoie (ici le dossier personnel) est ignoré ; il n'est retenu que s'il désigne la base ou un sous-dossier de la base (comparaison insensible à la casse sous Windows, chemin relatif et autre lecteur refusés). Les outils fichiers de Jarod s'y confinent déjà (`resolveInWorkspace`).

Vérifié : 39 tests verts, typecheck propre ; un test avec le vrai noyau envoie `cwd` = un autre dossier et constate que `write_file` écrit dans le dossier de travail et pas ailleurs ; une mutation (« le dossier demandé l'emporte ») fait échouer 3 tests ; le point d'entrée réel démarre avec « dossier de travail D:\JAROD-OS » et n'a rien écrit dedans.

Limites : (a) ce dossier confine les outils FICHIERS ; le contrôle du reste du PC (outils système de Herald, `run_shell`) n'est pas concerné par ce choix et relève de la politique d'accord de Jarod (`NEVER_ALWAYS`, tiers) ; (b) les conversations créées avant ce réglage et reprises par `session.resume` gardent leur dossier d'origine ; (c) la démo (`demo.ts`) garde son propre dossier temporaire.

### Suite de l'essai — écritures des automatisations et outils système (2026-10-11)

**Écritures des automatisations** (`gateway/server.ts`, `gateway/schedule-text.ts`) : `POST /api/cron/jobs` (création), `PUT` (modification), `DELETE`, `POST …/pause`, `…/resume`, `…/trigger` (« Run now », répond tout de suite, l'issue se lit dans `last_status`), `GET …/runs` et `GET /api/cron/delivery-targets` (vide : seule la livraison « local » est portée). Le texte de planification du shell (« every 30m », « weekdays at 8:00 », « every monday 9am », cron, horodatage) est lu par un analyseur strict qui refuse ce qu'il ne comprend pas. Refusés avec un message net : scripts seuls (`no_agent`, `script`), compétences par tâche, livraison vers une messagerie. **Vérifié dans l'interface de Herald** : création par le formulaire, pause, « Run now » (« Last run: just now · completed » : un vrai tour d'agent), suppression. Pas vérifié : la liste « Recent runs » est restée « No runs yet » après l'exécution (la route renvoie la conversation de la tâche, mais je n'ai pas observé son affichage).

**Outils système** : les 7 outils de `jarod-herald-reuse.md` §§ 9-10 sont des outils intégrés du noyau ; la passerelle les sert donc sans rien changer. Vérifié dans l'interface de Herald : une question sur les processus (sans accord, résultat réel), puis « ouvre le dossier de travail » : la carte d'accord affiche la phrase de l'action (« Ouvrir D:\JAROD-OS avec son application par défaut ») et l'appel exact ; « Allow once » ouvre réellement une fenêtre de l'Explorateur. La phrase vient de `precheck` (noyau) → `description` de la demande d'accord (passerelle) → carte de Herald, sans modification du shell.

### Suite — réglages, usage, MCP, messageries, lanceur (2026-10-11, soir)

Servi en plus, vérifié dans l'interface de Herald : la section « Hermes & agents » des Réglages (modèle et fournisseurs de Jarod, « Ask first » seulement pour l'autonomie, groupes d'outils dont « This computer », terrain « This device ») ; les commandes `/` (`slash.exec`, `commands.catalog`) ; la page Usage ; les serveurs MCP (sans secrets) ; l'état des messageries en lecture ; `/api/providers/oauth` vide (aucun module du noyau n'utilise OAuth). La page Mémoire de Herald a un adaptateur dans le dépôt Herald (commit « Memory page: read and write through the backend… »).

Le lanceur `scripts/Jarod-OS.cmd` du dépôt Jarod démarre la passerelle (cœur complet, profil à part), puis l'application Herald empaquetée branchée dessus, et arrête la passerelle à la fermeture. Vérifié avec l'application reconstruite. Une conversation réelle avec un modèle local (Ollama) a été menée jusqu'à un appel d'outil système réel.

Encore non servi : `client.capabilities`, `usage.bars`, `billing.state`, `/api/config/raw`, catalogue MCP, OAuth MCP, Studio, voix en flux, `clarify`. Tout est commité (dépôt Jarod : branche `spike/hermes-gateway` ; dépôt Herald : branche `feature/windows-port`), sauf les modifications propres à l'utilisateur dans `packages/desktop` et `packages/plugins/storage` de la copie.
