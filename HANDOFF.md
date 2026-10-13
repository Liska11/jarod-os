# HANDOFF — passation Jarod-OS

Rédigé le 14/10/2026 pour l'agent suivant (Hermes), qui n'a pas l'historique de conversation.
Branche : `feature/windows-port` (107+ commits en avance sur `origin/main`). **Rien n'a été poussé** : consigne du propriétaire, « pas de push hors local ». Ne poussez pas sans son accord explicite.

## 0. Reprendre ici (sauvegarde du 14/10/2026)

**Sauvegardes sur D:**
- `D:\jarod-os-2026-10-14.bundle` (10,8 Mo) : copie complète du dépôt avec toutes les branches. Vérifiée avec `git bundle verify`. Pointe sur `feature/windows-port` au commit `2b11918`, plus ce commit de mise à jour (le bundle a été créé juste avant).
- `D:\JarodOS-Setup-0.1.0-alpha.1-win-x64.exe` : l'installeur reconstruit. Empreinte SHA-256 identique à celle de la section 2.

**Restaurer après une réinstallation de Windows** (si `C:\Users\San\herald-os` est perdu) :
```bash
git clone -b feature/windows-port D:/jarod-os-2026-10-14.bundle herald-os
cd herald-os
git remote set-url origin https://github.com/PAVADI234/herald-os
npm install
pnpm --dir jarod-core install
```
Avant de cloner, refaire un bundle si des commits ont été ajoutés après le 14/10 : `git bundle create D:/jarod-os-<date>.bundle --all`.

**Pour la prochaine session** : copier ce fichier à l'agent, puis lui demander de commencer la section 7. Points à rappeler :
- toujours pas de push sans accord ;
- le propriétaire n'a pas encore validé la tâche 3 de la section 4 (dossier Pinokio géré par Jarod-OS) ;
- la réinstallation de Windows est envisagée. Placer le dossier Pinokio sur D: (par exemple `D:\pinokio`) pour garder les apps d'IA et leurs modèles.

## 1. Contexte projet

- **Jarod-OS** (dépôt `herald-os`, anciennement Herald OS / Hermes OS) est un « système d'exploitation agent-natif » : un bureau complet (fenêtres, Dock, Fichiers, Réglages, barre de commandes) en Electron, piloté par un assistant IA nommé Jarod (renommable).
- **Stack** :
  - `apps/desktop/` : le shell. Electron 44 (Node 24), React + Vite, état avec nanostores, IPC main ↔ preload ↔ renderer, tests vitest, lint Biome.
  - `jarod-core/` : le noyau agent (moteur). Monorepo pnpm en TypeScript, avec ses outils dans `packages/plugins/tools/src/`. Il tourne sous `Jarod-OS.exe` en mode Node (`ELECTRON_RUN_AS_NODE`) et parle au shell par un socket de contrôle (`HERALD_OS_CONTROL_SOCKET` / `HERALD_OS_CONTROL_TOKEN`, lignes JSON).
  - Hermes Agent est une option de compatibilité, plus le moteur par défaut (ADR-020).
  - `pinokio-runtime/` : le moteur Pinokio embarqué (`pinokiod` 8.2.2, MIT).
- **Où en est le projet** : alpha (`0.1.0-alpha.1`). Le port Windows est fonctionnel et produit un installeur NSIS (≈ 137 Mo). Deux passes d'analyse et d'amélioration ont été faites (`ANALYSE-2026-10-12.md`, `ANALYSE-2026-10-13.md`), puis l'intégration de Pinokio.

## 2. État actuel (fait, commité, testé)

- **Windows** : installeur NSIS non signé et paquet appx ; instance unique ; mode sans échec (`--safe-mode`) ; récupération après plantage du rendu ; géométrie de fenêtre mémorisée ; icône de notification ; réglages du shell sous `%APPDATA%\Jarod-OS\config`, avec migration automatique ; écritures atomiques des réglages.
- **Sécurité** : sockets de contrôle limités (1 Mo par ligne, jeton comparé à temps constant) ; `nodemailer` 10, `pnpm audit --prod` à 0 faille.
- **i18n** : infrastructure typée en/fr ; langue et nom de l'assistant réglables ; environ 1 140 chaînes restent à traduire.
- **Pinokio** (ADR-022, commits `a49c985`, `d581ed2`, `8e27c66`, `23e0d6b`) :
  - Le moteur `pinokiod` est embarqué. Il démarre à la demande et s'arrête à la sortie de Jarod-OS.
  - Il est corrigé pour n'écouter que sur 127.0.0.1, avec une garde Host/Origin (`apps/desktop/electron/pinokio/guard.ts`).
  - Une fenêtre « Pinokio » présente le moteur (`apps/desktop/src/features/pinokio/PinokioWindow.tsx`).
  - Cinq commandes OS (`apps/desktop/src/commands/pinokio.ts`).
  - Sept outils agent `pinokio_*` (`jarod-core/packages/plugins/tools/src/pinokio/`) ; install, run et stop exigent un accord.
