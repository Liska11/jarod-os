# E2 (navigateur connecté) — branchement dans l'application et preuves exactes

Dernière vérification : 2026-10-17, Windows 11, Chromium de Playwright 1243, browser-harness 0.1.13, Node 24. Chaque ligne ci-dessous nomme un essai qui s'exécute ; rien n'est affirmé sur la foi d'une simulation seule.

**E2 reste désactivé par défaut** (réglage éteint, aucun domaine). **Le confinement réseau n'est pas déclaré exhaustif** : voir « Réserves » en bas.

## 1. Branchement au cycle de vie de l'application

- `jarod-core/packages/cli/src/gateway/main.ts` appelle `startConnectedBrowser` (`gateway/connected-browser.ts`) une fois, au démarrage de la passerelle, et `stop()` à son arrêt. L'assistant appelle `ctx.integrations.startConnectedBrowserLifecycle` (plugin `integrations`), qui prend `ToolsService` (outil, canal d'accord) et le magasin de réglages.
- Rien n'est branché et aucun navigateur ne démarre au lancement : l'outil `connected_browser` n'apparaît que si le réglage est activé avec au moins un domaine **et** que le moteur est trouvé sous `JAROD_E2_ENGINE_ROOT` (racine qui contient `engines/browser-harness` et `jarod-core/sidecars/browser-bridge` ; absente = « moteur absent », rien n'est branché). Le Chrome jetable n'est lancé que par la première action approuvée.
- Un changement de réglage (`settings.onChange`) rebranche ou débranche l'outil sans redémarrage ; un domaine retiré, un jeu de domaines changé, l'extinction du réglage ou une garde non saine **révoquent la session aussitôt**, sans attendre l'opération suivante (`ConnectedBrowserHost.reconcile`).
- Au démarrage, `sweepStaleSessions` retire les sessions abandonnées par un arrêt brutal de CETTE application (voir §5).
- Hors de l'installation actuelle : le moteur (venv Python épinglé et Chromium de Playwright) n'est pas livré dans l'installeur ; `JAROD_E2_ENGINE_ROOT` doit être posée par qui l'installe. C'est volontaire (désactivé par défaut) et reste à décider pour la distribution.

## 2. Navigateur dédié, jamais le profil quotidien

Essais : `integrations/test/browser-dedicated.test.ts` (7).

- Les arguments du navigateur (`browserArgs`) contiennent UN seul `--user-data-dir`, un dossier `jarod-e2-*` créé par Jarod sous le dossier temporaire ; DevTools sur `127.0.0.1` et un port choisi par le système ; aucun `--profile-directory`, tuyau DevTools, origine permise ni extension.
- La recherche du moteur (`discoverEnginePaths`) ne consulte que le venv épinglé et le dossier `ms-playwright` ; elle ne nomme ni `User Data`, ni Google, ni Application, ni un Chrome installé (essai sur les chemins vus, Windows et Linux).
- Le réglage de l'utilisateur ne sait exprimer ni profil, ni chemin de navigateur, ni moteur, ni adresse DevTools (`parseBrowserConfig` écarte toute autre clé ; le pont de réglages les refuse : `bridge/test/connected-browser-settings.test.ts`).
- Aucun code de l'intégration, du pont Python ni de la passerelle ne nomme un dossier de navigateur personnel (essai de dépôt sur le code hors commentaires).
- Le profil du navigateur de ces essais n'a jamais été le profil quotidien : aucun essai ne l'ouvre, ne le copie, ne le lit.

## 3. Essais sur l'application construite (Electron + noyau empaqueté + moteur réel)

`apps/desktop/e2e/connected-browser.spec.ts` : 9 essais, exécutés avec `npm run bundle:core && npm run build` puis `npx playwright test`. Le modèle est scripté, le site est local (`site.localhost`), la confirmation native est remplacée côté processus principal. Les 10 essais existants de `shell.spec.ts` passent aussi (19 sur 19).

