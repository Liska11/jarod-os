# Plan de renommage global JAROD-OS (plan seulement, rien n'est renommé par ce document)

Statut : **préparé le 2026-10-17 ; lancé le 2026-10-19 sur décision de l'humain** (« renomme tout en Jarod-OS, le dossier de travail aussi »). Ce plan complète la section « Renommage JAROD-OS / jarod-sandbox » de `docs/BACKLOG.md`, qui dit ce qui est déjà fait.

### Décisions du 2026-10-19 (§6)

1. Chantier lancé. Le dépôt de travail est désormais `D:\Jarod-OS` (le disque D: est celui de Jarod-OS).
2. Noms cibles : variables `JAROD_OS_*` (l'ancien `HERALD_OS_*` reste lu en repli), paquets `@jarod-os/*` (déjà le scope de `mobile` et `pinokio-runtime`).
3. Partitions `persist:herald-*` : **noms gardés** (aucune donnée touchée ; ces noms ne sont visibles de personne).
4. Canaux de mise à jour : aucun retrait ; les anciens noms restent lus (phase 6 non lancée).
5. Retrait des replis (phase 6) : non décidé, rien n'est retiré.
6. Attribution à Herald OS : inchangée.
7. Un commit local par phase (jamais de push) : chaque phase s'annule seule par `git revert`.

Phase 0 faite : `scripts/rename-inventory.mjs` (inventaire par famille, lecture seule) et `jarod-core/tests/repo/rename-guard.test.ts` (attributions intactes ; cliquet par fichier contre `rename-baseline.json`, qui ne fait que baisser).

## 1. État vérifié

Mesuré avec `git grep` sur les fichiers suivis, hors `upstream/` (code importé), `package-lock.json` et `jarod-core/pnpm-lock.yaml`.

| Famille | Occurrences | Fichiers |
|---|---|---|
| `herald` (toutes casses, tout confondu) | environ 3 000 | environ 500 |
| `herald-os` | 1 792 | 256 |
| `herald-os-*` (identifiants de ressources) | 598 | 136 |
| `HERALD_*` (variables et constantes) | 557 | 143 |
| `HERALD_OS_*` (variables d'environnement) | 412 | 116 |
| « Herald OS » (texte) | 103 | 37 |
| `@herald-os/*` (noms de paquets) | 32 | 28 |
| `herald-host-*` (binaires Rust) | 8 | 5 |
| `herald-supervise` | 7 | 4 |
| `persist:herald-*` (partitions Electron) | 5 | 3 |
| `HERALD_SANDBOX_BIN` (ancien nom lu en repli) | 10 | 3 |

Répartition par dossier (occurrences de `herald`, toutes casses) : `apps/desktop` 1 076, `linux` 616, `docs` 338, `plugins` 200, `contracts` 148, `jarod-core/packages` 83, `packaging` 80, `scripts` 73, racine (`README.md`, `WINDOWS-PORT-NOTES.md`, `jarod-herald-reuse.md`, `.env.example`) environ 170, `host-rust` 58, `.github` 42.

**Déjà au nom de Jarod** (à ne pas retoucher) : nom du produit et exécutable (`Jarod-OS`), `appId` `one.jarod.os`, identifiant utilisateur Windows de l'application (`one.jarod.os`), variables et données propres à Jarod (`JAROD_*`, `%LOCALAPPDATA%\Jarod-OS`, `@jarod/*`), le confinement `jarod-sandbox` et la variable `JAROD_SANDBOX_BIN` (l'ancienne `HERALD_SANDBOX_BIN` reste lue en repli).

## 2. Ce qui doit être conservé (jamais renommé, jamais effacé)

Le renommage global ne touche pas à l'attribution due à Herald OS (MIT, © 2026 Luke The Dev) ni aux notices des composants tiers.

- `jarod-core/licenses/HERALD-OS.md`, `LICENSE`, `NOTICE`, `docs/THIRD-PARTY-NOTICES.md`, `jarod-core/licenses/*` (SANK-AI, SANK-UI, etc.) : texte intact.
- Le champ `copyright` de `apps/desktop/package.json` (« dérivé de Herald OS (© 2026 Luke The Dev, licence MIT) ») et toute mention équivalente dans l'écran « À propos » et dans les paquets d'installation.
- `jarod-herald-reuse.md` et `docs/DECISIONS.md` (dont l'ADR-016 « Hermes OS is now Herald OS ») : historique, on n'en réécrit pas le passé ; on ajoute une entrée datée.
- `upstream/` et `jarod-core/upstream.json` : code importé, suivi par `UPSTREAM-WATCH.md`. Les noms qu'il contient sont ceux de l'amont.
- L'historique git.

Test de garde à créer (phase 0) : un test qui échoue si l'un de ces fichiers perd la chaîne « Luke The Dev » ou « MIT ».

## 3. Les contrats à migrer, famille par famille

Un nom n'est pas un simple texte quand deux processus, deux versions ou des données déjà écrites doivent se retrouver par lui. Chaque famille a donc sa règle de compatibilité.

| Famille | Nature du contrat | Règle de migration |
|---|---|---|
| **A. Variables d'environnement `HERALD_OS_*`** (`CONTROL_TOKEN`, `CONTROL_SOCKET`, `BACKEND_URL`, `HERMES_ROOT`, `BACKEND`, `DEV_UNSIGNED`, `SHELL_MODE`, `BACKEND_TOKEN`, `SCALE`, `CONTRACTS_DIR`, `CONFIG_DIR`, `COMPOSITOR`, `CLI_TOKEN`, etc.) et `HERALD_*` voisines (`HERALD_EVENTS`, `HERALD_SKIN`, `HERALD_VM_*`, `HERALD_HYPR*`) | Posées par des scripts, des unités systemd, des tests, `.env.example`, la CI | **Double lecture** : le nouveau nom `JAROD_OS_*` l'emporte, l'ancien est lu en repli (même mécanique que `JAROD_SANDBOX_BIN` / `HERALD_SANDBOX_BIN`, avec ses deux tests). Les jetons (`CONTROL_TOKEN`, `CLI_TOKEN`, `BACKEND_TOKEN`) : la valeur ne change pas, seul le nom ; aucune valeur n'est lue, copiée ni journalisée par la migration. |
| **B. Paquets `@herald-os/*`** (32 occurrences) | Noms de paquets du dépôt, résolus par le gestionnaire de paquets | Renommage mécanique atomique (manifestes, imports, alias, lockfiles régénérés). Aucun consommateur externe : pas de repli nécessaire. |
| **C. Identifiants de ressources `herald-os-*`** : tubes `pipe://herald-os-*`, unités et minuteries systemd (`herald-os-update-check`, `herald-os-session`, `herald-os-compositor`, `herald-os-firstboot`…), `herald-os.desktop`, `herald-os-bridge` (187 occurrences), schéma `herald-plugin` (23), partitions `persist:herald-web/-preview/-viewer` | Rendez-vous entre processus, fichiers installés, session du navigateur embarqué | Le serveur écoute sous le **nouveau** nom, le client essaie le nouveau puis l'ancien. Unités systemd : installer les nouvelles, désactiver puis retirer les anciennes dans le script de mise à jour. Partitions `persist:` : **leur nom désigne les cookies et le stockage déjà écrits** ; renommer sans copier les efface, donc migration explicite ou conservation du nom (décision humaine, voir §6). Schéma `herald-plugin` : les plugins installés l'utilisent dans leurs URL ; double enregistrement pendant la transition. |
| **D. Binaires Rust** `herald-host-spike`, `herald-supervise` (crates `host-*`) | Lancés par le shell et les unités | Renommer les binaires avec les crates ; le shell cherche le nouveau puis l'ancien ; mêmes tests d'attaque (`attack_matrix`) qu'aujourd'hui. |
| **E. Données de l'utilisateur** (dossiers sous `userData` / `appData`, clés de configuration, anciens noms Hermes/Herald) | Données existantes sur disque | Étendre `migrateLegacyData` (ADR-016 le fait déjà de Hermes vers Herald) : **copie**, jamais déplacement ni suppression ; l'ancien dossier reste en lecture seule jusqu'à la phase 6 ; un marqueur de migration daté ; retour arrière = relancer l'ancienne version, qui retrouve ses données. |
| **F. Texte visible** (« Herald OS » dans l'interface, la documentation, les messages) | Aucun contrat | Remplacement revu à la main, **sauf** les attributions du §2. |
| **G. CI et empaquetage** (`.github` 42, `packaging` 80, `scripts` 73) : noms d'artefacts, d'images, de dépôts de mise à jour | Canaux de mise à jour des installations existantes | Les installations existantes cherchent la mise à jour sous l'ancien nom : publier sous les deux noms pendant la transition. Les secrets de signature (`COSIGN_*`) ne sont ni lus ni modifiés (action humaine). |

## 4. Phases

Chaque phase est un lot séparé, avec ses tests écrits d'abord (rouges avant, verts après), son retour arrière, et ne commence que quand la précédente a passé les gates (`npm run test:core`, typecheck des paquets touchés, tests de `apps/desktop`, tests Rust de `host-rust`, E2E du shell construit).

| Phase | Contenu | Retour arrière |
|---|---|---|
| **0. Filet** | Script d'inventaire (les comptes du §1, par famille, sortie stable) ; test de garde des attributions (§2) ; test qui échoue si une NOUVELLE occurrence d'un nom `herald` apparaît hors liste d'exceptions (il faut rendre le chantier irréversible vers l'avant). | Aucun risque : lecture seule. |
| **1. Paquets internes** (famille B) | `@herald-os/*` vers `@jarod/*` ou nom retenu, lockfiles régénérés. | `git revert` du lot. |
| **2. Variables d'environnement** (famille A) | Double lecture partout (une fonction unique `envName(new, old)`), tests « l'ancien nom marche encore, le nouveau l'emporte » par variable. Scripts, `.env.example`, unités : nouveaux noms. | Les anciens noms restent lus. |
| **3. Rendez-vous entre processus** (famille C, tubes, sockets, schéma) | Serveur sous le nouveau nom, client nouveau puis ancien, double enregistrement du schéma de plugin. Tests avec VRAI processus fils (un client de la version précédente contre le serveur neuf et l'inverse). | Le client de l'ancienne version trouve toujours l'ancien nom. |
| **4. Binaires et unités** (familles D et C système) | Crates et binaires Rust, unités systemd, `.desktop`, scripts d'installation et de mise à jour ; rejouer `attack_matrix` et le selftest de confinement. | Les unités anciennes ne sont retirées qu'à la phase 6. |
| **5. Données** (famille E et partitions `persist:`) | Migration par copie, marqueur, tests sur un profil jetable fabriqué (jamais le profil réel de l'utilisateur) ; test « rien n'est supprimé ». | Ancien dossier intact. |
| **6. Retrait des replis** | Après au moins deux versions publiées sans retour, supprimer les lectures de repli, les anciens noms d'unités, les doubles publications ; ADR datée. | Phase facultative, la plus risquée : seulement sur décision humaine. |

Les phases 1 à 5 sont **additives** : à chaque instant, une installation existante continue de démarrer et de retrouver ses données.

## 5. Vérifications de fin de chantier

- L'inventaire de la phase 0 ne montre plus de `herald` que dans la liste d'exceptions du §2 (attributions, historique, amont).
- Une installation de la version précédente, mise à jour sur place, démarre, retrouve ses réglages, son coffre et ses sessions.
- Les tests Rust (`cargo test -p host-sandbox` et les autres crates), `npm run test:core`, les tests de `apps/desktop`, l'E2E du shell construit passent.
- Aucun secret, jeton ou clé n'a été lu, copié ni journalisé par une migration.

## 6. Décisions qui reviennent à l'humain

1. **Lancer ou non le chantier**, et à quelle échéance (3 000 occurrences, environ 500 fichiers, aucun gain fonctionnel).
2. **Le nom cible des variables** (`JAROD_OS_*` ou `JAROD_*`) et des paquets internes.
3. **Les partitions `persist:herald-*`** : migrer (copie des cookies et du stockage) ou garder les noms existants, qui ne sont visibles de personne.
4. **Les canaux de mise à jour** déjà distribués : durée de la publication sous les deux noms.
5. **Le retrait des replis** (phase 6) : à partir de quelle version.
6. **Le texte de l'attribution** à Herald OS dans l'interface et l'installeur : inchangé par défaut.
7. Tout ce qui touche aux secrets de signature de la CI (`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`) : action humaine, hors de ce chantier.

## 7. Ce que ce plan ne fait pas

Il ne renomme rien, ne lance aucune migration, ne touche ni aux notices tierces ni aux secrets, et ne décide pas à la place de l'humain. Le seul renommage déjà fait est celui du confinement (`jarod-sandbox`), décrit dans `docs/BACKLOG.md`.
