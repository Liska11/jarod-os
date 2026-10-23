# Jarod comme cockpit multi-runtime : faisabilité et état vérifié

Mesures du 2026-10-22, sur ce poste (Windows 11). Rien n'a été commité, aucune référence Git, aucune version épinglée, aucun profil réel n'a été modifié. Les essais ont tourné sur des profils jetables (dossier temporaire de la session), avec un faux fournisseur OpenAI sur `127.0.0.1` et un proxy mort pour toute sortie réseau qui respecte les proxys : aucune donnée n'est partie vers un fournisseur.

Vocabulaire : **installé** (présent sur le disque) · **détecté** (Jarod le trouve) · **démarré** (processus lancé) · **connecté** (protocole authentifié ouvert) · **testé** (parcours exécuté et vérifié).

## 1. Qui est qui

« DSH NEXT » désigne un seul de ces projets : la variante expérimentale du bureau communautaire. Les autres ne doivent pas porter ce nom.

| Projet | Rôle | Runtime | Interfaces publiques | Version | Intégration possible |
|---|---|---|---|---|---|
| `NousResearch/hermes-agent` | Agent complet (Python) | lui-même : `hermes serve` | WebSocket JSON-RPC `/api/ws` + REST `/api/*` (jeton), contrat OpenRPC « v1 » généré ; aussi ACP stdio (`hermes acp`) | installé **v0.22.4**, commit `4d04303` (2026-10-21) ; dernière publication v0.22.4 | **déjà intégré** : le shell parle ce protocole |
| `deepseek-ai/deepseek-harness` (« DeepSeek Harness », `dsh`) | Le **runtime** DSH (TypeScript/Node, Cordis, « tout est plugin ») | lui-même | ACP v1 stdio (`dsh --profile acp`), SDK JSON-RPC stdio (`--profile sdk`), Web UI HTTP (`--profile web`, 127.0.0.1:3080) | CLI installée **0.2.1-rc.2** (dans `%LOCALAPPDATA%\hermes\node`) | **oui, par ACP** (prouvé ci-dessous) |
| `anywhere-labs/dsh-desktop` (« DSH Desktop ») | Bureau Electron **communautaire** (pas DeepSeek), qui embarque le runtime | `deepseek-harness` en sous-module, épinglé `687f282` = 0.2.1-rc.2 | celles du runtime + son Web UI ; option d'accès **LAN sans authentification** | appli installée 2.0.17 | non : deuxième application Electron, inutile si on pilote le runtime |
| `dsh-desktop/dsh-desktop-next` (« **DSH NEXT** ») | **Dossier** du même dépôt (pas un dépôt à part) : variante expérimentale avec plateau, profils, récupération, « Agents Anywhere », marché | même runtime ; son README dit « basé sur 0.1.6-alpha.2 », son `upstream-reference.json` dit 0.2.1-rc.2 (incohérence chez eux) | idem + pont distant « Agents Anywhere » | appli installée 2.0.18 | non comme moteur ; source d'idées (déjà listée dans `ANALYSE-2026-10-12.md` §3) |
| `fentz26/dsh-next` | **Pas un runtime.** Couche de modernisation hors arbre : fournisseurs de capacités (persistance, journal) pour DSH, Rust seulement si un banc le justifie | se branche **dans** DSH par Cordis | aucune pour un client ; ce sont des plugins | dernier commit 2026-08-26 ; base auditée DSH **0.1.1-rc.2** (le runtime installé est 0.2.1-rc.2) | à évaluer **plus tard**, par banc comparatif seulement |

`fentz26/dsh-next`, détail demandé :

