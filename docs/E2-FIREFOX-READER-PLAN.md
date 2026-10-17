# E2 — lecture ponctuelle dans Firefox par une extension (plan, manifeste de permissions, transport)

Statut : **plan écrit le 2026-10-17 avant le développement ; extension et courtier développés et essayés sur un Firefox de test (voir §7), rien n'est installé dans votre Firefox**. Aucune installation dans votre Firefox, aucune connexion à votre session, aucun changement d'option, aucun débogage. Les essais se font sur un Firefox de test (build ESR 153.5.0 séparé dans `engines/firefox-test`, profil neuf, `-no-remote`), avec des onglets leurres.

## 1. Ce que cette voie fait et ne fait pas

- **Fait** : vous cliquez sur le bouton de l'extension dans l'onglet de votre choix ; JAROD-OS demande son accord central pour une lecture exacte (onglet, document, origine, élément) ; après accord, l'extension lit **le titre et le texte d'un seul élément convenu** du document principal, et JAROD-OS l'affiche **localement**.
- **Ne fait pas** : clic, saisie, navigation, téléchargement, lecture de formulaire, extraction du DOM, énumération d'onglets, lecture de cookies ou d'historique, envoi à un modèle.
- **Ne fournit PAS le confinement réseau du Chrome jetable** : cette voie contrôle ce que JAROD-OS peut *lire* ; elle ne filtre aucun trafic de votre Firefox (pas de garde CDP, pas de proxy mort, pas de durcissement WebRTC). Le navigateur continue à communiquer comme d'habitude. Les interdictions de domaines, l'accord par opération et l'expiration restent obligatoires.

## 2. Manifeste (MV3) et permissions

```json
{
  "manifest_version": 3,
  "name": "JAROD-OS — lecture ponctuelle",
  "version": "0.1.0",
  "description": "Propose l'onglet que vous choisissez à JAROD-OS pour une lecture unique, après accord.",
  "browser_specific_settings": { "gecko": { "id": "jarod-reader@jarod.os", "strict_min_version": "128.0" } },
  "permissions": ["activeTab", "scripting", "storage"],
  "action": { "default_title": "JAROD-OS : proposer cet onglet pour une lecture" },
  "background": { "scripts": ["background.js"] },
  "options_ui": { "page": "options.html", "open_in_tab": false }
}
```

| Permission | Pourquoi | Ce qu'elle n'ouvre pas |
|---|---|---|
| `activeTab` | Accès temporaire à l'onglet sur lequel vous venez de cliquer, jusqu'à sa navigation ou sa fermeture. C'est le geste qui sélectionne la cible. | Aucun autre onglet, aucun accès permanent. |
| `scripting` | Lire titre et élément dans cet onglet, après accord (`executeScript` avec une fonction fixe). | Pas de script de contenu permanent ; aucun site sans geste. |
| `storage` — **SUPPLÉMENTAIRE, à confirmer** | Garder le secret d'appairage du canal (§4) dans `storage.local`, que seule l'extension lit. Sans stockage, le secret serait à ressaisir à chaque réveil de l'extension, ou le canal ne pourrait pas être authentifié. | Aucun accès aux sites ni aux données du navigateur. Rien d'autre que ce secret n'y est rangé. |

Absents volontairement : `<all_urls>` et toute permission d'hôte, `tabs`, `cookies`, `history`, `webNavigation`, `downloads`, `debugger`, `nativeMessaging`, `clipboard*`, `webRequest`. Aucun script de contenu déclaré, aucune ressource accessible depuis le web (`web_accessible_resources` absent : une page ne peut pas découvrir l'extension).

## 3. Déroulement et invariants