- **Installeur reconstruit le 14/10/2026** (`npm run dist:win`, code de sortie 0, depuis le commit `23e0d6b`). `apps/desktop/release/` est ignoré par git, donc seules les empreintes sont consignées ici :
  - `JarodOS-Setup-0.1.0-alpha.1-win-x64.exe` (136 935 970 octets), SHA-256 `ad58f14a011d5e278743f80ecfb0db258bcaf3268dc159e367fc8d09c73ee8e4`
  - `JarodOS-0.1.0-alpha.1-win-x64.appx` (193 940 024 octets, non signé), SHA-256 `4f5a1d83b9723da4163da94662abb1940abb5ebb523e0f7e97247b1ebff1fabb`
- **Tests au dernier passage** : shell 116 fichiers et 724 tests OK ; noyau 2 589 tests OK ; typecheck OK ; Biome 0 erreur (530 avertissements hérités).

## 3. Travail en cours

Aucune tâche entamée et non terminée. L'arbre de travail était propre au moment de cette passation, et la dernière fonctionnalité (Pinokio) est complète et commitée.

Points vérifiés seulement en partie :
- Pinokio n'a pas été testé de bout en bout sur une vraie app d'IA (plusieurs Go de téléchargement).
- `pinokio_run` repose sur l'API interne de pinokiod (WebSocket `{uri, mode:"open"}`, puis exécution des scripts jusqu'à ce que le menu donne une URL). Voir `jarod-core/packages/plugins/tools/src/pinokio/tools.ts`, fonction `drive`. Seul un faux moteur l'a exercé (`jarod-core/packages/plugins/tools/test/pinokio-tools.test.ts`).
- Le paquet appx n'a pas été testé.

## 4. TODO restant (par priorité)

1. **Phase d'initialisation (first-run)** : voir la section 7, spécification du propriétaire. C'est la prochaine phase.
2. **Sauvegarde de la branche** : rien n'est poussé. Proposer au propriétaire `git bundle create ..\jarod-os.bundle --all` ou un push, avec son accord.
3. **Dossier Pinokio géré par Jarod-OS** (proposé, pas encore validé par le propriétaire) :
   - Aujourd'hui, pinokiod lit `~/.pinokio/config.json`, dont la clé `home` vaut par défaut `C:\pinokio`.
   - Au premier lancement, Pinokio affiche son écran « Set a Pinokio home folder ».
   - Idée : Jarod-OS choisit et retient ce dossier, de préférence sur un disque autre que C:, pour survivre à une réinstallation de Windows.
   - Fichier concerné : `apps/desktop/electron/pinokio/service.ts` (`pinokioProfile`, `readPinokioHome`).
   - Lien avec la section 7 : l'audit pourrait proposer ce dossier.
4. **D1 : confinement des écritures de `run_shell` sous Windows** (jeton restreint ou ACL). C'est un chantier de sécurité à part, à tester sur plusieurs versions de Windows. Seule vraie barrière manquante (voir `ANALYSE-2026-10-13.md`).
5. **Traductions restantes** : environ 1 140 chaînes, surtout dans les sections de Réglages. Lancer `npm run i18n:report --workspace apps/desktop` ; les clés sont dans `apps/desktop/src/locales/en.ts` et `fr.ts`.
6. **Signature de code puis mises à jour** (ADR-021) : il faut un certificat (décision et achat du propriétaire), puis un flux de mises à jour publié. Ne pas activer l'auto-update avant.
7. **Pinokio sur macOS et Linux** : seul `dist:win` embarque le moteur. Il faut adapter `apps/desktop/scripts/bundle-pinokio.mjs` (élagage par plateforme, rebuild de better-sqlite3) et les `extraResources` de `apps/desktop/package.json`.
8. **Tests réels de Pinokio** : installer et lancer une petite app depuis la fenêtre, puis via `pinokio_run` avec un vrai modèle ; vérifier l'appx ; tester l'option réseau `JAROD_PINOKIO_LAN=1`.

## 5. Environnement

**Prérequis** : Windows 11, Node ≥ 22.12 (Node 24 utilisé), npm (shell) et pnpm (noyau), et les outils de build C++ pour node-gyp.

**Commandes** (depuis la racine du dépôt) :

| But | Commande |
|---|---|
| Lancer en développement | `npm run dev` |
| Tests du shell | `npm test --workspace apps/desktop` |
| Typecheck du shell | `npm run typecheck --workspace apps/desktop` |
| Tests du noyau | `npm run test:core` |
| Typecheck du noyau | `npm run typecheck:core` |
| Lint | `npm run lint` |
| Installeur Windows | `npm run dist:win`, qui enchaîne `bundle:core`, `bundle:pinokio`, `build` et electron-builder ; sortie dans `apps/desktop/release/` (ignoré par git) |
| Forcer la reconstruction du runtime Pinokio | `node apps/desktop/scripts/bundle-pinokio.mjs --force` |

**Lancement isolé, sans toucher aux données réelles** : définir `HERMES_HOME`, `JAROD_OS_DATA`, `HERALD_OS_CONFIG_DIR` et `HERALD_OS_PINOKIO_PROFILE` vers des dossiers jetables, ajouter `--user-data-dir=<jetable>`, et `HERALD_OS_WINDOWED=1` pour une fenêtre normale. Le débogage CDP a fonctionné sur le port 9455 ; le 9333 était déjà pris.

