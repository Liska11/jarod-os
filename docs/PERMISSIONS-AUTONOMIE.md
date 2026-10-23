# Permissions et autonomie configurable

Livré le 2026-10-21. Ce document sépare, pour chaque action de Jarod :
1. la capacité technique ;
2. la permission accordée par l'utilisateur ;
3. le périmètre de cette permission ;
4. les conditions techniques ;
5. la disponibilité au moment de l'action.

« Non autorisé actuellement » ne veut pas dire « non implémenté » : l'agent sait le dire.

## Une seule autorité

Les permissions de l'utilisateur vivent dans **une seule liste** : `settings.permissionsRules` du profil. Trois chemins la lisent ou l'écrivent :

| Qui | Lire | Écrire | Confirmation |
|---|---|---|---|
| Réglages › Agent et sécurité (bureau) | oui | oui | aperçu de ce qui change, puis boîte native qui liste chaque affaiblissement |
| `jarod permissions` (terminal) | oui | oui | terminal interactif, portée affichée, code de 6 chiffres à retaper |
| L'agent (`permissions_explain`) | oui | **non** | — |

Depuis le 2026-10-21 (soir), l'écran et la commande passent par le **même service** (plugin-permissions, `admin.ts`) : mêmes opérations (`planGrant`, `planUpdate`, `planMove`, `planRevoke`), même validation (`normalizeRules`), mêmes identifiants (`p-xxxxxx`), et la même règle pour ce qui affaiblit. L'écran appelle `permissions-plan` (aperçu, rien n'est écrit) puis `permissions-apply`. Chaque règle dit d'où elle vient (`by` : « commande » ou « réglages »). Le garde relit la liste **à chaque décision** : un changement fait d'un côté vaut pour l'appel suivant, même dans le bureau déjà ouvert.

**Relue juste avant d'écrire.** Entre l'aperçu et la confirmation (code au terminal, boîte native), l'agent peut consommer une utilisation. L'écriture reprend le compteur relu pour toute règle dont tu n'as pas changé le nombre : une utilisation consommée n'est jamais rendue. Si la liste a changé autrement entre-temps (l'autre canal), rien n'est écrit et tu recommences.

**Ce qui demande la boîte native (écran) ou le code (commande) :** tout ce qui donne plus de pouvoir — une autorisation nouvelle, un refus retiré, une règle montée au-dessus d'un refus, et aussi une borne **allongée** (plus d'utilisations, échéance repoussée ou retirée, passage à « sans accord »). Durcir (ajouter un refus, révoquer une autorisation, descendre une règle) ne demande rien à l'écran ; la commande demande toujours son code.

L'agent ne peut pas s'accorder de droits :
- aucun outil n'écrit la liste ;
- le shell de l'agent (`run_shell`) n'a pas de terminal et porte `JAROD_AGENT_SHELL=1`, que la commande refuse ;
- **le jeton de la passerelle n'est plus hérité** par aucun processus enfant (shell de l'agent, serveur MCP, extension, terminal intégré) : le cœur le lit puis le retire de son environnement au démarrage. Avant le 2026-10-21, une commande de l'agent pouvait le lire et ouvrir la passerelle, donc répondre elle-même à une demande d'accord (`tool-approval-respond`) ou écrire des réglages ;
- **le pilote de fenêtres refuse les fenêtres de Jarod-OS** (Réglages, boîtes de confirmation natives) : processus du shell, désigné au cœur par `JAROD_SHELL_EXE` ;
- un texte lu dans une page, un fichier, un résultat MCP ou un message d'outil n'est jamais une autorisation.

## Ce qu'une règle peut dire

Une règle a un outil (nom, famille ou `*`) et une décision : `deny`, `ask` ou `allow`. Bornes optionnelles :