| Scénario demandé | Essai | Ce qui est vérifié |
|---|---|---|
| éteint : aucun outil navigateur | 1 | réglage éteint et vide ; la liste d'outils offerte au modèle (non vide) ne contient pas `connected_browser` ; aucun dossier de session |
| annulation de confirmation : réglage inchangé | 2 | la boîte native nomme « Activer ou élargir le navigateur connecté ? » ; Annuler : réglage inchangé, interrupteur non coché |
| activation sans domaine : aucune session | 3 | réglage activé, aucun outil offert, aucun dossier de session |
| ajout d'un domaine | 4 | l'outil apparaît sans redémarrage ; toujours aucun navigateur lancé |
| refus d'une action : aucun lancement ni effet | 5 | la carte d'accord montre l'hôte et le chemin exacts ; Refuser : aucun dossier de session, zéro requête vers le site |
| accord : profil jetable et action exacte | 6 | un seul dossier de session nouveau, navigateur vivant, une requête vers `/second` sous `site.localhost` et aucune autre ; marqueur de propriété présent |
| retrait d'un domaine : session invalidée et fermée | 7 | voir §4 |
| perte de garde : opérations refusées, session arrêtée | 8 | navigateur tué de l'extérieur : le dossier disparaît de lui-même ; l'opération suivante est refusée **avant** toute demande d'accord ; l'action approuvée d'après démarre un profil neuf |
| désactivation | 9 | session fermée aussitôt, dossier et processus partis, l'outil disparaît |

Mutation vérifiée : en supprimant la révocation immédiate de `lifecycle` (`reconcile`), l'essai 7 échoue.

Même parcours au niveau de la passerelle, noyau et moteur réels, sans fenêtre : `cli/test/connected-browser-app.test.ts` (5 essais).

## 4. Révocation pendant une opération, requêtes d'arrière-plan comprises

- Application construite, essai 7 : une page `/ticker` émet d'elle-même des requêtes (`fetch` toutes les 80 ms, images toutes les 120 ms) ; une ouverture d'onglet lente (`/slow?ms=60000`) est en cours (le modèle attend l'outil) ; le domaine est retiré dans l'écran de réglages ; **l'opération est coupée en moins de 8 s alors que le moteur n'abandonnerait qu'après 10 s**, le profil est effacé, aucun processus ne porte plus son chemin, et **le nombre de requêtes d'arrière-plan reçues par le site ne bouge plus** 1,5 s après la révocation.
- Moteur réel, `integrations/test/engines/browser.lifecycle.engine.test.ts` : même scénario avec `ConnectedBrowserHost` (navigation lente de 8 s coupée, message « session révoquée », aucune requête d'arrière-plan après coup, navigateur et profil détruits), puis extinction du réglage et perte de garde (navigateur tué : `guard.healthy` faux, session arrêtée d'elle-même, état « garde perdue », action suivante sur une session neuve).
- Mécanisme : `NetworkGuard.revoke` refuse toute requête en pause et toute requête neuve, `HarnessBackend.abort` tue les processus d'opération en cours, le démon du moteur est arrêté par son pid (vérifié par sa ligne de commande), puis le navigateur est tué et son profil effacé. Une garde qui cesse d'être saine (connexion CDP perdue, cible non gardable) déclenche le même arrêt (`onUnhealthy`).

## 5. Point d'accès CDP, confidentialité, nettoyage

Essais : `browser.lifecycle.engine.test.ts`.

- **Confinement** : toutes les adresses d'écoute du navigateur sont `127.0.0.1` ou `::1` (mesure avec `Get-NetTCPConnection` sur le pid du navigateur) ; une requête avec un en-tête `Host` étranger (rebond DNS) est refusée, la même avec `Host` de bouclage passe ; une poignée de main WebSocket avec un en-tête `Origin` de page web est refusée (403), la même sans `Origin` aboutit (101, le contrôle).
- **Confidentialité** : ni le port, ni le chemin WebSocket (jeton de capacité du navigateur), ni l'URL DevTools n'apparaissent dans le journal d'audit, les demandes d'accord, l'état de l'hôte, les contenus rendus ni les messages d'erreur (essai sur plusieurs erreurs provoquées). Le dossier de session n'est lisible que par l'utilisateur (ACL Windows : SYSTEM, Administrateurs, l'utilisateur, vérifiées par SID ; contrôle `0700` écrit pour Linux, non exécuté sur cette machine).
- **Nettoyage des seuls objets créés par Jarod** : à la fermeture, plus aucun processus ne porte le chemin du profil, le démon du moteur de la session est parti, le dossier est effacé ; un dossier voisin et un processus étranger restent intacts. Le balayage au démarrage (`sweepStaleSessions`) n'agit que sur un dossier `jarod-e2-*` directement sous le dossier temporaire, ni lien ni fichier, qui porte le marqueur de Jarod et dont le propriétaire est mort ; il ne tue un navigateur que si sa ligne de commande contient CE dossier. Essai avec des leurres : dossier sans marqueur, propriétaire vivant, marqueur à numéro de processus réutilisé (le processus étranger visé survit), jonction vers un dossier extérieur, dossier au nom voisin : tous intacts ; la vraie session abandonnée (navigateur et dossier) est retirée.