| Catégorie | Éléments (d'après son README, non exécutés ici) |
|---|---|
| Fournisseurs exécutables | `packages/journal` (journal segmenté TS, « JOURNAL READY »), `packages/persistence-worker` (persistance dans un worker, « PROCEED »), `packages/paged-history` + `packages/checkpoint-replay` (reprise paginée et par points de contrôle, « VALIDATED ») |
| Prototypes | `crates/native-journal` (Rust napi-rs, « experimental », compilé à la main), `packages/descriptor-store` |
| Seulement documenté | exécution durable (track F, « no code yet »), superviseur (G, « design only »), continuation de session (« research only ») |

Leurs chiffres (reprise 28 ms contre 581 ms, etc.) sont mesurés **sur DSH 0.1.1-rc.2** ; ils ne disent rien de 0.2.1-rc.2 ni de Jarod. **Optimisation non mesurée** ici.

## 2. Hermes dans Jarod : état vérifié

| Question | Réponse vérifiée |
|---|---|
| Installé | Oui : `C:\Users\San\AppData\Local\hermes\hermes-agent` (installation git), venv Python 3.11, `hermes --version` = v0.22.4 |
| Détecté par Jarod | Oui en principe : `resolve.ts` cherche `$HERMES_HOME/hermes-agent` (par défaut `%LOCALAPPDATA%\hermes`) puis `hermes.exe` sur le PATH. Non exercé dans l'application ce jour |
| **Backend réellement actif** | **Le noyau Jarod**, pas Hermes : `selectBackend` choisit `jarod` dès que `jarod-core/dist/gateway/gateway.mjs` existe (présent, construit le 2026-10-22 21:31). Hermes ne démarre qu'avec `JAROD_OS_BACKEND=hermes`, ou si la build n'a pas de noyau. Ce choix vaut **pour tout le lancement**, pas par session |
| Contrat utilisé par `packages/hermes-client` | OpenRPC `info.version = "1"`, 237 méthodes, recopié de l'instantané `upstream/hermes-agent/apps/shared/src` |
| Commit épinglé | `UPSTREAM.lock` = `f97608f` ; l'instantané local porte le même tampon (le fichier `*-upstream-sha` écrit par `scripts/sync-upstream.ps1`). Seul `apps/shared/src` est compilé |
| Écart épinglé → installé | `f97608f` **est un ancêtre** du commit installé. Contrat : 257 méthodes (+24, −3, 2 modifiées). Sur les **19 méthodes** que le bureau appelle, 7 ont changé, **toutes par ajout** de champs facultatifs, sauf `BillingStateResult.free_tier` renommé `free_tier_account` (le bureau ne lit pas ce champ). Aucune méthode utilisée n'a disparu. `npm run typecheck` contre le contrat installé : **non exécuté** |
| Ce que sert la passerelle du noyau Jarod | Les 19 méthodes sont traitées, mais `usage.bars`, `billing.state`, `wake.*` et `client.capabilities` répondent volontairement « Not available in this version » (`unavailable.ts`) |

### Hermes réellement testé (profil jetable, `scripts/probes/hermes-runtime-probe.py`)

Lancement identique à `manager.ts` (`python -m hermes_cli.main serve --host 127.0.0.1 --port 0`, `HERMES_DESKTOP=1`, jeton de session), mais avec `HERMES_HOME` et `HOME` temporaires. Client : WebSocket JSON-RPC comme le canal amont, y compris `client.capabilities {server_requests: true}`.

| Parcours | Résultat |
|---|---|
| Démarrage, ligne READY | OK |
| Authentification REST | OK : `/api/config` donne 200 avec jeton, 401 sans jeton ou avec un faux. `/api/status` est **public par conception** (liste blanche de Hermes) |
| Authentification WS refusée (faux jeton) | OK (connexion rejetée) |
| Création de session | OK : identifiant vivant **et** identifiant stocké (`stored_session_id`), qui sont distincts |
| Streaming | OK : 6 deltas puis `message.complete` |
| Outil factice + approbation | OK : la commande `rm -r` arrive comme **requête serveur `approval`** ; le refus donne `BLOCKED: Command denied by user`, rien n'est exécuté. Testé en modes `manual` et `smart` |
| Sans `client.capabilities` | La demande est **retirée** et la commande bloquée (échec fermé, vérifié) |
| Interruption | OK : `session.interrupt` → `interrupted` en 0,1 s ; le flux du fournisseur est bien coupé |
| Reconnexion + reprise | OK : `session.resume` **par l'identifiant stocké**, 7 messages d'historique |
| Reprise après redémarrage du runtime | OK : session listée, historique rendu, nouveau tour accepté |
| Arrêt | Le runtime lancé et ses enfants sont arrêtés (arbre du seul PID lancé) ; aucun autre processus Hermes ne tournait |

Méthodes interrogées sur le runtime réel (et non simulées) :

| Domaine | Méthode | Réponse du runtime v0.22.4 |
|---|---|---|
| Usage | `usage.bars` | répond `{"available": false}` (pas de compte Nous) ; `session.usage` répond (jetons, contexte) ; `insights.get` répond |
| Facturation | `billing.state` | répond `logged_in: false` |
| Studio | `process.list` répond ; `preview.restart` existe (erreur 4012 « url required ») ; outils terminal/aperçu annoncés dans `client.capabilities` | méthodes présentes ; parcours Studio complet **non testé** |
| Mémoire | aucune méthode RPC dédiée : Hermes la garde en fichiers (`$HERMES_HOME/memories/`), que le bureau lit lui-même | **non testé** par RPC (il n'y en a pas) |

**Non vérifié :** le même parcours **à travers l'application Jarod-OS** (`JAROD_OS_BACKEND=hermes`), car le gestionnaire actuel lancerait Hermes sur le profil réel `%LOCALAPPDATA%\hermes`. Il faut pouvoir lui imposer un `HERMES_HOME` jetable : c'est la première tâche de la tranche suivante.

## 3. DSH : interface réelle et prototype de connexion

Interface publique retenue : **ACP v1 sur stdio** (Agent Client Protocol, standard ouvert ; paquet `@deepseek-ai/dsh-acp`). Rien n'est inventé : les appels sont ceux de leur README et ils ont été exercés sur le runtime installé. Le protocole **n'est pas** celui de Hermes.

| Besoin | ACP chez DSH |
|---|---|
| Transport | stdio, JSON-RPC par ligne ; stdout réservé au protocole |
| Authentification | `authMethods: []`, « aucune authentification » : la seule barrière est la **possession du processus** (tuyaux privés). Rien n'écoute sur le réseau |
| Sessions | `session/new`, `session/list`, `session/resume`, `session/close` (pas de `load`, fork ni suppression) |
| Événements | `session/update` : messages **validés** (pas de flux par jetons), pensées, cycle de vie des outils, usage de contexte |
| Outils et approbations | `session/request_permission` (choix `allow_once` / `reject_once`) |
| Annulation | `session/cancel` |
| Modèle | `session/set_config_option` (`model`, `reasoning_effort`) |

### Prototype testé (profil jetable, `scripts/probes/dsh-acp-probe.mjs`)

`DSH_HOME` temporaire, `dsh --profile acp --patch <fournisseur factice>` : le profil réel `C:\Users\San\.dsh` n'est pas lu.

| Parcours | Résultat |
|---|---|
| `initialize` | OK : protocole 1 ; capacités `close`, `list`, `resume`, MCP HTTP ; pas d'images |
| Version inconnue (999) | Le runtime répond 1 (négociation ACP) : c'est au client de refuser |
| `session/new` | OK, avec le choix de modèle exposé |
| Réponse | **Partiel** : un seul `agent_message_chunk` par message, rien au fil de l'eau |
| Outil factice + approbation | OK : l'outil `pwsh` demande une escalade et `session/request_permission` arrive ; le refus est respecté (fichier hors espace non créé, outil `failed`) |
| Annulation pendant l'écriture | OK : `stopReason: cancelled` en 6 ms ; le texte partiel déjà validé est livré |
| Session inconnue | Refusée (-32602) |
| Arrêt | Fermer stdin → sortie code 0 |
| Reprise après redémarrage | OK : session listée, `session/resume` accepté, nouveau tour accepté |

## 3 bis. Essais avec les applications installées et lancées (2026-10-23)

Hermes Desktop (`Hermes.exe`) et DSH NEXT étaient ouverts. Les tests n'ont touché à aucun profil réel et n'ont envoyé aucun prompt au cloud.

**Ce que les applis exposent réellement**

| Appli | Processus | Point d'entrée | Joignable par Jarod ? |
|---|---|---|---|
| Hermes Desktop | `Hermes.exe` → serveur Python (stdio, aucun port) | tuyaux privés de l'appli (`logs/gateway-stdio.log`) | **Non** : pas de port, jeton en mémoire seulement. Jarod ne peut pas s'y « attacher » ; il doit lancer son propre serveur |
| Passerelle de messagerie Hermes | `hermes gateway run` (Telegram + `api_server`) | `127.0.0.1:8642` | `/health` public ; `/v1/models` répond **401 sans clé** |
| DSH NEXT, hôte | `host.js` sur `~/.dsh/profiles/desktop`, runtime **0.2.0-rc.2** embarqué (dans `C:\Program Files\DSH NEXT`), avec `dsh-acp` | `127.0.0.1:51918` | **Non** : « Browser access is disabled » (réservé au protocole interne de l'appli) |
| DSH NEXT, passerelle OpenAI | `~/.dsh/openai-gateway` | `127.0.0.1:8326` | 401 sans clé |
| DSH NEXT, plugin our-free-model | relais de modèles | `127.0.0.1:18899` ; partage **réseau local** `0.0.0.0:55948` (`lan.enabled: true`) | 401 sans clé ou avec une fausse, testé aussi depuis `192.168.1.42` (Ethernet) et `10.2.0.2` (ProtonVPN). **Exposé au réseau, mais protégé par clé** ; règle de pare-feu entrante « DSH NEXT » autorisée |

Le fournisseur réel de Hermes est **OpenRouter**, un service cloud.

**Runtimes installés testés sur profil jetable** (mêmes bancs, en parallèle des applis ouvertes)
- **Hermes:** le runtime de Hermes Desktop (v0.22.4) passe les huit parcours.
- **DSH NEXT:** le runtime embarqué (0.2.0-rc.2, lancé par Node 24 et non par l'Electron de l'appli) passe les mêmes parcours que la CLI 0.2.1-rc.2. La limite est la même : réponses par message entier.
- **Après les essais:** les six processus des applis (`Hermes.exe`, son serveur, la passerelle, `DSH NEXT.exe`, son hôte, billion-context) tournent toujours avec les mêmes heures de démarrage.

**Impossible sans enfreindre une règle**
- **Profils réels:** les tester voudrait dire soit s'attacher aux serveurs des applis (inexistant ou réservé), soit lancer un second runtime sur leurs bases actives, ce qui est interdit.
- **Fournisseurs réels:** les tester enverrait des données au cloud (OpenRouter pour Hermes), ce qui demande ton accord.

## 3 ter. Essai cloud autorisé, chemin Jarod, intégration (2026-10-23)

**Essai cloud Hermes : arrêté avant l'envoi, aucun appel envoyé.**
- **Avant l'envoi:** fournisseur `openrouter`, modèle `minimax/minimax-m3.1-flash:free` (lus dans le profil réel, sans le copier). Clé `OPENROUTER_API_KEY` présente, jamais affichée. Politique Internet de Jarod : pas de fichier, donc valeur par défaut (`internet: true`) ; non modifiée.
- **Coût estimé:** 0 USD pour la variante `:free`. Au tarif de la variante payante, ≈ 0,0002 USD en entrée pour ≈ 1 400 jetons mesurés.
- **Point bloquant:** OpenRouter publie ce modèle, mais avec **0 point d'accès disponible**. Vérifié deux fois, la seconde juste avant l'envoi. L'appel ne pouvait pas aboutir.
- **Limite relevée:** par le chemin Jarod, la passerelle de Hermes ne transmet **aucun plafond de sortie** (`max_tokens` ne sert qu'aux tâches auxiliaires). La limite de 64 jetons n'est donc pas applicable ici.
- **Garde-fous:** le banc (`scripts/probes/hermes-live.probe.ts`, mode `cloud`) les applique lui-même. Il s'arrête sans point d'accès, ou si un modèle payant n'est pas borné. Il exige `JAROD_PROBE_CLOUD_OK=1`.

**Essai cloud, second modèle choisi par la personne : `nvidia/nemotron-3-super-120b-a12b:free` (OpenRouter).**
- **Avant l'envoi:** 1 point d'accès, prix 0/0, donc coût estimé 0 USD. Raisonnement coupé (`reasoning_effort: none`).
- **Profil:** profil jetable minimal, avec zéro outil, sans plugin, MCP, mémoire, titre automatique, relance ni repli. Le modèle n'est remplacé que dans ce profil ; celui de Hermes Desktop reste `minimax/minimax-m3.1-flash:free`.
- **Chemin:** `BackendManager` de Jarod, puis passerelle Hermes v0.22.4, puis fabrique de socket du shell (`wsAuth: query`).

| Point | Résultat |
|---|---|
| Fournisseur répondant | **Oui, par une erreur** : OpenRouter a accepté la requête (pas de 401) et rendu `HTTP 404 Provider returned error`. Détail amont : `Function '…': Not found for account '…'`, c'est-à-dire que le point d'accès NVIDIA derrière ce modèle gratuit est introuvable. |
| Réponse | Aucun texte du modèle : le message d'erreur de Hermes, rendu par `message.complete`. |
| Tentatives | 1 (« API call failed after 1 retries », `attempt 1/1`). Aucune relance, aucun repli. `session.usage.calls` = 0, aucun jeton compté. |
| Latence | 3,5 s jusqu'à la fin du tour (démarrage du runtime : 44 s). |
| Événements | `session.info`, `message.start`, `thinking.delta`, `status.update`, `message.complete` ; aucun `message.delta`. |
| Coût | 0 (gratuit, aucun jeton facturé). |
| Secret | La clé est passée par l'environnement du runtime seulement. Elle n'apparaît dans aucun des 14 228 fichiers du profil jetable (journaux compris). |
| Applications ouvertes | Non touchées. |

**Bilan cloud :** le fournisseur répond et l'adaptateur fonctionne jusqu'au fournisseur, erreur comprise. Une **réponse de modèle réelle reste à obtenir** ; l'autorisation donnée couvrait un seul appel.

**Essai cloud, fournisseur NVIDIA (catalogue d'API, `integrate.api.nvidia.com`) : réponse réelle obtenue.**
- **Fournisseur et modèle:** ceux de `providers.nvidia` dans le profil réel, lu sans être copié. Modèle `nvidia/nemotron-3.5-lightning-30b-a3b`, présent au catalogue public. Clé `NVIDIA_API_KEY`, jamais affichée.
- **Répétition à blanc avant l'envoi:** Hermes croyait parler à NVIDIA, mais c'est le faux serveur qui a reçu la requête. Elle comportait :
  - 1 inférence, 0 outil ;
  - `max_tokens: 16384` imposé par Hermes pour NIM (pas réglable ici ; la sortie est bornée) ;
  - aucun réglage de pensée transmis (`reasoning_effort: none` ignoré pour ce fournisseur).
- **Coût:** aucun prix par jeton publié par le catalogue NVIDIA (accès développeur sur crédits) ; aucune facturation en USD attendue.

| Point | Résultat |
|---|---|
| Runtime, adaptateur | Hermes v0.22.4 lancé par `BackendManager` (profil jetable), shell relié en `?token=` |
| Réponse | « JAROD_HERMES_TEST_OK. » suivie d'une phrase du modèle reprenant une proposition de profil, que suggère le prompt système de Hermes |
| Appels | 1 (`session.usage.calls = 1`), aucune relance (aucune erreur au journal) |
| Jetons | entrée 1 792, sortie 3 137 dont **3 087 de raisonnement** : la pensée n'a pas pu être coupée par ce chemin |
| Latence | premier delta 29,4 s, fin 29,9 s (≈ 119 jetons/s), démarrage du runtime 45 s |
| Événements | `session.info`, `message.start`, `thinking.delta`, `reasoning.delta`, `message.delta` ×48, `reasoning.available`, `message.complete` |
| Secret | absent des 14 228 fichiers du profil jetable |

**Applications ouvertes.** Après cet essai, le processus Python 61584, lancé par Hermes Desktop à 23:58:59, n'existait plus ; il était présent au contrôle de 00:52. `Hermes.exe` et les autres processus (passerelle de messagerie, DSH NEXT) tournent toujours. Aucune cause n'est établie :
- le nettoyage d'orphelins de Hermes ne fait rien sous Windows ;
- les arrêts des bancs ne visent que l'arbre de leur propre processus ;
- les journaux de Hermes Desktop ne disent rien après 23:59.

**Vérifié ensuite :** Hermes Desktop avait relancé lui-même un moteur à 01:05:25 (PID 43056, enfant de `Hermes.exe`). La personne confirme qu'il répond, avec `nvidia/nemotron-3-ultra-550b-a55b`. C'est cohérent avec un cycle de vie propre à l'application (moteur remplacé, par exemple au changement de modèle), sans que la cause exacte soit établie.

**Essai cloud, NVIDIA, `nvidia/nemotron-3-ultra-550b-a55b`, demandé par la personne : réponse exacte.**
- **Même chemin et mêmes règles:** profil jetable minimal, 1 appel autorisé.
- **Faux départ sans envoi:** un premier lancement a échoué avant tout appel. J'avais déplacé l'environnement Python isolé dans un dossier plus long, et Windows a refusé une DLL (« nom de fichier trop long »). L'environnement d'un `HERMES_HOME` emprunteur ne se déplace pas.

| Point | Résultat |
|---|---|
| Réponse | **« JAROD_HERMES_TEST_OK »**, exactement |
| Appels | 1, aucune erreur ni relance au journal |
| Jetons | entrée 1 786, sortie 46, raisonnement compté 0 (un `reasoning.delta` a pourtant été émis) |
| Latence | premier delta 3,85 s, fin 3,96 s (runtime prêt en 42 s) |
| Événements | `session.info`, `message.start`, `thinking.delta`, `reasoning.delta`, `message.delta` ×3, `reasoning.available`, `message.complete` |
| Secret | absent des 14 228 fichiers du profil jetable |

**Ce que montrent les journaux réels de Hermes Desktop**, lus sans être modifiés.
- **Session de la personne à 01:06:**
  - `nvidia/nemotron-3-super-120b-a12b` répond **404 chez NVIDIA aussi** (« Function … Not found for account »). Le même échec que par OpenRouter vient donc du compte NVIDIA, pas d'OpenRouter.
  - Hermes est ensuite passé à un modèle **payant** d'OpenRouter (`deepseek/deepseek-v4.1-flash`, « PAID lane… may incur real spend »), refusé faute de crédits (402).
  - Enfin, `nemotron-3-ultra-550b-a55b`, qui a répondu.
- **Configuration réelle:** le modèle de compression auxiliaire `qwen3.8-27b-cold-fusion…` n'a que 8 192 jetons de contexte, sous le minimum de 64 000 exigé par Hermes. Erreur relevée dans `tui_gateway_crash.log`, qui note aussi une exception non gérée « Event loop is closed » à 01:06:20.
- **Moteur de Hermes Desktop:** il a changé trois fois (61584, puis 43056 à 01:05:25, puis 50308 à 01:09:50), et l'application reste fonctionnelle. Le dernier remplacement tombe à quelques secondes de l'arrêt du runtime de ce banc : coïncidence non expliquée, aucun mécanisme liant les deux n'a été trouvé (nettoyage d'orphelins inactif sous Windows, arrêts limités à l'arbre du banc).

**Chemin Jarod → Hermes : un défaut trouvé et corrigé.**
- **Le défaut:** depuis le commit `367172e`, le shell présentait le jeton en sous-protocole `jarod-gw`. Hermes v0.22.4 ne l'accepte pas ; en local, il ne lit que `?token=` (`web_server_chat._ws_auth_reason`). **Le cockpit ne pouvait donc plus se connecter à un backend Hermes.**
- **La correction:**
  - `BackendState.wsAuth` vaut `subprotocol` (noyau Jarod) ou `query` (Hermes).
  - `openGatewaySocket` l'applique, ainsi que la voix (`speak-stream`).
  - `redact.ts` masque déjà `token=` dans les journaux.
- **Validé, faux fournisseur:**
  - **Banc** `hermes-live.probe.ts` : `BackendManager` réel et fabrique du shell. Un seul appel d'inférence par tour ; les deux autres requêtes sont des sondes `POST /api/show`.
  - **e2e** `hermes-backend.spec.ts` : le cockpit démarre sur Hermes, puis message depuis l'Accueil et réponse dans le chat.
- **Profil jetable:** un `HERMES_HOME` jetable reçoit son propre environnement Python. C'est le comportement documenté de Hermes ; ≈ 780 Mo, préparés une seule fois. Le venv réel n'est pas modifié (vérifié).

**Livré dans le cockpit (non commité).**

| Élément | Fichiers | Vérifié par |
|---|---|---|
| Registre des moteurs : détection sans exécution, état réel, capacités vérifiées | `shared/engines.ts`, `electron/engines/registry.ts` | tests unitaires, e2e |
| Choix du moteur du cockpit (auto / Jarod / Hermes), appliqué en relançant Jarod-OS. Hermes choisi ici prend un `HERMES_HOME` propre à Jarod | `registry.ts` (`applyBackendChoice`), `main.ts` | tests unitaires |
| Client ACP (stdio) et traduction vers le vocabulaire du shell | `electron/engines/acp-client.ts`, `acp-translate.ts` | tests avec doubles |
| Adaptateur DSH (détails sous le tableau) | `electron/engines/dsh.ts` | tests avec doubles, banc réel, e2e |
| Réglages › Moteurs : moteurs, versions, états, capacités, limites, choix du moteur, panneau DSH | `EnginesSection.tsx`, `engines-model.ts`, `ipc/engines.ts`, preload, locales | e2e `engines.spec.ts` |

Ce que fait l'adaptateur DSH :
- **Dossier:** `DSH_HOME` sous les données de Jarod. Les clés vont dans son propre `.credentials.yaml`.
- **Environnement:** liste blanche système, plus les seules variables nommées par l'appelant. Jamais un jeton interne.
- **Sessions et accords:** session, tour, annulation et reprise. L'accord présente la commande exacte ; la politique est « me demander / refuser / accepter une fois », jamais « toujours ».
- **Arrêt:** fermeture de stdin, puis arrêt de l'arbre de **ce** seul processus.
- **Réseau:** proxy mort quand l'Internet de Jarod est coupé.

**Résultats des tests**
- Bureau : 178 fichiers, 1 427 tests unitaires.
- Garde de renommage : vert.
- e2e : `engines.spec.ts` 4/4 et `hermes-backend.spec.ts` 1/1, sur des racines jetables.
- Bancs réels :
  - `dsh-live.probe.ts` : CLI DSH 0.2.1-rc.2 **et** runtime de DSH NEXT 0.2.0-rc.2. Réponse, accord refusé, annulation (≈ 50 ms), arrêt, reprise.
  - `hermes-live.probe.ts` : Hermes v0.22.4.
- Tes applications Hermes Desktop et DSH NEXT tournaient pendant tous les essais. Leurs six processus sont restés en place et leurs profils n'ont pas été touchés.

## 4. L'adaptateur proposé

Le shell et le noyau parlent le contrat Hermes partout. Le moins cassant est donc de **traduire, côté processus principal, ACP vers le contrat Hermes**, et de ne pas réécrire le shell :

| Contrat Hermes (shell) | ACP (runtime DSH) |
|---|---|
| `session.create` | `session/new` |
| `prompt.submit` → `message.start/delta/complete` | `session/prompt` + `session/update` (un seul delta par message) |
| requête serveur `approval` | `session/request_permission` |
| `session.interrupt` | `session/cancel` |
| `session.list` / `session.resume` | `session/list` / `session/resume` |
| tout le reste (Studio, mémoire, wake, billing…) | **« Not available in this version »**, avec la même phrase que `unavailable.ts`, jamais une réponse simulée |

- **Détection et santé :** CLI `dsh` (version lue par `--version`), puis `initialize` ; refuser tout protocole ≠ 1.
- **Démarrage et propriété :** le gestionnaire lance `dsh --profile acp`, garde le PID, l'arrête en fermant stdin, et seulement s'il échoue, tue l'arbre **de ce PID**. Il ne touche jamais aux processus DSH Desktop/NEXT de l'utilisateur.
- **Profil :** un `DSH_HOME` **propre à Jarod** (sous `%LOCALAPPDATA%\Jarod-OS\engines\dsh`) ; jamais `~/.dsh` ni sa base, sauf conversion explicite.
- **Environnement :** liste blanche comme `child-env.ts`. Ni `JAROD_GATEWAY_TOKEN`, ni `HERMES_DASHBOARD_SESSION_TOKEN`, ni socket de contrôle, ni clés d'autres fournisseurs.
- **Multi-moteur :** `BackendManager` ne tient qu'un backend ; il faut un registre `engines` (jarod, hermes, dsh) dans lequel chaque session porte son moteur, figé à la création.
- Ni l'appli Electron DSH, ni son Web UI, ni l'option LAN (**sans authentification**, d'après leur README) ne sont nécessaires.

L'ACP de Hermes (`hermes acp`) pourrait servir le même adaptateur. Il est **détecté, non testé** : Hermes reste sur sa passerelle native, plus riche.

## 5. Multi-moteur, permissions, réseau

- **Choix explicite :** chaque session indique son moteur, sa version, son état et ses capacités manquantes (la liste du tableau §4). Une session ne change jamais de moteur. Pas de transfert entre moteurs tant qu'il n'existe pas de format de conversion et de tests de fidélité.
- **Bases :** chaque moteur garde la sienne (`profile/` Jarod, `HERMES_HOME`, `DSH_HOME`). Il n'y a aucun partage direct ; mémoire, skills et configuration passent par des conversions explicites.
- **Accès concurrents :** les espaces de travail, les modèles locaux et les bureaux (pilote de fenêtres) sont tenus par des verrous **du cockpit**. Deux moteurs ne pilotent pas le même bureau en même temps.
- **Permissions :**
  - La liste unique `settings.permissionsRules` reste l'autorité du cockpit (`PERMISSIONS-AUTONOMIE.md`).
  - Hermes et DSH ont **leurs propres** barrières (modes d'approbation de Hermes ; bac à sable et `approval: ask` de DSH). On ne les retire pas.
  - Une demande du runtime est présentée **une seule fois**, sur la carte d'approbation du shell. Le cockpit peut y répondre d'après une règle déjà accordée, ce qui évite la double confirmation sans supprimer la barrière du runtime.
  - Un jeton n'est jamais transmis à un moteur qui n'en a pas besoin.
- **Commutateur Internet :**
  - Pour Jarod, la garde est dans le noyau.
  - Pour Hermes et DSH, Jarod ne peut que leur donner un proxy mort et refuser de les lancer. Un processus tiers peut ignorer les proxys : c'est la limite déjà écrite dans `NETWORK-POLICY.md` (« Child processes are not isolated »), et elle s'applique à eux.

## 6. Veille amont : ce qui est faux aujourd'hui

`jarod-core/upstream.json` :
- `NousResearch/hermes-agent` n'a jamais tourné (`dernierShaVu: null`).
- Pour DSH, seul le dépôt Desktop est suivi, pas le runtime épinglé ni `dsh-next`.
- Le « retard » qu'on lit souvent est un compte de commits global (16 000), ce qui ne prouve rien.

Correction proposée, informative seulement (aucune mise à jour automatique) :
- **Quatre révisions par projet :** observée, installée, épinglée, intégrée et testée.
- **Pour chaque écart :** ancêtre commun, commits **sur les chemins concernés**, et signal explicite de pagination, troncature, historique divergent ou requête échouée.
- **Hermes :** le critère est le diff du **contrat** sur les méthodes réellement appelées (calcul fait ici, à automatiser), avant de toucher `UPSTREAM.lock`.
- **DSH :** trois entrées séparées : `anywhere-labs/dsh-desktop` (Desktop), `deepseek-ai/deepseek-harness` (runtime, à comparer à la CLI installée et à l'épinglage `687f282` du Desktop), `fentz26/dsh-next`.

## 7. Bilan

| Statut | Élément |
|---|---|
| **Connexion opérationnelle** (testée, profil jetable) | Hermes v0.22.4 par sa passerelle WS : authentification, sessions, streaming, approbation, interruption, reconnexion, reprise après redémarrage. Refait le 2026-10-23 avec Hermes Desktop ouvert, sans le perturber |
| **Non joignable** | Les serveurs internes de Hermes Desktop (stdio) et de DSH NEXT (accès navigateur fermé) : Jarod lance ses propres runtimes, il ne s'attache pas aux applis |
| **Fonction partielle** | DSH par ACP (CLI 0.2.1-rc.2 **et** runtime embarqué de DSH NEXT 0.2.0-rc.2) : réponses par message entier ; pas de Studio, mémoire ni usage |
| **Prototype** | Les deux bancs `scripts/probes/` (hors application, non commités) |
| **Connexion opérationnelle depuis le cockpit** (2026-10-23, faux fournisseur) | Hermes comme moteur du cockpit (chat principal), après correction du jeton WebSocket ; DSH conduit depuis Réglages › Moteurs (session, réponse, accord, annulation) |
| **Fonction absente** | Une session DSH dans le **chat principal** (aujourd'hui : panneau Moteurs) ; transfert de session entre moteurs ; plafond de sortie par le chemin Hermes ; veille amont corrigée ; saisie de la clé du DSH de Jarod depuis l'interface (aujourd'hui : son `.credentials.yaml`) |
| **Fournisseur réel** | **Opérationnel par le chemin Jarod avec NVIDIA** : Nemotron Ultra 550B (réponse exacte, 1 appel, 46 jetons) et Nemotron 3.5 Lightning 30B (réponse réelle, 1 appel, raisonnement non coupable). Par OpenRouter : Nemotron Super 120B gratuit en erreur 404 (point d'accès NVIDIA en amont) ; MiniMax M3.1 Flash gratuit sans point d'accès (arrêt avant envoi). Le cockpit lui-même n'a été vérifié qu'avec un faux fournisseur |
| **Optimisation non mesurée** | `fentz26/dsh-next` (chiffres sur une base de 0.1.1-rc.2) |
| **Validation restante** | Parcours Hermes **à travers l'application Jarod-OS** ; `npm run typecheck` contre le contrat v0.22.4 ; ACP de Hermes ; Studio Hermes de bout en bout ; banc dsh-next contre 0.2.1-rc.2 |
