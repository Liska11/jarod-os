# Décisions D1 à D8 et dossier H9

Enregistré le 2026-10-31, d'après les réponses du propriétaire (fichier « reponse evo jarod-brahma-hermes »).
Ce document accompagne `PLAN-INTEGRATION-HERMES-BRAHMA.md` (le plan) et `PARITY.md` (le suivi). Rien ici n'est du code.

Légende : **tranchée** = décision du propriétaire, enregistrée telle quelle · **ouverte** = documentée, en attente de son arbitrage.

## 1. Les décisions tranchées et leurs exigences de test

### D1 : idées seulement, aucun code de Brahma Evo ni de Hermes (tranchée)

Règle permanente du dépôt.

- À chaque lot : contrôler qu'aucun fichier, fragment ou ressource venant de `D:\Brahma_Evo`, du dépôt Brahma-Ai-Evo ou du dépôt Hermes n'est ajouté (`git diff --stat` relu, pas de copie de noms de fichiers ni de textes).
- Exigence de test : la liste de contrôle de chaque lot (plan §4) gagne la ligne « D1 : aucune provenance Brahma ou Hermes dans le diff ». Un lot qui ne peut pas le dire n'est pas livré.
- Les principes repris sont cités dans le message de commit (« idée de … »), jamais le code.

### D2 : voix en direct, Gemini Live ACTIVÉ par défaut avec indicateur (tranchée)

Concerne B1 et H8. Cela inverse la règle 2 du plan pour ce seul réglage : la voix en direct est le moteur par défaut de la conversation vocale bidirectionnelle, et c'est un envoi de données vers Google.

Exigences :
- Indicateur **permanent et visible** tant que de l'audio ou de la vidéo part chez Google : l'orbe de voix prend une couleur dédiée au mode cloud.
- Repli **automatique** sur la chaîne locale si le réseau coupe, et **à la demande** en un clic (« voix en direct — cloud Google » désactivable). L'état est mémorisé entre les sessions.
- Le réglage porte ce nom dans l'interface et se règle en un clic.
- La clé Gemini reste au coffre, jamais relue par l'interface.
- L'image (webcam, écran) suit l'interrupteur de caméra et l'indicateur d'envoi : jamais d'image sans indicateur.

Tests exigés :
1. Indicateur : tant que la session cloud est ouverte, l'état de l'orbe est « cloud » ; session fermée, il ne l'est plus (test de modèle d'état + test de composant).
2. Repli : la couper côté réseau (WebSocket fermé, délai dépassé) bascule sur la chaîne locale **sans message d'erreur** et l'indicateur s'éteint.
3. Coupure : interrompre la voix en parlant l'arrête en moins de 500 ms (mesure avec un faux moteur à horloge injectée).
4. Mutation : retirer l'appel qui allume l'indicateur doit faire échouer le test 1 ; retirer le repli doit faire échouer le test 2.
5. Le bouton un clic « mode cloud off » : après lui, aucun octet n'est écrit vers le fournisseur (faux transport qui compte).

### D3 : auto-description, et modification sur demande explicite (tranchée)

Concerne B3 et B4, plus une capacité d'introspection.

Introspection (lecture seule, sans accord) :
- Outil `self_describe` : domaines, outils, compétences, avec leur classification `effect-paths` et leur état actif ou inactif. Classé `ro`. Aucune valeur de réglage secrète, aucun jeton.

Modification, uniquement sur demande explicite du propriétaire :
- jamais déclenchée par l'agent de sa propre initiative ;
- jamais dans le noyau : compétences et plugins utilisateur seulement ;
- dans un **worktree**, avec diff et résultats de tests montrés **avant** activation ;
- activation uniquement après son « oui » ;
- retour arrière en un clic qui retire tout (fichiers, enregistrements) ;
- journal d'audit : qui a demandé (le propriétaire), quoi, quand, quel diff, quel retour arrière.

