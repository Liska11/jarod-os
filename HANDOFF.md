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

**Phase d'initialisation (section 7) — avancement au 14/10/2026 :**
- ✅ **Étape 1, moteur de l'audit** : `apps/desktop/electron/setup/audit.ts`, avec 11 tests dans `audit.test.ts`.
  - Matériel :
    - OS et environnement (windows, wsl2, linux, docker, macos) ;
    - CPU avec AVX2 et AVX-512, via `IsProcessorFeaturePresent` ;
    - GPU, avec la vraie VRAM lue dans le registre de la classe d'affichage (AdapterRAM plafonne à 4 Go) ;
    - iGPU (mémoire partagée), NPU (PnP `ComputeAccelerator`), RAM et disque.
  - Logiciels : Node ≥ 22.12, npm, pnpm, Git, Python ≥ 3.10, Ollama, Docker, WSL2, CUDA (`nvidia-smi`), Vulkan, ROCm et OpenVINO (en info).
  - Chaque point a un statut ok, missing, outdated ou info, et une commande de correction exacte (winget sous Windows).
  - Seules la RAM < 4 Go et le disque libre < 2 Go bloquent.
  - JSON persistant via `runAudit({file})`, réutilisé sauf `force` ou changement de format. Chaque étape est journalisée.
  - Rapport texte : `formatReport`.
  - Vérifié pour de vrai sur la machine du propriétaire (2,3 s, rien de bloquant). Données jetables : le JSON est allé dans le scratchpad.