| Champ | Effet |
|---|---|
| `autonomous` (avec `allow`) | **autoriser sans accord** dans le périmètre de la règle |
| `target` | motif sur la cible : chemin, hôte, application (`*` = toute suite) |
| `operation` | motif sur l'opération que l'outil déclare (`subtitles`, `sql`, `move`…) |
| `session` | une seule conversation (une mission) |
| `expiresAt` | échéance (30 jours au plus ; sans échéance = durable) |
| `uses` | nombre d'exécutions restantes, **seulement avec `allow`** : décompté avant l'exécution (sans accord) ou à l'exécution accordée (avec accord) ; jamais sur un refus. Un refus ou une demande « à N utilisations » ne s'épuiserait jamais : refusé à la validation |
| `id`, `note`, `createdAt`, `by` | lister, expliquer, révoquer |

La première règle qui couvre l'appel gagne. Pour **ouvrir**, une règle doit couvrir **toutes** les cibles de l'appel : un lot de fichiers, sources et destinations. Pour **fermer**, il suffit qu'elle en couvre **une**.

Une cible qui remonte (`..`) n'ouvre jamais. Les chemins de `write_file`, `edit_file`, `read_file` et `system_files` sont comparés en **chemin réel** : une jonction placée dans un dossier autorisé ne fait pas sortir de ce dossier.

Les cinq niveaux demandés correspondent à ceci :

| Demandé | Comment |
|---|---|
| Refuser | `deny` |
| Demander à chaque fois | `ask` (ou un outil sensible sans règle) |
| Autoriser une action | la fenêtre d'accord, « Autoriser une fois » |
| Autoriser pour la mission | fenêtre d'accord « pour cette conversation », ou une règle avec `session` |
| Autoriser durablement dans un périmètre | `allow` + `autonomous` + bornes (cible, opération, durée, nombre) |

**Une autorisation sans accord ne lève jamais :**
- l'interrupteur Internet ;
- le mode Plan ;
- un refus placé avant elle ;
- le garde propre à l'outil : emplacements protégés, processus critiques, garde du shell ;
- le journal d'audit, la tâche et sa preuve, l'annulation.

Une autonomie **sans aucune borne** est possible, mais seulement par choix explicite (`--large`), et elle est affichée comme telle.

## La commande

```
jarod permissions list
jarod permissions explain system_files --cible "D:\demo\a.txt"
jarod permissions add auto system_files --cible "D:\demo\*" --duree 8h --utilisations 50
jarod permissions add auto media_fetch --cible "*.youtube.com" --operation subtitles --duree 7j
jarod permissions add allow system_diagnostics --operation sql --duree 1j
jarod permissions edit p-3f9a2c --utilisations 10 --duree 2h
jarod permissions edit p-3f9a2c --cible aucune --large
jarod permissions move p-3f9a2c 1
jarod permissions revoke p-3f9a2c
jarod permissions reset
```

`edit` modifie une règle **en place** (même identifiant, même position, même date de création) ; « aucune » retire une borne, `--duree permanente` retire l'échéance. `move` change l'ordre. Réglages › Agent et sécurité offre les mêmes gestes : décision (y compris « sans accord »), cible, opération, conversation, durée, nombre d'utilisations, note, ordre, révocation.

Une permission nouvelle vaut pour les appels **suivants**. Les actions déjà lancées ne sont pas touchées : une révocation n'interrompt pas une action en cours (l'écran Tâches ou Échap l'annulent), et une autorisation nouvelle ne relance rien.

## Risque d'un outil : déclaré, jamais accordé par omission (2026-10-22)

`ToolRegistry.register` valide ce qu'il enregistre (nom, description, schéma des paramètres, origine, `run`). Un outil qui ne déclare PAS `dangerous` n'obtient pas pour autant le privilège d'une lecture : s'il ne figure pas dans `REVIEWED_WITHOUT_APPROVAL` (les outils dont l'absence d'accord a été revue), le registre le tient pour `dangerous` et l'accord est demandé. Un serveur MCP tiers reste `dangerous: true`, un plugin `dangerous` tant qu'il n'est pas de confiance. Une capacité NOUVELLE n'est donc couverte que par les règles qui la visent (nom, cible, opération), jamais par défaut ; une règle `allow` large que la personne a choisie reste valable et visible (`jarod permissions explain`). `writeScope: "off"` veut dire « aucun confinement des écritures demandé » (les autres gardes jouent) ; `"workspace"` le demande, et la commande est **refusée avec la raison** si la machine ne peut pas le tenir.