Tests exigés :
1. `self_describe` n'écrit rien (aucun fichier, aucune ligne de base modifiés) et ne contient aucune valeur du coffre (test de fuite avec un secret planté).
2. **Mutation « modification sans accord doit échouer »** : un appel d'écriture de compétence sans demande explicite (marqueur de demande absent ou issu d'un tour de l'agent seul) est refusé ; supprimer cette vérification fait échouer le test.
3. Évasion : une écriture hors du worktree (`..\`, lien symbolique, chemin absolu, chemin du noyau `packages/…`) échoue.
4. Activation : tant que le « oui » n'est pas donné, la compétence n'apparaît pas dans le registre actif.
5. Retour arrière : après lui, ni fichier ni enregistrement ne subsiste (comparaison avant/après du dossier et de la table).
6. L'entrée d'audit contient demandeur, action, horodatage, diff, et le moyen de retour arrière.

### D4 : génération d'images, ComfyUI local en premier (tranchée)

Concerne B8.
- Fournisseur principal : ComfyUI local, aucune donnée ne sort. Fournisseur secondaire : un fournisseur cloud, **coupé par défaut**.
- Sortie confinée au dossier de travail ; accord avant écriture du fichier (le nom est dit dans la demande d'accord).

Tests exigés :
1. Avec le secondaire coupé, aucune requête sortante (faux `fetch` qui compte) ; la cible ComfyUI doit être une adresse locale explicitement configurée.
2. Le nom de sortie ne peut pas sortir du dossier de travail (`..`, absolu, lien, nom réservé Windows).
3. Pas d'écriture sans accord (mutation : retirer `dangerous` ou le `precheck` fait échouer).
4. Classement `effect-paths`, test de mutation du garde.

### D5 : domotique, non requise (tranchée)

B5 sort du plan. Rien n'est implémenté. Exigence : aucune ligne de code ni d'outil de domotique n'est ajoutée ; le plan et `PARITY.md` portent B5 « écarté ».

### D6 : mises à jour par dossier local signé (tranchée)

Concerne H10.
- Aucun canal en ligne. Mise à jour depuis un dossier local de publication ; **signature vérifiée avant installation**.

Tests exigés :
1. Un paquet à signature absente, invalide, ou dont le contenu a été modifié d'un octet est refusé avant toute installation.
2. Aucune requête réseau pendant la vérification (faux `fetch` qui échoue au moindre appel).
3. La clé de vérification vient du produit, jamais du dossier de publication.
4. Mutation : désactiver la vérification fait échouer le test 1.

### D7 : le pont téléphone Android existe déjà (tranchée)

Pas de nouvelle application : on réutilise et on fait évoluer `mobile/`. Inventaire et modifications prévues : voir §3.
Règle : toute modification de l'appli suit les mêmes règles que le reste, avec ton « go » avant installation sur le téléphone (OnePlus Nord 4, adb-wifi).

### D8 : Instagram intégré à Jarod, achats en lecture seule (tranchée, portée à préciser avant le lot)

Enregistré tel que reçu :
- **Instagram** : dans l'application, intégré à Jarod. (Cela remplace ma recommandation de l'écarter.)
- **Agent d'achats** : la **comparaison de prix en lecture seule** est autorisée. Acheter reste exclu : aucune action financière n'est faite par l'agent.

Ce qui reste à préciser avant d'ouvrir le lot B7, sans que je le tranche : quelles fonctions d'Instagram (lire et répondre aux messages, publier, seulement être notifié), pour quel compte (personnel ou professionnel), et par quelle voie (l'API officielle de Meta ne couvre que les comptes professionnels ; tout le reste est une automatisation du site, qui expose le compte à un blocage). B7 est donc tranché dans son principe, ouvert dans sa portée. Il n'est pas dans les phases 0 et 1.

Tests exigés (quand le lot s'ouvrira) :
1. Aucun outil d'achat n'existe (test de registre : aucun nom ni effet « payer / commander / acheter »).
2. La comparaison de prix est classée lecture seule et passe par le garde réseau public.
3. Tout envoi de message Instagram est `dangerous` avec accord montrant le destinataire et le texte.
4. Le jeton Instagram suit le dossier H9 (coffre, coupure en un clic).

## 2. H9 : connexion par compte (OAuth) : dossier pour arbitrage

**État : ouverte.** Pas implémentée, pas tranchée. Ce que tu as posé comme cadre : OAuth possible mais **désactivé par défaut**, activation manuelle service par service, coupure en un clic qui efface le jeton du coffre.

H9 sert B6 (Spotify), B9 (YouTube), B20 (Google Workspace), B7 (Instagram) et la connexion de fournisseurs ou de serveurs MCP.

| | A. Flux avec navigateur et rappel local (PKCE) ou « code d'appareil », service par service | B. Clé API ou jeton collé à la main dans le coffre | C. Pas d'OAuth du tout |
|---|---|---|---|
| **Données envoyées** | Au moment de la connexion : l'identifiant de l'application et les droits demandés vont au fournisseur, et tu t'identifies sur sa page (Jarod ne voit pas ton mot de passe). Ensuite, chaque appel porte le jeton et son contenu vers le service. | Aucune au moment du réglage. Ensuite chaque appel porte la clé vers le service, comme A. | Rien ne part. Les fonctions concernées (Spotify, Google, YouTube) restent absentes ou passent par ce qui existe (touches multimédia, fichiers locaux). |
| **Réversibilité** | Coupure en un clic : le jeton est effacé du coffre **et** révoqué auprès du fournisseur quand son API le permet (sinon il expire seul ; la page du compte permet de le retirer). Les jetons de rafraîchissement sont effacés aussi. | Effacer la clé du coffre. La clé reste valable chez le fournisseur tant que tu ne la révoques pas sur son site : à dire dans l'interface. | Sans objet. |
| **Dépendance** | Forte : il faut une application déclarée chez chaque fournisseur (identifiant, parfois vérification et quotas). Si le service ferme ou change son API ou ses droits, la connexion casse. Spotify et Google ont des contraintes différentes ; à vérifier service par service pendant l'audit (le flux « code d'appareil » de Google n'accepte qu'une liste restreinte de droits ; Spotify passe par PKCE avec rappel sur la machine). | Moyenne : la clé dépend du service mais pas d'une application déclarée. Beaucoup de services (dont Spotify et Gmail) n'en proposent pas pour un usage personnel. | Aucune. |
| **Surface d'attaque** | Le jeton vit au coffre de l'agent (jamais relu par l'interface, absent des journaux et des sauvegardes exportées). Risques : rappel local capté par un autre processus de la machine (il faut `state`, PKCE et un port aléatoire sur 127.0.0.1), jeton de rafraîchissement durable, droits trop larges. | Même coffre ; risque en plus que tu colles la clé ailleurs, et clés souvent plus larges que nécessaire. | Aucune nouvelle. |
| **Effort** | M, après un audit de sécurité | S | 0 |
| **Conserve ton cadre** (off par défaut, un service à la fois, coupure en un clic) | Oui | Oui | Oui (trivialement) |

**Exigences de test communes à A et B** si tu en retiens une :
- aucun jeton dans l'interface, un journal, un export ou une sauvegarde (test de fuite avec un jeton planté) ;
- la coupure efface le jeton du coffre (lecture avant/après) et appelle la révocation quand elle existe ;
- l'état par défaut de chaque service est « déconnecté » ; une connexion ne s'ouvre jamais d'elle-même ;
- les droits demandés sont le strict minimum du lot (liste fixe dans le code, testée) ;
- mutation : retirer l'effacement fait échouer le test de coupure.

**Mon avis, à titre indicatif seulement** : A pour Spotify et Google (rien d'autre n'existe), B partout où le service offre une clé, C si tu n'utilises pas ces services. Ce n'est pas une décision ; j'attends la tienne. Aucun code H9 n'est écrit.

## 3. Application Android existante : inventaire et modifications à prévoir

### Inventaire

| Élément | Valeur |
|---|---|
| Dossier | `mobile/` à la racine du dépôt (hors des espaces de travail npm ; son propre verrou et sa propre chaîne Gradle) |
| Identité | `os.jarod.mobile`, version 1.1.1 (code 3), Capacitor 8.5.3, React 19, minSdk 28, targetSdk 36 |
| Protocole | `jarod-relay/1` : X25519 + AES-256-GCM, compteurs croissants ; porteur HTTP : `POST /m1/open`, `POST /m1/up`, `GET /m1/down` (SSE), `GET /m1/wake`, port 10492 |
| Côté PC | `jarod-core/packages/plugins/gateways/src/mobile.ts` (routes `/m1/*`), `remote-host.ts` (appels), `remote-protocol.ts` (protocole partagé octet pour octet avec l'appli), `phone-approvals.ts`, `bridge/src/main/handlers/phone.ts` (appairage, révocation) |
| Appels que l'appli peut faire | `hello`, `sessions.list/create/rename/delete`, `messages.list`, `chat.send/voice/file/stop`, `approval.resolve`, `approvals.pending`, `notifications.list`, `wake.register`, `device.leave` |
| Natif Android | coffre de clé (Keystore + biométrie), `WakeService` + `BootReceiver`, parole, assistant (fenêtre translucide, `VoiceInteractionService`), bulle flottante, accessibilité, lecteur de notifications, réglages système |
| Outils exposés à l'agent côté PC | `android_devices`, `android_shell` (adb, une commande par accord). **Aucun outil n'expose le contenu du téléphone à l'agent par le pont** : le téléphone est un client, pas une source. |
| Documentation | `docs/ANDROID-APP.md` |
| Réseau | LAN privé ou Tailscale ; le pont refuse toute source non privée |
| Essais réels notés | Galaxy Note 8 (Android 9) pour l'appairage, les accords et le réveil ; OnePlus Nord 4 (OxygenOS 16, Android 16) pour la connectivité LAN et le réveil (`docs/ANDROID-APP.md` §2 ; le rapport `apk/RAPPORT-CONNECTIVITE.md` qu'il cite n'a pas été relu). |

L'emplacement et l'interface avec Jarod sont clairs : je n'ai pas eu à te demander où est l'appli. Le Nord 4 en adb-wifi est la cible des essais à venir.

### Modifications à prévoir, par lot (aucune n'est faite)

| Lot | Besoin côté appli | Besoin côté PC | Nouveau permis Android ? |
|---|---|---|---|
| H1 progression des sous-agents | Afficher les lignes de progression dans le fil (comme les outils) | Événement `subagent` ajouté au protocole du pont | non |
| H2 `clarify` | Carte de question à choix sur le téléphone, avec la même règle que les accords (une décision, un identifiant) ; biométrie non requise | Événement `clarify` + réponse `clarify.answer`, pendant du `approval` | non |
| H11 `todo` | Liste lisible dans le fil, lecture seule | Événement `todo.updated` | non |
| B2 documents Office | Aucun (fichiers non transférés vers le téléphone, règle actuelle). Éventuellement un lien « Ouvert sur le PC » | — | non |
| B1 voix en direct | **Hors périmètre phase 1.** L'appli a sa propre parole locale ; la voix Gemini Live sur téléphone est un lot séparé | — | micro déjà déclaré |
| B10 pont complet (filtrage d'appels, SMS, position, batterie) | **À écrire** : l'appli ne lit aujourd'hui ni SMS, ni appels, ni position (la batterie n'est lue que pour sa propre économie d'énergie). Deux voies : (1) sans appli, par adb (`dumpsys battery`, etc.) via l'outil existant, avec accord ; (2) dans l'appli, un plugin natif par capacité, chacun avec son permis demandé à l'usage | Un canal **téléphone → PC** de données lues (aujourd'hui inexistant), classé en lecture seule, avec accord par type de donnée | `READ_SMS`, `READ_CALL_LOG` / `CallScreeningService`, `ACCESS_FINE_LOCATION` : sensibles, chacun derrière un interrupteur de l'appli |
| B11 surveillants (processus, réseau, inactivité) | Notification déjà gérée (`notification`, `topic`) ; ajouter un `topic` « surveillant » | Déclencheurs système | non |
| B12 assistant de réunion | Éventuel déclencheur depuis le téléphone ; rien en phase 1 | — | micro déjà déclaré |
| B7 Instagram | À préciser (voir D8) ; notifications seules possibles via le lecteur de notifications déjà présent | — | non |
| Général | Tout changement : tests Vitest de `mobile/` + tests JUnit existants, build `apk:debug`, installation **seulement sur ton « go »** | | |

Point de sécurité à garder : le canal téléphone → PC de B10 inverserait le sens actuel (le téléphone demande, le PC répond). Il faudra une revue dédiée avant d'écrire du code : quelles données, à quel moment, sous quel accord, stockées où.