- ⏭ **À faire ensuite, dans l'ordre :**
  1. ✅ **Audit branché** (commit suivant `6d798c8`) :
     - `AuditService` (`electron/setup/service.ts`) est lancé en arrière-plan dans `app.whenReady` (`electron/main.ts`) et journalisé sous `audit`.
     - IPC `systemAuditGet` et `systemAuditRun` (`shared/ipc.ts`, `electron/ipc/system-audit.ts`), exposés au renderer par `window.heraldOS.systemAudit.get()` et `.run()`.
     - Types partagés dans `shared/system-audit.ts`.
     - ⚠️ **Il existe déjà un `setup` (IPC `setup*`, `electron/ipc/setup.ts`, `src/features/setup/FirstRunSetup.tsx`).** C'est le premier démarrage de **l'image Linux** : nom, mot de passe `passwd`, Wi-Fi. Il ne se déclenche que sous Linux, avec `/var/lib/herald-os/firstboot-done`. Ne pas le confondre ni l'écraser : l'audit utilise exprès le nom `systemAudit`. L'assistant Windows peut soit réutiliser `FirstRunSetup.tsx` (ajouter des étapes et étendre `setupState().needed` à Windows), soit être une fenêtre à part. Le plus simple : étendre `FirstRunSetup`.
     - Pas encore vérifié dans l'app lancée : seulement typecheck et tests. Pour vérifier, lancer `npm run dev` avec des dossiers jetables (section 5), puis dans la console du rendu : `await window.heraldOS.systemAudit.get()`.
  2. ✅ **Assistant de premier lancement sous Windows** :
     - `SetupState` a désormais un `mode` : `image` pour l'image Linux, `desktop` pour Windows. Sous Windows, l'assistant est dû tant que `setup-done` n'existe pas dans le dossier de configuration ; `HERALD_OS_SKIP_SETUP=1` le saute (`electron/ipc/setup.ts`, fonction `setupState`).
     - `FirstRunSetup.tsx` renvoie vers `src/features/setup/DesktopSetup.tsx` en mode `desktop`. Le parcours : Bienvenue → Vérification du système (matériel puis outils et pilotes, commande de correction copiable, « Vérifier à nouveau », « Suivant » désactivé si `blocked`) → Tout est prêt (`setup.finish`).
     - `Heading` et `Footer` ont été extraits dans `parts.tsx`.
     - Traductions en/fr sous les clés `setup.*`.
     - Vérifié dans l'app lancée avec un profil jetable : affichage en français, audit réel, fin du parcours, `setup-done` écrit, l'écran ne revient plus.
     - Limites :
       - les détails des lignes (« 24 cores », « present ») restent en anglais, car ils viennent de `audit.ts` ;
       - il n'y a pas encore de bouton « Relancer la vérification » dans les Réglages ;
       - les utilisateurs Windows existants verront l'assistant une fois, puisqu'ils n'ont pas de `setup-done`.
  3. ✅ **Étape 2, Telegram** :
     - `electron/setup/telegram.ts`, avec ses tests, vérifie le jeton dans main (format, puis `getMe`), puis fait un aller-retour : il attend un message au bot (`getUpdates`) et y répond (`sendMessage`). Cela se fait **avant** d'enregistrer le jeton et de démarrer la passerelle, sinon `getUpdates` entrerait en concurrence avec elle.
     - IPC `setupTelegramCheck` et `setupTelegramTest`, exposés en `window.heraldOS.setup.telegramCheck` et `.telegramTest`. Les erreurs ont un `code` traduit à l'écran.
     - L'écran est `src/features/setup/TelegramStep.tsx`, inséré entre `audit` et `done`. L'enregistrement passe par le noyau : `jarod('update-messaging-platform', 'telegram', { env: { TELEGRAM_BOT_TOKEN }, enabled: true })` met le jeton dans le **coffre chiffré du profil** ; ensuite `jarod('start-gateway')`. Rien n'est stocké côté shell.
     - Après l'enregistrement, une nouvelle personne reçoit un code d'appairage à valider avec `/pair <code>` (comportement existant du noyau).
     - Vérifié dans l'app : appel réel à Telegram avec un faux jeton, refus affiché, « Plus tard » mène à la fin. **Pas vérifié** avec un vrai bot : il faut un jeton du propriétaire.
     - Le champ « nom du bot » n'est qu'un rappel : le vrai nom vient de `getMe`, et le shell ne renomme pas le bot (`setMyName` est possible, mais pas fait).
  4. ✅ **Étape 2, import `.txt` des clés API** :
     - L'analyse est dans `src/features/setup/keys-import.ts`, avec ses tests. Elle accepte les lignes vides, les commentaires `#` ou `//`, `export NOM=…`, les espaces autour de `=` et les guillemets. Elle contrôle le nom, les espaces, et le préfixe des services connus (OpenAI `sk-`, Anthropic `sk-ant-`, Groq `gsk_`, HF `hf_`, etc.). Pour un nom en double, la dernière ligne gagne ; les précédentes sont marquées « remplacée par la ligne N ».
     - L'écran est `KeysStep.tsx`, entre `telegram` et `done` : choisir un fichier ou coller les lignes, puis relire chaque ligne. Les valeurs sont masquées, une ligne invalide se corrige sur place, puis « Importer N clé(s) ».
     - Où vont les clés :
       - une clé de fournisseur passe par `jarod('set-env', NOM, valeur)`, le stockage chiffré du fournisseur ; si le noyau ne connaît pas ce nom, elle va au coffre ;
       - un jeton de messagerie passe par `update-messaging-platform` ;
       - le reste va dans `vault-save` (le coffre, `envVar` = le nom, sans domaine ni accès au shell, donc sans demande de confirmation).
     - Après l'import, les valeurs sont effacées de la mémoire de l'écran.
     - Vérifié dans l'app avec un profil jetable et de fausses clés : analyse, masquage, correction d'une ligne, puis import réel par le noyau (2 clés de fournisseur, 1 au coffre).
  5. ✅ **Journal** : `electron/ipc/setup.ts` note la vérification et le test Telegram, puis la fin de la configuration, sous `setup`. L'audit est noté sous `audit`. Jamais de jeton ni de clé dans le journal.

**Arrêt au 14/10 (quota épuisé)** : tout est commité et sauvegardé sur D:, aucune tâche n'est à moitié faite. Ce qui reste à faire est dans la **section 4**, par ordre de priorité.