Les dossiers de clés (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gh`, `.git-credentials`, `.npmrc`, magasins Windows) sont les mêmes pour tous les chemins d'accès aux fichiers de Jarod (fenêtre, garde fichiers, shell confiné, outils système, pont Python) : `contracts/v1/credential-stores.reference.json`, vérifié par un test dans chaque garde. Cela ferme l'accès IMPLICITE ; `git`, `aws`, `kubectl`, `ssh`, `docker` lancés par la personne ou autorisés par une règle gardent leurs identifiants.

## Inventaire des restrictions (2026-10-21)

Classes :
- **T** : limite technique réelle ;
- **P** : protection d'intégrité, d'authentification ou de récupération ;
- **C** : permission configurable ;
- **A** : restriction fonctionnelle arbitraire ;
- **N** : fonction non encore implémentée.

| Restriction | Où | Classe | Décision |
|---|---|---|---|
| Outil sensible : accord à chaque appel | `runGuardedTool` | C | gardé ; **levable désormais par périmètre** (`auto`) au lieu du seul interrupteur global `autoApproveTools` |
| « Allow » ciblé qui demandait quand même l'accord | `runGuardedTool` | A (pour l'autonomie) | **corrigé** : `allow` garde son sens (l'accord reste), `allow` + `autonomous` dispense |
| `NEVER_ALWAYS` : pas de bouton « Toujours » pour 11 outils | `never-always.ts` | C (décision de l'utilisateur, 2026-10-04 et 2026-10-11) | gardé pour le bouton **sans périmètre** ; une règle bornée est la voie durable. `media_fetch` **n'y est pas ajouté** |
| osquery : 10 requêtes prédéfinies seulement | `osquery.ts` | A | **corrigé** : 10 raccourcis + 3 diagnostics paramétrés (`service-status`, `port-owner`, `program`) + requête libre `sql`, opération **réservée** |
| osquery : tables `curl`, `curl_certificate` | `osquery.ts` | P (interrupteur Internet) | refusées même en requête libre |
| `media_fetch` : un seul accord pour tous les modes | `media.ts` | A | **corrigé** : le mode est l'opération ; `metadata`, `subtitles` et `audio` s'accordent séparément |
| `media_fetch` : jamais de cookies | `media.ts` | N | à faire en **opération réservée** distincte, avec le coffre (identifiants jamais remis au modèle) |
| `media_fetch` : hôtes privés refusés, durée et taille bornées | `media.ts` | P / C | gardés ; bornes réglables à exposer |
| `system_files` : corbeille, jamais de suppression définitive ; jamais d'écrasement | `destroy.ts` | P (récupération) | gardés ; suppression définitive et écrasement à proposer en opérations réservées |
| `system_files` : emplacements protégés (`.ssh`, magasins d'identifiants, Windows, Program Files) | `files.ts` | P / T | gardés (identifiants ; Windows et Program Files exigent l'élévation de toute façon) |
| `system_files` : une seule cible connue | `destroy.ts` | A | **corrigé** : toutes les sources et destinations (`targetsOf`), en chemins réels |
| `system_kill_process` : processus du système, Explorateur, Jarod | `destroy.ts` | P (propriété des processus) | gardé |
| Élévation (administrateur) | — | N | à faire : opération **explicite** qui passe par l'invite Windows (UAC) ; jamais d'exécution permanente en administrateur |
| Pilote de fenêtres FlaUI (D1) : 7 opérations, liste blanche de processus, pas d'outil de l'agent | `uia.ts`, `desktop.ts` | P + N | **raccordé le 2026-10-21** (voir plus bas) : fenêtre = cible, action = opération ; clavier brut et souris = opérations réservées ; un seul contrôleur ; arrêt d'urgence. La liste noire (mots de passe, élévation, sécurité Windows) et le champ de mot de passe restent hors d'atteinte (P) |
| Pilote : touche Windows, Alt+Tab, Alt+Échap, Ctrl+Échap, Ctrl+Alt+… | `uia.ts` | P (périmètre : elles agissent hors de la fenêtre ; Ctrl+Alt+Fin est l'arrêt d'urgence) | refusées même accordées |
| `run_shell` : garde du shell (programmes, dossiers d'écriture, Docker) | `shell-guard.ts` | C | gardé (Réglages) ; la cible d'une règle est la commande |
| Secrets : le modèle ne voit que les noms | coffre | P | gardé ; les outils approuvés les **utilisent** déjà (`run_shell secrets=`, `http_request`), sans en remettre la valeur |
| restic : `forget`, `prune`, `unlock`, `key` refusés | `restic-backup.ts` | P (récupération) | gardé ; à proposer en opérations réservées une fois restic dans Réglages |
| Serveur d'API distant en lecture seule | `api-server.ts` | P | gardé |
| Accord sans réponse refusé après un délai | `agent.ts` | P | gardé |
| 200 règles au plus, temporaire ≤ 30 jours | validation | C | gardés (une règle sans échéance reste possible) |

## Pilote de fenêtres (FlaUI), raccordé le 2026-10-21

Deux outils de l'agent, Windows seulement, présents quand le moteur est trouvé (`JAROD_FLAUI_WORKER`, ou `JAROD_ENGINES_DIR\flaui\uia-flaui-worker.exe`) :

- **`desktop_windows`** : liste les fenêtres (identifiant, titre, processus, position, taille), hors gestionnaires de mots de passe, invites d'élévation et sécurité Windows. Lecture auditée, sans accord. Chaque fenêtre porte sa **cible de règle** : `processus:titre`, par exemple `notepad.exe:notes.txt - Bloc-notes`.
- **`desktop_control`** : agit sur une fenêtre. Outil sensible : accord à chaque appel, sauf règle autonome qui couvre **la fenêtre et l'opération**.

| Action | Opération de règle | Sans règle |
|---|---|---|
| `find_element`, `read_text` | `read.find_element`, `read.read_text` | accord demandé |
| `click`, `type_text`, `focus_window`, `press_key` (élément ou touche nommée) | `ui.*` | accord demandé |
| `press_keys` (combinaison), `type_keys` (frappe brute) | `keyboard.*` | **refusé** (opération réservée) |
| `mouse_click`, `mouse_scroll` (coordonnées relatives à la fenêtre) | `mouse.*` | **refusé** (opération réservée) |

Exemples :

```
jarod permissions add auto desktop_control --cible "notepad.exe:*" --operation "keyboard.*" --duree 1h
jarod permissions add allow desktop_control --cible "notepad.exe:*" --operation "mouse.*"
```

La seconde accorde la souris dans le Bloc-notes, avec un accord à chaque clic.

**Ce que le moteur constate au moment d'agir :**
- la fenêtre visée est au premier plan avant toute touche, sinon rien n'est envoyé ;
- le point de clic est dans la fenêtre et c'est bien elle qui est dessous, pas une fenêtre qui la recouvre ;
- le curseur est remis à sa place après un geste de souris, et le moteur dit s'il l'a constaté revenu (l'utilisateur peut bouger sa souris pendant le geste) ;
- la fenêtre n'a pas changé (même processus, même titre) entre la demande d'accord et l'action.

`find_element` rend aussi la position de chaque élément, relative à la fenêtre.

**Un seul contrôleur actif par bureau.** Un bail est posé dans le dossier temporaire de la session Windows, commun à tous les processus Jarod. Une autre conversation ou un autre processus est refusé tant que le bail court. Le bail se libère après 2 minutes d'inactivité, à la mort de son processus, ou par l'arrêt d'urgence.

**Arrêt d'urgence :**
- **Ctrl+Alt+Fin**, lu au clavier physique par le moteur, quelle que soit la fenêtre au premier plan. Le moteur s'arrête net, le bail est rendu et plus rien ne passe. L'appel suivant demande à l'utilisateur de **reprendre**, même sous une règle autonome.
- L'annulation de la tâche (écran Tâches, Échap) arrête aussi le moteur en pleine opération.

**Limites :**
- Jarod agit sur le **vrai bureau** : le bureau isolé (Windows Sandbox ou VM) reste à activer, avec ton accord.
- Les fenêtres de **Jarod-OS lui-même** ne sont ni listées ni pilotables (2026-10-21) : sans cela, une règle autonome sur le bureau aurait permis à l'agent de cliquer dans Réglages ou dans une boîte de confirmation.
- Une touche de modification tenue au moment exact où le moteur est tué pourrait rester enfoncée : appuyer de nouveau sur la touche la relâche.
- Le moteur pywinauto (D2) n'a pas le clavier brut ni la souris.

## Dépôts écartés au lot B, réexaminés le 2026-10-21

Les deux avaient été écartés sur des défauts de **configuration**. Mesurés avec la bonne configuration, ils deviennent des **fournisseurs optionnels**, sans nouveau code et sans rien activer sur ton profil réel.

### Windows-MCP (0.8.7) : fournisseur MCP optionnel, outils choisis

Mesuré (banc MCP réel, profil jetable, aucune action de bureau jouée) :
- `--tools` garde **exactement** les outils choisis ; un outil écarté répond « Unknown tool » ;
- avec `ANONYMIZED_TELEMETRY=false`, **aucune** requête sortante n'est partie. Le témoin servait à la fois de serveur PostHog et de proxy HTTP(S), donc il aurait compté toute requête qui respecte le proxy ;
- aucun identifiant persistant n'est écrit. Le seul fichier créé dans le profil jetable est le cache de shaders du pilote NVIDIA.

| Outil | Choix | Pourquoi |
|---|---|---|
| `DisplayInventory`, `WaitFor`, `Wait` | **retenus** | géométrie des écrans, attente d'une condition d'interface : Jarod ne les a pas |
| `Move` (glisser-déposer), `MultiSelect` (sélection multiple) | **retenus** | FlaUI (`desktop_control`) ne les fait pas |
| `Screenshot`, `Snapshot` | **à part (perception)** | capture et arbre de **tout** l'écran ; une image envoyée à un modèle distant quitte la machine |
| `PowerShell`, `FileSystem`, `Process`, `App` | écartés | doublons d'outils que Jarod garde déjà (garde du shell, emplacements protégés, propriété des processus) |
| `Scrape` | écarté | contournerait les gardes de `web_fetch` |
| `Shortcut` | écarté | Win+R, Alt+Tab : agit hors de toute fenêtre |
| `Click`, `Type`, `Scroll`, `MultiEdit` | écartés | `desktop_control` les fait, borné à une fenêtre (premier plan et point constatés) |
| `Registry` | écarté | aucune clé protégée : à faire en outil natif, sous les permissions |
| `Clipboard` | écarté | lirait un mot de passe copié |
| `Notification` | écarté | sans apport |

Pour l'activer, c'est toi qui décides, dans Réglages › Serveurs MCP. La déclaration :

```json
{
  "name": "windows-mcp",
  "command": "D:\\Jarod-OS\\engines\\windows-mcp\\Scripts\\windows-mcp.exe",
  "args": ["serve", "--tools", "DisplayInventory,WaitFor,Wait,Move,MultiSelect"],
  "env": { "ANONYMIZED_TELEMETRY": "false" }
}
```

Pour la perception, ajouter `Screenshot,Snapshot` à `--tools`.

Comme tout outil MCP dans Jarod :
- un accord est demandé à **chaque appel** ;
- les outils sont refusés hors ligne sans « commandes locales » ;
- l'empreinte de chaque outil est figée : une description qui change est bloquée.

**Limites :**
- les coordonnées sont celles de l'**écran entier**, donc aucune fenêtre ne peut servir de cible de règle : une règle autonome ne peut le borner que par l'outil, l'opération et la durée ;
- il agit sur le vrai bureau ;
- ce n'est **jamais** le contrôleur principal : c'est FlaUI.

### llama-swap (v262) : fournisseur optionnel pour deux usages distincts

Mesuré avec `-listen 127.0.0.1:<port>` et `apiKeys` (serveurs de modèles factices) :

| Point | Mesure |
|---|---|
| Écoute | llama-swap **et** ses modèles : 127.0.0.1 seulement. Le défaut `:8080` (toutes interfaces) n'était qu'une option à corriger |
| Clé d'API | sans clé, **tout** répond 401, administration comprise (`/running`, `/unload`, `/logs`, `/ui`, `/upstream`) |
| CORS | `Access-Control-Allow-Origin: *` pour toute origine. Sans danger tant que la clé est exigée : une page web étrangère sans clé reçoit 401. **Sans clé, ce serait un trou** |
| Bascule pendant une réponse | la réponse en cours aboutit, la bascule l'attend |
| Inactivité | modèle déchargé après le délai (`ttl`) |
| Groupes | deux modèles servis **en même temps** (groupe sans bascule) |
| Programmes lancés | les modèles, et `nvidia-smi` (relevé de la mémoire GPU, machine NVIDIA) |
| Arrêt | aucun processus orphelin |

Comparaison avec le gestionnaire actuel (moteur llama.cpp, `local_model_server`, hotswap llama.cpp et LM Studio) :

| Fonction | Jarod | llama-swap |
|---|---|---|
| Installer llama.cpp pour ce GPU, vérifier les empreintes, mettre à jour | **oui** | non |
| Préréglages (contexte, couches GPU, cache KV…), ajustement au modèle | **oui** | ligne de commande à écrire |
| LM Studio (chargement, déchargement, longueur de contexte) | **oui** | non |
| Bascule à la demande depuis la conversation | oui (hotswap) | oui |
| Écoute locale | toujours 127.0.0.1 | à configurer |
| Relance d'un serveur tombé | oui (2 relances, attente croissante) | au prochain appel |
| Attendre une réponse en cours avant de basculer | **oui depuis le 2026-10-21** (avant : non, le hotswap arrêtait llama-server sous une réponse d'une autre conversation) | **oui** (mesuré) |
| Décharger après inactivité | **oui depuis le 2026-10-21** (réglage, éteint par défaut ; seulement ce que Jarod a chargé) | **oui** |
| Plusieurs modèles en mémoire à la fois | non avec hotswap (un modèle de discussion) | **oui** (groupes) |
| Moteurs autres que llama.cpp (vLLM, whisper-server, serveurs d'images) | non | **oui** (toute commande compatible OpenAI) |
| Interface web, journaux | écran Modèles | `/ui`, `/logs` |

**Décision.** llama-swap ne remplace pas le gestionnaire : sur le même GPU, deux superviseurs se disputeraient la mémoire. Il est justifié comme fournisseur optionnel pour deux usages que Jarod ne couvre pas :
1. plusieurs modèles en mémoire à la fois ;
2. des moteurs que Jarod ne gère pas, derrière une adresse unique.

Pour le brancher, aucun code n'est nécessaire : le fournisseur « Personnalisé (compatible OpenAI) » existant suffit, avec l'adresse `http://127.0.0.1:<port>/v1` et la clé rangée dans le coffre. Configuration exigée : `-listen 127.0.0.1:<port>` et `apiKeys`. Ne pas le faire tourner en même temps que le moteur llama.cpp de Jarod sur le même GPU.

**Repris nativement le 2026-10-21** dans le gestionnaire de Jarod (`plugins/llm/src/local-models.ts`) :
- **une réponse en cours n'est jamais coupée.** Chaque appel de discussion vers un moteur local tient un bail, pris dans la même file que les chargements. Avant d'arrêter ou de redémarrer llama-server, ou de décharger un modèle LM Studio, le gestionnaire attend qu'aucune réponse ne tourne dessus. C'est vrai pour le hotswap comme pour « Décharger » à l'écran. Au-delà de 5 minutes d'attente, c'est la **bascule** qui est refusée, avec la raison ; la réponse va à son terme ;
- **déchargement après inactivité**, réglé par `local-models-configure { idleUnloadMinutes }`, de 0 (jamais, par défaut) à 1440 minutes. Il ne touche qu'un modèle de discussion que **Jarod a chargé lui-même** : un modèle chargé par toi dans LM Studio pour d'autres programmes reste en place. Jamais un modèle d'embeddings, jamais pendant une réponse. Le déchargement est annoncé avec la raison « inactivité ».
- **propriété des modèles, réconciliée au redémarrage (2026-10-21)**. Chaque modèle en mémoire dit qui l'a chargé, et l'écran l'affiche :

  | Propriété | Quand | Déchargé sans que tu le demandes (inactivité, hotswap) |
  |---|---|---|
  | **Chargé par Jarod** | llama-server lancé par ce processus ; instance LM Studio chargée par Jarod depuis son démarrage | oui |
  | **Propriété incertaine** | instance LM Studio que Jarod avait chargée **avant** un redémarrage (`localModels.lmstudioLoaded`) et retrouvée : rien ne prouve qu'elle n'a pas été déchargée puis rechargée par quelqu'un d'autre (LM Studio ne donne pas d'heure de chargement, et l'identifiant d'instance est souvent la clé du modèle) | **non** ; « Reprendre » la rend à Jarod |
  | **Chargé ailleurs** | chargé par LM Studio ou un autre programme ; pour llama.cpp, un serveur qui répond sur le port sans avoir été lancé par ce processus (signalé, jamais arrêté) | **non** |

  Le hotswap ne décharge plus que les modèles de Jarod : un modèle chargé ailleurs reste en mémoire à côté. Ton propre « Décharger » dans l'écran reste possible sur tous. Une instance disparue entre-temps est oubliée.

Il n'y a pas encore de réglage à l'écran : seul le canal existe.

Testé sur serveurs factices (`plugins/llm/test/local-models-drain.test.ts`, 8 tests, réponses en flux SSE lentes) :
- l'ordre « fin de la réponse, puis déchargement ou arrêt » est constaté, pour LM Studio comme pour llama.cpp, à l'écran comme par le hotswap ;
- le refus après le délai d'attente est vérifié ;
- les déchargements par inactivité sont vérifiés, ainsi que ce qu'ils ne touchent jamais.

Contre-épreuve : avec l'attente désactivée, les 4 tests de bascule échouent.

## Tests

| Fichier | Ce qui est vérifié |
|---|---|
| `plugins/permissions/test/autonomy.test.ts` (13) | périmètres, `..`, refus sur une cible, opération, conversation, échéance, utilisations, affaiblissements, validation commune, ajout, révocation, réinitialisation, explication, opération réservée |
| `cli/test/permissions.test.ts` (5) | ajout avec code ; refus sans terminal, depuis le shell de l'agent, mauvais code ; autonomie sans borne ; list, explain, revoke ; durées |
| `plugins/integrations/test/desktop.test.ts` (9, moteur factice) | combinaisons système refusées, coordonnées bornées, liste noire sans liste blanche, arrêt d'urgence et reprise, bail unique (autre conversation, autre processus, inactivité, processus mort), fenêtre changée, annulation qui arrête le moteur |
| `plugins/integrations/test/engines/flaui.engine.test.ts` (+2, moteur réel, fenêtre fabriquée) | touche, combinaison et frappe brute, clic par coordonnées sur le bouton (l'étiquette le prouve, le curseur revient), point hors fenêtre et `win+r` refusés ; Ctrl+Alt+Fin tenu 300 ms arrête tout, reprise seulement avec accord |
| `plugins/agent/test/desktop-autonomy.engine.test.ts` (1, boucle réelle, moteur réel) | liste sans accord ; action sur élément avec accord ; souris refusée (réservée) ; règle autonome `keyboard.*` sur la fenêtre : frappe sans accord, souris toujours refusée, `ui.*` toujours demandé ; une autre conversation refusée par le bail |
| `plugins/agent/test/autonomy.engine.test.ts` (3, boucle réelle) | `system_files` réel sur un dossier jetable : sans accord dedans ; demandé dehors, pour `..`, épuisé, échu, révoqué ; refus placé avant ; `permissions_explain` ; requête osquery libre refusée puis accordée (osquery réel) |