## 6. Preuve réseau WebRTC / UDP

Essai : `browser.lifecycle.engine.test.ts › PREUVE RÉSEAU WebRTC/UDP`. Un témoin UDP sur l'adresse IPv4 de la route par défaut (celle où Chrome collecte son candidat d'hôte) compte chaque datagramme reçu ; un témoin TCP sur `127.0.0.1` compte les connexions. La page tente STUN, TURN en UDP et en TCP, puis WebTransport. Les mesures se font sans le bac à sable du service réseau de Chrome (§6.2) : un zéro sous durcissement est donc l'effet des drapeaux, pas de ce bac à sable ; une dernière mesure reprend le lancement exact de l'application.

| Configuration | Datagrammes UDP reçus | Connexions TCP | Candidats ICE appris par la page |
|---|---|---|---|
| contrôle (sans durcissement, sans filet) | 10 (WebRTC), 6 (WebTransport) | 1 | 2 (candidats d'hôte) |
| filet réseau seul (proxy mort) | 10 | 0 | 2 |
| drapeau WebRTC seul | 0 | 1 (TURN-TCP) | 0 |
| **pile complète** (drapeaux + QUIC coupé + filet) | **0 (WebRTC), 0 (WebTransport)** | **0** | **0** |
| **lancement de l'application** (pile complète + bac à sable de Chrome) | **0** | **0** | **0** |

Mesuré le 2026-10-18 (deux exécutions identiques), Windows 11, `chromium-1243`. Le contrôle prouve que le témoin voit ce qui sortirait ; il montre aussi que le proxy mort ne couvre pas l'UDP (c'est le drapeau `disable_non_proxied_udp` qui le ferme) et que le drapeau ne couvre pas le TCP (c'est le filet).

Si le contrôle reste à zéro (aucune route par défaut, ou une machine qui bloque l'UDP de Chrome autrement), l'essai est **ignoré** avec la mesure et un renvoi à §6.2 (« preuve UDP non concluante »), jamais compté comme réussi.

### 6.1 Contrôle à zéro (2026-10-18) : preuve non concluante sur la machine, pas une fuite (historique, cause trouvée en §6.2)

Le 2026-10-18, sur la même machine et le même Chromium (`chromium-1243`), le contrôle WebRTC reçoit **0** datagramme (WebTransport : 6, TURN-TCP : 1 connexion, 2 candidats d'hôte), à chaque exécution, seul ou sous charge. L'essai échoue donc sur sa première assertion, avec un message qui renvoie ici. Ce que montre le diagnostic :

- **Ce n'est pas un délai.** Collecte ICE jamais terminée, même après 12 s ou 20 s d'attente.
- **Ce n'est pas le témoin seul sur le bouclage.** Sous Windows, un socket lié à une adresse réseau ne peut pas écrire vers `127.0.0.1` (`EADDRNOTAVAIL`), ni vers l'adresse d'une autre interface (`ENETUNREACH`) ; depuis `0.0.0.0`, si. Mais un témoin sur CHAQUE adresse IPv4 de la machine (`169.254.x`, `172.20.x` Hyper-V, `192.168.1.x`, `192.168.56.x` VirtualBox) ne reçoit rien non plus, y compris avec la permission média accordée (`--use-fake-ui-for-media-stream`), où Chrome lie un socket à chaque vraie adresse.
- **Ce ne sont pas** `--allow-loopback-in-peer-connection`, `--force-webrtc-ip-handling-policy=default_public_and_private_interfaces`, ni la désactivation de `LocalNetworkAccessChecks*` (essayés un par un : 0).
- **Ni une stratégie, ni le pare-feu** : aucune clé sous `Policies\Chromium` ni `Policies\Google\Chrome` ; règles du pare-feu pour ce `chrome.exe` : entrantes, `Allow` ; sortie par défaut non configurée.
- Journal WebRTC de Chrome : sockets UDP prêts, aucune requête de liaison STUN visible, aucune erreur.

Conclusion : quelque chose sur la machine a changé depuis le 2026-10-17 (interfaces Hyper-V/VirtualBox/APIPA, mise à jour de Windows ou logiciel réseau) et empêche l'UDP WebRTC de ce Chromium d'atteindre un témoin local. Les résultats « durcis » à zéro ne prouvent rien tant que le contrôle est à zéro ; le durcissement lui-même (les drapeaux) n'a pas changé. À refaire sur une autre machine, ou sur celle-ci une fois la cause trouvée. Les sondes utilisées ne sont pas dans le dépôt (scripts jetables).

Après un redémarrage de la machine (même jour) : toujours 0, même message. Seul changement visible : l'adresse de l'interface Hyper-V (`172.20.x` → `172.26.x`), recréée à chaque démarrage. Un état passager du système est donc écarté ; piste suivante : désactiver une à une les interfaces virtuelles (Hyper-V/WSL, VirtualBox) et relancer l'essai — réglage réseau du système, à faire par l'utilisateur.

### 6.2 Cause du contrôle à zéro (2026-10-18) et correction de l'essai

Deux faits de la machine, mesurés avec des sondes jetables (Chrome lancé directement sur un profil temporaire, témoin UDP en Node) :

1. **Le bac à sable du service réseau de Chrome sous Windows** (`NetworkServiceSandbox`, conteneur d'application) empêche à lui seul tout datagramme WebRTC de sortir : avec lui, 0 datagramme vers un témoin sur `192.168.1.42`, et aucun candidat `srflx` même vers un serveur STUN public, alors que Node, sur la même machine, reçoit la réponse de ce serveur. Avec `--disable-features=NetworkServiceSandbox` (ou `--no-sandbox`), le témoin reçoit les requêtes STUN. C'était la piste non essayée en §6.1. Ce qui l'a rendu actif entre le 2026-10-17 et le 2026-10-18 (essai de terrain de Chromium, mise à jour de Windows) n'est pas établi.
2. **Windows refuse d'écrire vers `127.0.0.1` depuis un socket lié à une interface réseau** (`EADDRNOTAVAIL`), et WebRTC émet depuis de tels sockets (candidat d'hôte sur l'adresse de la route par défaut, ici `192.168.1.42`, plus une IPv6). Un témoin STUN/TURN-UDP sur `127.0.0.1` ne peut donc rien voir, bac à sable ou non.

Correction (essai seulement, aucun changement du lancement de l'application) :

- l'option de lancement `networkServiceSandbox` (vraie par défaut, jamais fixée par l'hôte de l'application) peut être mise à `false` par l'essai, comme `webrtcHardening` et `quicHardening` ; seul ce `false` ajoute `--disable-features=NetworkServiceSandbox` (vérifié par `browser-dedicated.test.ts`) ;
- le témoin UDP écoute sur l'adresse de la route par défaut (`defaultRouteIPv4`, une socket UDP « connectée » vers `192.0.2.1` : aucune émission) ; STUN, TURN-UDP et WebTransport visent cette adresse ; TURN-TCP reste sur `127.0.0.1` ;
- toutes les mesures du tableau se font sans ce bac à sable, ce qui rend la preuve plus exigeante (les drapeaux ferment l'UDP sans son aide), plus une mesure avec le lancement exact de l'application ;
- contrôle à zéro malgré tout, ou pas de route par défaut : essai ignoré avec la raison (`ctx.skip`), vérifié en forçant le contrôle sous bac à sable (0 datagramme, 2 candidats, 1 connexion TURN-TCP → ignoré avec ce message).

Constat de sécurité au passage : sur cette machine, le bac à sable de Chrome bloque déjà l'UDP WebRTC du navigateur de l'application ; ce n'est pas une garantie (dépend de la machine), le drapeau `disable_non_proxied_udp` reste la protection prouvée.

## 7. Autres preuves réseau (rappel)

Garde CDP seule : zéro requête vers un serveur témoin interdit pour redirections 302/307/en chaîne/meta, images, scripts, CSS, trames, `fetch`, XHR, balise, SSE, travailleur, nouvelle fenêtre, formulaire, service worker (son script est refusé). Pile complète : zéro requête et zéro connexion. Mesuré non couvert par `Fetch` : WebSocket et préconnexion (couverts par le filet). Détail : `browser.engine.test.ts` (29 essais).

## 8. Gates exécutés

| Gate | Résultat |
|---|---|
| `npm run test:core` | sort avec le code 0 (integrations : 211 essais ; cli : 461 ; bridge, tools, agent verts) |
| essais E2 du moteur réel | `browser.engine.test.ts` 29, `browser.lifecycle.engine.test.ts` 6 |
| essais unitaires E2 | hôte 12, cycle de vie 4, navigateur dédié 7, règle et contrôleur 28, pont de réglages 8 |
| passerelle + noyau + moteur réels | `cli/test/connected-browser-app.test.ts` 5 |
| e2e de l'application construite | 19 sur 19 (9 E2 + 10 du shell) |
| `tsc --noEmit` | propre : integrations, tools, agent, cli, bridge, contracts, apps/desktop (renderer et electron) |
| essais de `apps/desktop` | 1126 passés, 3 ignorés |

## 9. Réserves — le confinement réseau n'est PAS déclaré exhaustif

Prouvé : requêtes HTTP(S) de tout type, redirections, nouvelles fenêtres, travailleurs, WebSocket, préconnexion, WebRTC (STUN, TURN UDP et TCP), WebTransport/QUIC, vers des témoins sur la machine.

Non prouvé, donc non revendiqué :

1. **Trafic réseau du système et non du navigateur** : résolution DNS d'un hôte permis (visible du résolveur et du réseau), validation des certificats par Windows (récupération de chaînes ou de listes de révocation), mDNS/LLMNR, NTP.
2. **Destinations hors machine** : tous les témoins sont sur `127.0.0.1`. Les drapeaux sont généraux, mais aucune mesure n'a été faite vers une adresse externe ou du réseau local.
3. **Autres protocoles du navigateur** non essayés : FTP, DNS sur HTTPS, ICE-TCP vers un pair, Bluetooth/USB/série, Network Information, connexions de l'interface du navigateur (hors page).
4. **Un hôte permis qui redirige vers un autre hôte permis** est suivi (les deux sont permis) ; **le contenu d'un hôte permis reste non fiable**.
5. **Le point d'accès CDP reste joignable par tout processus du même utilisateur** pendant une session (bouclage, port aléatoire, chemin secret, Host et Origin contrôlés, durée de vie courte) : c'est la limite d'un point d'accès réseau local ; l'alternative (tuyau DevTools) n'est pas utilisable avec le moteur épinglé.
6. **Fenêtre de perte de garde** : quand la connexion CDP de la garde tombe, on ne sait pas ce que devient une requête déjà en pause côté Chrome (hypothèse : elle est relâchée). Ce qui borne la fenêtre est l'arrêt immédiat du navigateur et le filet (proxy mort hors liste blanche) ; l'intervalle et ce comportement n'ont pas été mesurés.
7. **Jamais essayé sur une session ouverte de l'utilisateur** (comptes, cookies, navigateur quotidien) : cela demande une autorisation distincte et n'a pas été fait.
8. **Distribution** : le moteur et le Chromium ne sont pas dans l'installeur ; la détection par `JAROD_E2_ENGINE_ROOT` est celle d'une installation de développement.

## 10. Relancer les preuves

```bash
npm run bundle:core --prefix apps/desktop && npm run build --prefix apps/desktop
npm run test:core
npx playwright test --config apps/desktop/playwright.config.ts
```