1. **Geste.** Vous cliquez sur le bouton dans l'onglet voulu. L'extension reçoit cet onglet (`action.onClicked`), n'énumère rien, injecte une fonction qui **ne lit rien** : elle pose dans le bac à sable de l'extension un identifiant de document aléatoire. Elle envoie à JAROD-OS : identifiant d'onglet, origine, adresse sans requête ni fragment, identifiant de document. Pas de titre, pas de contenu.
2. **Politique.** JAROD-OS refuse sans rien demander : schéma autre que http(s), domaine interdit (liste intégrée, mots d'hôte, liste de l'utilisateur), domaine hors liste blanche, page non prise en charge. Aucune politique n'est modifiée pour faire réussir un essai.
3. **Accord central.** La demande nomme le navigateur (Firefox), l'origine et le chemin, le sélecteur de l'élément convenu, « lire le titre et le texte de cet élément », et vaut pour **cette** lecture seulement (durée limitée, usage unique). Absent, refusé, erreur ou expiré = aucune lecture.
4. **Lecture.** Après l'accord seulement, JAROD-OS envoie `read` avec un ticket à usage unique. L'extension **revérifie au moment de la lecture** : l'onglet existe et est celui du geste ; l'origine de l'onglet est celle de l'accord ; l'identifiant de document posé au geste est toujours là (une navigation ou un rechargement le détruit) ; le ticket n'est pas expiré. Dans la page, une fonction fixe refuse tout élément de formulaire (`input`, `textarea`, `select`, `button`, champ éditable, ou contenu dans un `form`), tout cadre autre que le document principal, tout sélecteur qui n'est pas simple (identifiant, classe, balise : pas de combinateur, d'attribut ni de liste) ; elle renvoie le titre (200 caractères au plus) et le texte de l'élément (500 au plus).
5. **Retour.** JAROD-OS revérifie ticket, usage unique, expiration et que la sélection n'a pas été invalidée pendant l'attente, puis **affiche localement**. Rien n'est envoyé à un modèle. Le journal ne garde que l'opération, l'hôte, le résultat et le motif.
6. **Invalidation.** Navigation, rechargement, fermeture de l'onglet, nouveau geste sur un autre onglet, déconnexion du canal ou expiration annulent la sélection et tout accord en attente.

## 4. Canal extension ↔ JAROD-OS : authentifié et borné

**Retenu pour le premier essai : HTTP sur le bouclage en interrogation longue, avec appairage.** Aucun composant à installer sur la machine.

*Changement par rapport au premier projet (WebSocket) : mesuré le 2026-10-17 sur Firefox 153, le mode « HTTPS d'abord » met `ws://` à niveau en `wss://` même vers `127.0.0.1` (échec TLS, code 1015), alors que `fetch` vers `http://127.0.0.1` passe. Le canal est donc du HTTP, sans permission d'hôte en plus.*