**Pièges connus** :
- better-sqlite3 n'a pas de binaire précompilé pour l'ABI d'Electron 44 (149). `bundle-pinokio.mjs` le compile avec node-gyp contre les en-têtes d'Electron.
- `@homebridge/node-pty-prebuilt-multiarch` ne s'installe pas sous Node 24 (EINVAL). Il est installé avec `--ignore-scripts` et remplacé par un shim qui charge node-pty 1.1.0.
- pinokiod écoute toujours sur le port 42000. Si l'app Pinokio officielle tourne, Jarod-OS utilise son moteur (mode `external`) et ne l'arrête jamais. Les deux ne peuvent pas tourner en même temps.
- Les traces `AttachConsole failed` de node-pty sont sans danger ; le service les résume en une ligne.
- Les tests du noyau ne sont collectés que dans `test/`. L'inventaire `jarod-core/tests/repo/effect-paths.ts` doit classer tout nouvel outil, sinon le test d'inventaire échoue.
- Ne jamais lancer les tests ou l'app contre le vrai profil de l'utilisateur (`~\.pinokio`, `C:\pinokio`, `%APPDATA%\Jarod-OS`) : utiliser les variables ci-dessus.

## 6. Dernières décisions architecturales

Le détail est dans `docs/DECISIONS.md`.

- **ADR-020** : le noyau Jarod est le moteur ; Hermes devient une option de compatibilité. Les nouvelles fonctions système vont dans le noyau.
- **ADR-021** : pas d'auto-update tant qu'il n'y a ni signature de code ni flux publié.
- **ADR-022** : Pinokio est intégré en embarquant `pinokiod` tel quel. On n'a ni réécrit ni forké sa logique.
  - Pourquoi : ses scripts d'installation et son catalogue évoluent vite ; on garde la compatibilité en suivant la version amont.
  - Correctif de sécurité obligatoire : en amont, pinokiod écoute sur 0.0.0.0 sans authentification et exécute des commandes shell pour tout client. Notre `host.ts` le force sur loopback et filtre Host et Origin.
  - Les outils agent suivent l'API de `pterm`.
- Écarté :
  - Réimplémenter Pinokio dans le noyau : trop gros, et il aurait divergé de l'amont.
  - Piloter l'app Pinokio installée : dépendance externe, et faille non corrigée.

## 7. Phase suivante — à implémenter par l'agent repreneur

# Phase d'initialisation Jarod-OS — Détection système & configuration initiale

## Objectif
Au premier lancement de Jarod-OS (ou après réinstallation), exécuter un processus
d'initialisation en deux étapes : audit matériel/logiciel, puis configuration initiale
des identifiants et clés API.

## Étape 1 — Audit automatique du système
Détecter et inventorier automatiquement :

### Matériel
- OS : distribution/version, noyau, environnement (Windows natif, WSL2, Linux, Docker)
- CPU : modèle, nombre de cœurs/threads, instruction set (AVX2, AVX-512)
- GPU : présence, modèle, VRAM disponible
- NPU : présence et disponibilité (ex: Intel NPU, driver requis)
- iGPU : modèle et partage mémoire
- RAM et stockage disponible

### Logiciels & prérequis
Vérifier la présence, la version et la validité des prérequis :
- Drivers GPU/NPU à jour (CUDA, ROCm, OpenVINO, Vulkan selon matériel détecté)
- Node.js (version LTS minimale) et npm/pnpm
- Docker / WSL2 si applicable
- Outils complémentaires selon l'architecture retenue (Python, Ollama, etc.)

### Sortie attendue
- Rapport d'audit lisible : matériel détecté, prérequis OK/absents/dépassés,
  actions correctives recommandées (commandes exactes à exécuter)
- Blocage explicite si un prérequis critique manque, avec message d'aide
- Résultat persisté (JSON) pour éviter de refaire l'audit à chaque démarrage

## Étape 2 — Configuration initiale (interface first-run)
À la première configuration, présenter une interface guidée pour :

1. **Bot Telegram**
   - Champs : nom du bot, Bot Token (récupérable via @BotFather)
   - Validation du token par appel API test avant sauvegarde
   - Test d'envoi/réception d'un message de vérification

2. **Clés API**
   - Import d'un fichier `.txt` fourni par l'utilisateur contenant
     l'ensemble de ses clés API (format : `NOM_SERVICE=clé`, une par ligne)
   - Parsing robuste : ignorer lignes vides/commentaires, détecter doublons,
     valider le format par service
   - Option de correction en cas de ligne mal formatée

## Contraintes
- Stockage sécurisé des tokens et clés (fichier local chiffré ou permissions
  restreintes type `.env` avec chmod 600, jamais en clair dans les logs)
- Idempotent : relançable sans casser une configuration existante
- Toutes les étapes scriptées et reproductibles (aucune action manuelle non documentée)
- Journaliser chaque étape d'initialisation pour diagnostic ultérieur
