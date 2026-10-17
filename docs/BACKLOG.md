# Backlog (trajectoire Jarod-OS)

Items identified and deliberately not done. Each survives the session here.

## From the master prompt

- 12 npm vulnerabilities in `apps/desktop` (2 critical, 2 high): detailed audit, then `npm audit fix` after validation.
- 543 lint warnings (accepted debt).
- 18 shell protocol tests skipped on Windows (no fake named pipe): restore coverage.
- Rotation of `control-audit.jsonl` (unbounded growth).
- The Python client is more tolerant than the shell on pipe endpoints (the Rust host emits the strict form).
- R2/R3 end-to-end in the real application to re-prove (disposable profile).

## From phase 3.1 / 3.2 (sandbox)

- **`readRoots` in the shell policy** so `node`, `git`, etc. are reachable inside the sandbox. Today the confinement is
  real but the command only sees the system folders on its PATH, which makes it of limited daily use. The Rust side
  already supports `Policy::read_roots` (granted read+execute and appended to PATH); what is missing is the field in
  `ShellPolicy` (`@jarod/contracts`), the settings UI and the plumbing in `shell-guard.ts`.
- **cmd.exe `dir` / `del` / `attrib` fail inside the sandbox** (they resolve every parent folder, which the
  AppContainer cannot list). Granting list on the ancestors was tried and rejected (it rewrites the DACL of the whole
  subtree of `%TEMP%`). Lead to evaluate later: a dedicated sandbox root (own `%TEMP%`-like parent, so the ancestors
  are folders we own and may adjust cheaply) instead of list access on the user's folders.
- **Packaging of `jarod-sandbox`**: found on PATH or through `JAROD_SANDBOX_BIN` (l'ancien `HERALD_SANDBOX_BIN` reste lu), documented but not distributed. The
  real end-to-end test (`shell-guard.test.ts`) skips on a machine without a build.
- Tested on one Windows build (10.0.26300); a second version is still to try.
- Network confinement is configured (no capability by default) but has no test.
- Per-attempt audit of refused writes is not possible from the kernel; the host reports what changed in the workspace
  instead (to wire into the audit journal).

## From phase 4 (plugin platform)

- Connect `PluginPlatform` to the kernel's real loader through a `PluginHost`, and sign the shipped plugins.
- Real memory / VRAM / disk measurement feeding `reportUsage`.
- Two frontends on one profile at once: locking and concurrent-write behaviour of settings, memory and skills
  (shared data directory today, untested under concurrency).

## Phase 7 - UI parity (status 2026-10-17)

No new UI code was written in this pass: `jarod-core/PARITY.md` already tracks 23 rows, 19 done and checked in a real
window (chat, settings, permissions/approval rules, applications, kanban, skills, etc.), 1 partial (voice: wake word,
continuous capture, per-sentence streaming), 3 deliberately out (core updates, embeddings/NPU, Nous device-code login).
Open items:
- Superseded: `apps/desktop/e2e` now holds 7 Playwright tests (onboarding, settings, permissions, chat); see the validation below.
- No UI yet for the new plugin platform, quarantine, sandbox or Hyper-V plugins (phases 3.3 / 4).
- `linux/tests/test_cli.py` cannot be collected on Windows (`os.getuid`); run it on Linux.

### Phase 7 validation (2026-10-17)

- **Mutation testing (manual, e2e rerun after each build, then reverted with `git checkout`)**:
  | Mutation | Result |
  |---|---|
  | onboarding button label `setup.later` « Plus tard » -> « Ignorer » (`locales/fr.ts`) | red: the onboarding test fails (6 later tests not run) |
  | settings filter `matches()` always true (`sections/shared.tsx`) | red: the filter test fails on the « Étapes par tour » count |
  | permission rule not appended on submit (`sections/JarodAgentSection.tsx`) | red: the deny-rule test fails on « Aucune règle. » |
  Limits: three mutations on three flows, not a systematic mutation run; the chat test and the wizard-does-not-return
  test were not mutated.
- **« Aucun réglage ne correspond »**: the message was in the DOM but never shown. The page shows it only when no
  `.settings-item` survives the filter, and `VoiceCommandsSection` always rendered one (its legend card, plus its own
  English « No command matches » line). Fixed: the legend renders only when a command matches and the local line is
  gone, so the global state appears. The e2e now asserts the message (red before the fix, green after).
  Still open (UX): the Voice section text is English-only, not in the locale catalogs.
- **« Travail récent »**: not sandboxed. `recentFiles` (`electron/platform/windows.ts`) runs PowerShell over the real
  `%APPDATA%\Microsoft\Windows\Recent` shortcuts and `fs.stat`s each target, so it reads the real profile, metadata
  only, from the UI process (not through `executeGuardedTool` or the read roots). It ignores `HERALD_OS_CONFIG_DIR`,
  so the e2e run shows real file names of this machine. To do: honour an isolation variable in tests, and decide if
  the list must follow the agent read roots.
- `prompt/` (master prompts) is now git-ignored; it is operator input, not product.

### Phase 7 validation, second round (2026-10-17)

- **Mutation coverage completed**:
  | Mutation | Result |
  |---|---|
  | user bubble not rendered (`hermes/Conversation.tsx`) | first run SURVIVED: the old chat assertion matched any text on screen. Assertion now targets `data-testid="user-message"`; second run red |
  | `setup.finish` no longer writes the done file (`ipc/setup.ts`) | red: the wizard-does-not-return test fails |
  | isolation flag ignored (`ipc/fs.ts`) | red: the isolation test fails |
  Six flows now mutation-checked (onboarding, filter, rule, chat, wizard return, isolation).
- **Recent work / file finder**: `JAROD_OS_ISOLATED=1` returns nothing for `fs.recent` and `fs.find` without asking the
  host platform (unit test + e2e). Without the variable the real Recent folder is still read, outside the sandbox and
  the agent read roots: unchanged for normal use, to decide with the file-roots policy.
- **MCP description pinning**: done, see `docs/INTEGRATIONS.md`. The approval screen is still to build.

## Reprise du 2026-10-17 (après le rapport final)

- **MCP : épinglage SHA-256 des descriptions** fait (`mcp/src/mcp.ts`, 7 tests + 4 contre le SDK officiel), approbation visible dans
  l'écran Plateforme. Reste : l'épingle est créée à la première connexion sans demander (activer le serveur vaut accord) ;
  durcir en montrant l'aperçu AVANT la première activation si on le veut (l'aperçu existe : `McpManager.preview`).