- Serveur de JAROD-OS sur `127.0.0.1`, port choisi par le système, **ouvert seulement pendant un essai**, fermé ensuite.
- **Authentification** : défi–réponse. `POST /hello` rend un défi aléatoire à usage unique (10 s) ; l'extension répond par `HMAC-SHA256(clé, défi)` à `POST /auth` ; le serveur rend un **jeton de session** aléatoire que portent ensuite `/msg` (événements) et `/poll` (commandes, interrogation longue de 20 s). La clé d'appairage (256 bits, générée par JAROD-OS pour la session d'essai et collée une fois dans la page d'options de l'extension) n'est jamais transmise. Trois échecs verrouillent le canal.
- **Bornes** : en-tête `Host` de bouclage obligatoire, `Origin` obligatoirement `moz-extension://…` (une page web est refusée sans même un en-tête CORS), types de contenu et chemins fermés, corps de 64 Ko au plus, 20 requêtes par seconde au plus, **un seul client**, session terminée après 30 s sans requête, `bye` à chaque nouveau geste.
- **Une page web ne peut pas** déclencher une lecture (elle n'a ni la clé, ni la bonne origine, et ne voit pas l'extension) ni fabriquer un accord (l'accord vient du canal central de JAROD-OS, jamais de l'extension ni de la page).
- **Limite honnête** : tout processus de votre session Windows qui connaîtrait la clé d'appairage pourrait parler au canal en imitant l'origine. La clé n'existe que pendant l'essai, dans la page d'options de l'extension et dans la mémoire de JAROD-OS ; elle n'est ni journalisée ni écrite.

**Alternative, plus forte, non installée** : messagerie native (Firefox n'autorise que l'extension nommée à parler à un programme relais). Elle exige des composants locaux : un fichier manifeste `one.jarod.os.bridge.json` déclaré dans le registre de l'utilisateur (`HKCU\Software\Mozilla\NativeMessagingHosts\…`), un petit relais (script Node lancé par un `.cmd`) qui se connecte au même serveur de bouclage, et la permission `nativeMessaging` en plus. À envisager pour un usage durable ; **rien de cela n'est installé** et cela demanderait votre accord distinct.

## 5. Composants et installation

| Élément | Où | Installé dans votre Firefox ? |
|---|---|---|
| Extension (`jarod-core/sidecars/firefox-reader/`) | dépôt | **Non.** Chargée uniquement dans le Firefox de test. |
| Serveur de canal et courtier de lecture (`integrations/src/impl/firefox-reader.ts`) | dépôt, désactivé, **non branché à l'application** (aucun écran, aucun démarrage) | Sans objet |
| Firefox ESR 153.5.0 et geckodriver 0.37.1 (essais) | `engines/firefox-test/` (ignoré par git), empreintes dans `engines.lock` | Sans objet : build séparé, profil jetable |

L'installation dans **votre** Firefox demanderait une extension signée ou un chargement temporaire par `about:debugging` : à décider avec vous, avec la cible exacte (navigateur, onglet, domaine, élément), avant toute connexion réelle.

## 6. Essais prévus (Firefox de test, onglets leurres)

Absence de geste ; refus d'accord ; expiration ; domaine interdit et domaine hors liste ; navigation, rechargement et fermeture pendant l'attente ; lecture de l'élément exact (et aucun autre contenu) ; élément de formulaire, champ de mot de passe, cadre, sélecteur large refusés ; mauvais secret, mauvaise origine, second client ; autres onglets jamais énumérés ni lus (jeu de messages vérifié) ; navigateur et onglets intacts après déconnexion ; journaux sans contenu.

## 7. Résultats des essais (2026-10-17)

Firefox ESR 153.5.0 de test (build séparé, profil neuf créé par geckodriver, `-no-remote`), extension chargée comme extension temporaire du seul Firefox de test, geste simulé sur le bouton de l'extension depuis l'interface du Firefox de test.

| Exigence | Essai | Résultat |
|---|---|---|
| permissions minimales | `firefox.reader.engine.test.ts` (permissions lues dans le Firefox), `extension-static.test.ts` | exactement `activeTab`, `scripting`, `storage` ; aucune permission d'hôte ; aucun script de contenu ni ressource web |
| absence de geste | « SANS GESTE » | refus, rien demandé, canal jamais ouvert |
| refus d'accord | « REFUS D'ACCORD » | aucune commande de lecture n'est partie |
| domaine interdit / hors liste | « DOMAINE INTERDIT… » | refus avant l'accord ; politique intacte |
| pages non prises en charge | « PAGES NON PRISES EN CHARGE » | aucun geste reçu pour `about:blank` |
| navigation, rechargement, fermeture pendant l'attente | trois essais | lecture annulée, aucune commande envoyée |
| lecture forgée après navigation | « LECTURE FORGÉE » | l'extension revérifie : refus, aucun contenu |
| élément exact | « LECTURE DE L'ÉLÉMENT EXACT » | titre et texte de `#note` seulement ; rien d'une zone voisine, d'un formulaire ou d'un autre onglet dans ce qui a circulé |
| formulaires, champs, éditables, boutons, absent | « ÉLÉMENTS DE FORMULAIRE… » | huit refus dans la page, aucune valeur lue |
| document principal seulement | « DOCUMENT PRINCIPAL… » | le contenu d'un cadre n'est jamais lu |
| usage unique | « USAGE UNIQUE » | nouveau geste exigé |
| autres onglets intacts | « AUTRES ONGLETS INTACTS » | onglets leurres présents, pages inchangées, seuls les types de message `select`, `invalidate`, `result` sont partis |
| navigateur intact après déconnexion | « DÉCONNEXION » | onglets, extension et navigateur intacts ; un nouveau clic ne produit plus rien |
| canal | `firefox-reader.test.ts` (27 essais) | page web, Host étranger, mauvais défi, rejeu, second client, verrouillage, corps trop grand, débit, absence d'activité : tous refusés ou terminés |

Mutations vérifiées : sans le refus de formulaire, sans la revérification à la lecture, sans la revérification après accord, ou avec `tabs.query` ajouté, les essais échouent.

**Ce que cette voie ne fournit pas** : le confinement réseau du Chrome jetable. Elle ne filtre aucun trafic de Firefox ; elle limite ce que JAROD-OS peut lire.