**Pour la prochaine session** : donner ce fichier à l'agent et lui demander de prendre la section 4 dans l'ordre. La phase d'initialisation de la spécification (section 7) est faite. Points à rappeler :
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
- **i18n** : infrastructure typée en/fr ; langue et nom de l'assistant réglables ; **310** chaînes restent en anglais, et c'est un plancher (le rapport ne compte que le JSX ; voir 4.B.6).
- **Premier lancement (Windows)** : assistant avec audit du système, bot Telegram, import des clés API ; rouvrable avec la commande `setup.open` ; commande `system.audit` pour l'agent. Détail en section 0.
- **Pinokio** (ADR-022, commits `a49c985`, `d581ed2`, `8e27c66`, `23e0d6b`) :
  - Le moteur `pinokiod` est embarqué. Il démarre à la demande et s'arrête à la sortie de Jarod-OS.
  - Il est corrigé pour n'écouter que sur 127.0.0.1, avec une garde Host/Origin (`apps/desktop/electron/pinokio/guard.ts`).
  - Une fenêtre « Pinokio » présente le moteur (`apps/desktop/src/features/pinokio/PinokioWindow.tsx`).
  - Cinq commandes OS (`apps/desktop/src/commands/pinokio.ts`).
  - Sept outils agent `pinokio_*` (`jarod-core/packages/plugins/tools/src/pinokio/`) ; install, run et stop exigent un accord.
- **Installeur reconstruit le 14/10/2026 depuis le commit `114188c`** (il contient l'assistant de premier lancement : audit, Telegram, clés API, plus les traductions du panneau d'état et le groupe « Vérification du système » des Réglages). `apps/desktop/release/` est ignoré par git ; les empreintes sont consignées ici :
  - `JarodOS-Setup-0.1.0-alpha.1-win-x64.exe` (136 964 818 octets), SHA-256 `e66038ce33f3ef111e6aba2a20482dd37f3abc30cf5bf641223a4e0f4df54bb8`. La copie sur `D:` est identique (vérifiée).
  - `JarodOS-0.1.0-alpha.1-win-x64.appx` (193 974 260 octets), SHA-256 `64a91c4df9c0cc748f82f104b1379a1bced61aa4f063388426a19f8d47bece37`. La copie sur `D:` est identique (vérifiée). **Non signé** (build Windows Store uniquement) : jamais installé ni testé.
- **Tests au dernier passage (14/10)** : shell, 121 fichiers et 755 tests OK ; typecheck OK ; Biome sans erreur (530 avertissements hérités). Noyau : 2 589 tests OK au 13/10 (il n'a pas été modifié depuis).

## 3. Travail en cours

Rien n'est en cours : l'arbre de travail est propre, et la dernière tâche (les contrôles partagés de Réglages et `jarod-settings-model`) est commitée.

## 4. Ce qui reste à faire (par priorité)

### A. À vérifier (fait, mais pas testé en conditions réelles)
1. **Telegram avec un vrai bot** : il faut le jeton du propriétaire. Parcours : assistant → Bot Telegram → Vérifier → envoyer un message au bot → Tester → Enregistrer. Vérifier ensuite que la passerelle démarre et que `/pair <code>` fonctionne.
2. ~~**Commande `setup.open` dans l'app lancée**~~ : **vérifié le 14/10, bug confirmé**. La commande est bien enregistrée (barre de commandes → « Open the setup wizard » l'affiche), mais `cmdk` ne déclenche pas son `onSelect` : ni le clic ni Entrée ne l'exécutent, la palette reste ouverte. Le défaut est dans l'intégration `CommandBar.tsx` / cmdk 1.1.1, pas dans l'enregistrement de la commande ni dans l'IPC. Seuls les tests unitaires la couvrent. **À corriger** : vérifier le `onSelect` des `Command.Item` et la sélection par défaut (« Ask Hermes »).
3. ~~**Nouvel installeur**~~ : **fait le 14/10 depuis `114188c`** (`npm run dist:win`), recopié sur D: et empreinte notée en section 2 (SHA-256 `e66038ce…`).
4. **Pinokio en vrai** : installer et lancer une petite app d'IA depuis la fenêtre Pinokio, puis via l'outil `pinokio_run` avec un vrai modèle. `pinokio_run` repose sur l'API interne de pinokiod (fonction `drive` dans `jarod-core/packages/plugins/tools/src/pinokio/tools.ts`) ; seul un faux moteur l'a exercé.
5. **Paquet `.appx`** : **construit le 14/10** (193 974 260 octets, SHA-256 `64a91c4d…`, en section 2) mais **non signé** et jamais installé ni lancé. Reste : **option réseau `JAROD_PINOKIO_LAN=1`** — jamais testée.