- **Recent / find** : `JAROD_OS_ISOLATED=1` ne lit plus le vrai profil (test unitaire + e2e). Sans la variable, comportement inchangé.
- **Mutation testing** : six flux couverts, dont chat (la première version de l'assertion survivait : corrigée) et non-retour de l'assistant.
- **6B** : moteur de recettes déterministe additif, voir `PINOKIO-PORT-EVALUATION.md` § 10. L'ADR-022 (pinokiod embarqué) n'est ni
  modifié ni retiré. **Tranché (2026-10-17)** : l'ADR-022 reste la voie par défaut, les recettes sont additives.
- **A1 branché à `run_shell` (2026-10-17)** : mécanisme `mxc` du garde du shell (`permissions/src/shell-guard.ts`), lanceur
  `jarod-core/sidecars/mxc-run/mxc_run.mjs`. Essayé APRÈS jarod-sandbox (il ne le remplace pas), absent tant que `JAROD_MXC_RUNNER`
  et `JAROD_MXC_SDK` ne sont pas réglés : sans eux le comportement et le refus d'avant sont inchangés. Tenu par le noyau :
  écriture dans le dossier de travail seulement, réseau refusé, `.ssh` `.aws` `.gnupg` `.azure` `.kube` `.docker` du dossier
  personnel interdits ; épreuve `selftest` au sondage (une écriture hors zone qui réussirait le fait écarter). Les valeurs du coffre
  ne sont pas transmises au conteneur : la demande avec `secrets` est refusée avant de lancer. MESURÉ : la commande interne `dir` de
  cmd est refusée dans le conteneur, `node` et PowerShell listent un dossier ; le conteneur reçoit un environnement par défaut, pas
  celui du processus. Non fait : activation par un réglage de l'interface, empaquetage du SDK (variables d'environnement
  seulement), mesure d'une longue commande (plafond 600 s).
- **E2 (navigateur connecté)** : posture décidée (2026-10-17) : permis, accord explicite par opération (lectures comprises) et
  journal. Moteur INSTALLÉ et ÉPINGLÉ : browser-harness 0.1.13, venv `engines/browser-harness`, dépendances à empreintes
  (`engines.lock/browser-harness-requirements.txt`, recréation dans `engines.lock/README.md`). Code du moteur LU avant installation :
  télémétrie PostHog (coupée par le pont, vérifiée par un écouteur local qui ne reçoit rien), `run.py` qui exécute du code d'agent et
  chargement de `agent_helpers.py` (le pont n'expose ni l'un ni l'autre), recherche du Chrome quotidien sans point d'entrée explicite
  (le pont exige un navigateur de bouclage lancé par Jarod avec un profil jetable `jarod-e2-*`, environnement minimal). Contrat :
  `integrations/src/impl/browser.ts` ; moteur : `browser-engine.ts` + `sidecars/browser-bridge/bh_ops.py` ; outil : `connected_browser`
  (`tools/src/connected-browser-tool.ts`), éteint par défaut, accord demandé dans l'outil à chaque opération par la porte d'approbation
  du cœur, avec la description de l'action (ni « toujours », ni « pour cette conversation », ni auto-approbation).

  **Garde réseau (2026-10-17).** Portée DÉCIDÉE : la liste blanche vaut pour TOUTE destination réseau du navigateur (documents, trames,
  sous-ressources, fetch/XHR, balises, travailleurs, chaque saut de redirection), pas pour les seules navigations ; une seule règle
  (`urlPermitted`) sert au contrôleur et à la garde. `integrations/src/impl/browser-guard.ts` : client CDP qui s'attache à chaque cible
  AVANT sa première requête (`waitForDebuggerOnStart`), active `Fetch` sur `*` et refuse (`failRequest`) ce que la règle ne permet pas,
  avant le réseau ; téléchargements refusés ; AUCUN service worker (son script est refusé, l'inscription échoue). Filet en plus : le
  navigateur passe par un proxy mort sauf pour les domaines permis (WebSocket, préconnexions, IP littérales). FAIL-CLOSED :
  `startGuardedSession` est la seule façon de démarrer E2 ; liste blanche vide, garde non démontrée (cible-canari vers un hôte interdit
  qui doit être vue puis refusée) ou injoignable = pas de session ; cible sur laquelle `Fetch` ne s'active pas = fermée et garde « non
  saine » ; garde perdue = plus aucune opération. Mesure AVANT : la redirection HTTP envoyait la requête (+1 au serveur interdit).
  Mesure APRÈS, avec un serveur TÉMOIN interdit qui compte requêtes, mises à niveau WebSocket et connexions TCP : garde CDP seule = zéro
  REQUÊTE (302, 307, chaîne, meta, img, script, css, trame, fetch, XHR, balise, SSE, travailleur, nouvelle fenêtre, formulaire) ; pile
  complète = zéro requête ET zéro connexion. MESURÉ NON COUVERT par `Fetch` : le WebSocket atteint le témoin (1) et une connexion
  nue peut précéder une navigation par meta ; le filet réseau les couvre. NON couvert du tout : WebRTC/UDP (drapeau posé, non
  démontré), résolution DNS d'un hôte permis, contenu d'un hôte permis (reste non fiable), hôte permis qui redirige vers un autre hôte
  permis (suivi). Mutations vérifiées : garde qui laisse tout passer, `Fetch` non activé, filet absent, service worker permis, garde
  perdue ignorée.

  **Réglage et hôte (2026-10-17).** Écran Réglages › Agent › Navigateur connecté (`JarodAgentSection`, entrée `connectedBrowser` du
  pont de réglages) : éteint et vide par défaut ; domaines complets seulement (ni joker, ni étiquette seule, ni IP, ni port) ; activer,
  ajouter un domaine ou lever une interdiction passe par une boîte native qui nomme les domaines, durcir ne demande rien ; aucune clé
  pour un profil, un chemin de navigateur ou un moteur. `prepareConnectedBrowser` (`connected-browser-host.ts`) : seul point d'entrée
  d'un hôte, ne branche l'outil que si le réglage est activé avec un domaine ET que le moteur est installé ; le navigateur jetable ne
  démarre qu'à la première action APPROUVÉE ; chaque opération relit le réglage (éteint = session fermée, autre jeu de domaines =
  nouvelle session et nouvelle garde). Tests : 25 unitaires (règle, hôte), 9 de l'outil par `executeGuardedTool`, 29 contre le moteur
  réel, 8 du pont de réglages, tests de l'interface.

  NON fait : l'appel de `prepareConnectedBrowser` par le démarrage de l'application (rien ne l'appelle : l'outil n'existe pas) ; essai
  sur une vraie session connectée de l'utilisateur (volontairement jamais ouverte, nécessite une autorisation distincte) ; ouverture du
  navigateur jetable visible (il est sans interface par défaut).
- **Phase 5** : 16 adaptateurs en contrat testés contre leur moteur réel (voir `INTEGRATIONS.md`, `engines.lock/README.md`).
  Non branchés : aucun n'est câblé à run_shell, au rag, à la voix. A1 (MXC) mesuré : `ui.disable: true` empêche node de démarrer ;
  node exige `--preserve-symlinks --preserve-symlinks-main` sous ProcessContainer.
- **Écran Plateforme** (plugins de la plateforme, quarantaine, bacs à sable, Hyper-V, outils MCP à approuver) : canaux
  `platform-status` et `mcp-approve-tool`, 2 tests e2e du shell construit. Lecture seule sauf l'approbation d'un outil. Pas encore
  d'actions (créer un bac à sable, promouvoir une pièce) depuis l'écran : à ouvrir seulement avec un accord par action.
- **Piège de construction** : l'e2e lit le bundle `jarod-core/dist/gateway` (ignoré par git). Après toute modification du cœur,
  `pnpm --dir jarod-core run bundle:gateway`, sinon l'écran voit un ancien moteur (c'est ce qui a montré « État inconnu »).
- **Piège de dépôt** : la règle `engines/` du `.gitignore` cachait `test/engines/` ; elle est devenue `/engines/`. Un contrôle
  `git status` après avoir écrit des tests dans un dossier au nom courant évite de les croire commités.
- **Limites** : voix testée en synthèse (anglais) ; Presidio anglais seulement ; B1 sans preuve depuis l'installation empaquetée ;
  Docling complet télécharge ses modèles au premier usage (réseau) ; D1/D2 n'ont qu'une fenêtre fabriquée pour cible.

## Renommage JAROD-OS / jarod-sandbox (vérifié 2026-10-17)

- **Fait** : le confinement des écritures s'appelle `jarod-sandbox` (binaire Rust de la crate `host-sandbox`, identifiant du mécanisme du
  garde du shell, variable `JAROD_SANDBOX_BIN`, documentation, tests). L'ancienne variable `HERALD_SANDBOX_BIN` est encore LUE quand la
  nouvelle n'est pas réglée (la nouvelle l'emporte), pour ne casser aucune installation. Les variables et les données propres à Jarod
  (`JAROD_*`, `%LOCALAPPDATA%\Jarod-OS`, `@jarod/*`) portaient déjà le nom.
- **Laissé tel quel, volontairement** : les identifiants du shell d'interface dérivé de Herald OS (MIT, `licenses/HERALD-OS.md`) :
  `apps/desktop`, paquets `@herald-os/*`, variables `HERALD_OS_*`, tubes `pipe://herald-os-*`, binaires `herald-host-spike` et
  `herald-supervise`, identifiant d'application, partitions `persist:herald-*`. Les renommer change des contrats entre processus et des données
  d'installations existantes (la migration de l'ADR-016 les traite déjà dans l'autre sens) ; c'est un chantier à part, à décider, pas un
  renommage de surface. Environ 3 000 occurrences dans 500 fichiers, dont l'attribution de licence à conserver. **Plan préparé** (phases,
  contrats à migrer, repli, décisions de l'humain) : `docs/RENAME-PLAN-JAROD-OS.md`. Rien n'y est lancé.