### B. À finir (petites tâches)
6. **Traductions** : **310** chaînes restent en anglais (`npm run i18n:report --workspace apps/desktop` les liste par fichier).
   - Déjà fait : les sections de Réglages Général, Apparence, Confidentialité, Voix, Appareils et API, Agent et sécurité, Règles d'automatisation, {assistant} et agents, Persona et profils, Secrets, Serveurs MCP, Documents (RAG), Skills, Plugins, Local models, Données et dossiers, Messagerie, **toute la page Automatisations**, l'assistant de premier lancement (image), la carte de connexion à Hermes, le bloc Hugging Face, **tout l'écran Connexions**, le volet d'artefacts (barre de mise en forme, menu d'export), les sections Réseau et Fournisseurs, le panneau Système, les échecs partagés de `attempt()` (25 sites d'appel), les contrôles partagés de Réglages (`jarod-controls`) et la prose de `jarod-settings-model` (messages de validation, `DECISION_LABEL`/`TOOL_SEARCH_LABEL` devenus des clés) (page, cartes, historique, colonne de détail Quand/Rassembler/Livrer, formulaire, menu d'un job) plus **les phrases de planning de `cron-humanize.ts`**, la page Kanban, le panneau d'état (Wi-Fi, Bluetooth, Son, Écrans, Alimentation, horloge), le bloc du moteur local llama.cpp et le menu de contrôle (Mod+M) en entier.
   - Modèles traduits : `kanban-model`, `rag-model`, `local-models-model`, `messaging-model`, `skills-model`, `connections-model` (`STATUS_KEY` + `statusLabel()` remplacent `STATUS_LABEL`), `providers-model` (`KIND_KEY` + `kindLabel()` remplacent `KIND_LABEL`), `automations/presentation.tsx` (`describeJob`, `describeGather`, `describeDeliver`, `eventLabel`, `ruleText`), `automations/cron-humanize.ts`.
   - **Le rapport ne compte que le JSX** (texte entre balises et attributs `title`/`label`/`placeholder`/`description`/`aria-label`/`hint`). Celles des modules de données et de présentation n'y figurent pas alors qu'elles s'affichent : `shared/events.ts` (`HERALD_EVENTS[].label`, `describeRule`), `shared/plugins.ts` (`describePermissions`), `kanban-model`, `jarod-settings-model`, `devices-model`, `mcp-model`, `rules-model`, `vault-model`. **310 est donc un plancher, pas le total réel.**
   - Pour ces modules partagés avec le processus principal (`shared/events.ts`, `shared/plugins.ts` sont importés par `electron/`), **ne pas** rendre la fonction elle-même dépendante de la langue : garder la fonction anglaise (contrat de l'API de contrôle, assertée par les tests) et formater côté interface avec `t('clé')` — fait pour `plugins.perm.*`, `eventLabel()` et `ruleText()`.
   - Suivants, dans l'ordre du rapport : `settings/sections/MenuBarSettings.tsx` (13), `memory/MemoryDetail.tsx` (12), `AccessibilitySection.tsx` (12), `BrandingSettings.tsx` (12), `UsageSection.tsx` (12), `files/FilesPage.tsx` (11)…
   - **Vérification qui a payé** : après avoir traduit les phrases de planning, les fonctions ont été exécutées dans les deux langues (petit test jetable qui importe `cron-humanize.ts`, règle `$prefs.language`, écrit les résultats puis est supprimé) — trois défauts sont sortis que le typecheck et les tests ne voyaient pas : un jour unique rendu « Fridays and », la virgule anglaise devant l'année qui fuyait en français, et une minuscule en début de phrase. **Refaire ce contrôle à chaque module de phrases.**
   - Méthode : remplacer chaque littéral par `t('clé')`, appeler `useT()` dans chaque composant, ajouter la clé dans `src/locales/en.ts` **et** `fr.ts`, avec les mêmes `{placeholders}`. Le test `src/lib/i18n.test.ts` le vérifie.
   - **Pièges rencontrés, à ne pas répéter** :
     - `fr.ts` et plusieurs composants sont en **CRLF** : lire avec `io.open(..., encoding='utf-8')` (fin de lignes universelles) et réécrire avec `newline=''`, sinon les motifs multi-lignes ne matchent pas.
     - **Ne jamais ouvrir un fichier en écriture avant d'avoir construit la chaîne à écrire** : `io.open(p, 'w')` tronque immédiatement, et une erreur ensuite laisse le fichier à 0 octet (c'est arrivé à `en.ts`, restauré par `git checkout`).
     - Écrire le **français accentué** (é, è, à, ç, ô…) : les premiers blocs étaient sans accents ; corrigé au commit `086e339`. Utiliser l'espace insécable avant `:` et `?`, et `…` plutôt que `...`.
     - Une chaîne TS entre guillemets simples ne doit pas contenir d'apostrophe : utiliser `"..."` ou `\u2019`.
     - Une jointure « a et b » ne doit pas s'appliquer à un seul élément : `joinList()` dans `cron-humanize.ts` gère les cas 0/1/2/n.
     - **Une variable locale nommée `t` masque le traducteur** : plusieurs fonctions de validation faisaient `const t = text.trim()` ; après l'ajout de `t('clé')` l'appel partait sur la chaîne. Renommer la locale en `value`/`text`. Le typecheck ne le voit pas toujours ; les tests, oui.
     - Les phrases françaises demandent souvent leur propre gabarit, pas une concaténation : `attempt()` porte une clé par phrase (`native.failed.*`) parce que « Impossible **d'**ouvrir le fichier » et « Impossible **de** quitter » ne se déduisent pas l'une de l'autre.
   - Toujours lancer typecheck et tests **avant** de committer.
7. ~~**Réglages**~~ : **fait le 14/10** — groupe « Vérification du système » dans la section Général : « Relancer la vérification du système » (`window.heraldOS.systemAudit.run()`) et « Importer des clés API » (ouvre `KeysStep.tsx` dans une fenêtre modale).
8. **Assistant sur Linux et macOS** : l'assistant `desktop` n'est activé que sous Windows (`setupState()` dans `apps/desktop/electron/ipc/setup.ts`). L'audit fonctionne partout ; il faut décider si l'assistant s'affiche aussi sur macOS et sur Linux hors image.

### C. Chantiers (à décider avec le propriétaire)
9. **Dossier Pinokio géré par Jarod-OS** (proposé, **pas encore validé**) :
   - pinokiod lit `~/.pinokio/config.json`, clé `home`, par défaut `C:\pinokio` ; au premier lancement, Pinokio affiche son écran « Set a Pinokio home folder ».
   - Idée : Jarod-OS choisit et retient ce dossier, de préférence sur un autre disque que C: (par exemple `D:\pinokio`), pour survivre à une réinstallation de Windows. L'audit pourrait le proposer.
   - Fichier : `apps/desktop/electron/pinokio/service.ts` (`pinokioProfile`, `readPinokioHome`).
10. **D1 : confinement des écritures de `run_shell` sous Windows** (jeton restreint ou ACL) : c'est la seule vraie barrière de sécurité qui manque (voir `ANALYSE-2026-10-13.md`). Chantier à part, à tester sur plusieurs versions de Windows.
11. **Signature de code puis mises à jour** (ADR-021) : il faut un certificat (décision et achat du propriétaire), puis un flux de mises à jour publié. Ne pas activer l'auto-update avant.
12. **Pinokio sur macOS et Linux** : seul `dist:win` embarque le moteur. Adapter `apps/desktop/scripts/bundle-pinokio.mjs` (élagage par plateforme, rebuild de better-sqlite3) et les `extraResources` de `apps/desktop/package.json`.
13. **Push vers GitHub** : rien n'est poussé (`origin` = PAVADI234/herald-os). Seulement avec l'accord explicite du propriétaire.

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
