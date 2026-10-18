# Backlog (trajectoire Jarod-OS)

Items identified and deliberately not done. Each survives the session here.

## From the master prompt

- **Vulnerability audit: done (2026-10-17).** `apps/desktop` (npm): the 12 findings were ALL in dev/build tooling (`npm audit --omit=dev`: 0, before and after).
  Fixed: `concurrently` 10.0.5 → 10.0.6 (pulls `shell-quote` 1.12.0: the 2 critical), and `http-cache-semantics` 4.3.0 and `source-map-js` 1.2.2 (the 2 high), lock
  only. `jarod-core` (pnpm): 11 findings, all dev (`pnpm audit --prod`: 0) — 3 critical + 3 high from an old `vitest` (^2) in `plugins/automation` (now
  5.0.2 like the rest of the repo, which brings `tinypool`, `vite`, `@vitest/mocker`), 1 high in the test client `@modelcontextprotocol/client` (2.1.0 → 2.2.0), and
  `source-map-js` 1.2.2 by a workspace override; `pnpm audit`: 0. Gates after: `npm run test:core` exit 0, desktop typecheck, 1128 unit tests, 19/19 e2e on the rebuilt app.
  **Left, deliberately:** (1) 8 moderate in the `electron-builder` chain (`sprintf-js` DoS through `roarr` ← `global-agent` ← `@electron/get`): build-time download tooling, never in the
  installed app; `npm audit` proposes `electron-builder@26.5.0`, which is a DOWNGRADE from the 26.15.3 in use, so it is not applied. (2) 10 high in the `promptfoo` test engine
  (`engines.lock/node/promptfoo`, A5 adversarial scenarios): a pinned test-only tool, same kind of "fix" (an older major), not shipped. (3) **Rust and Python audited (same day).**
  `cargo audit` 0.22.2 on `host-rust/Cargo.lock` (132 crates, 1334 advisories): nothing found. `pip-audit` (`--no-deps --disable-pip`, exact pins) on every lock/requirements file:
  `browser-harness`, `docling`, `docling-full`, `B19`: clean. `py312-requirements.txt` (Presidio, markitdown, pywinauto, sherpa): `cryptography` 48.0.1, 3 advisories (X.509 name-constraint
  bypass and chain-building blow-up fixed in 49.0.0, PKCS#7 decryption oracle fixed in 50.0.0). NOT applied: `presidio-anonymizer` 2.2.364 (the latest) requires `cryptography<49`, so the fix cannot be
  installed without breaking its declared constraint (measured with `uv pip check`: the engine tests still pass on 50.0.0, 90/90, but the combination is unsupported, so it was rolled back). Not
  reachable: the only users of `cryptography` in that venv are `presidio_anonymizer/operators/aes_cipher.py` (AES), `pdfminer/pdfdocument.py` (PDF AES decryption), `requests` and `urllib3` (optional
  pyOpenSSL); nothing calls the X.509 verifier or `pkcs7_decrypt_*`. To revisit when Presidio lifts its bound. `licenses/B20-requirements.txt` (docling-slim 2.131.0, 3 advisories) and
  `licenses/B21-requirements.txt` (transformers 5.5.4, 2 advisories) are the HISTORICAL approval records of 2026-09-29, not what is installed: the current locks pin docling-slim 2.140.0 and
  transformers 5.20.1 and are clean. The spaCy model (`en-core-web-sm`, a URL requirement) cannot be audited by version.
- 543 lint warnings (accepted debt).
- **18 shell protocol tests skipped on Windows: DONE (2026-10-18).** The fake shells of `test_os_ui.py` and
  `test_control_protocol_r2.py` now also serve a real named pipe (`tests/fake_pipe.py`, plain ctypes), the shell's Windows door;
  the bridge suite runs 445/445 with 0 skipped. Checked by breaking the client's pipe exchange: 17 failures + 9 errors.
  Note: `scripts/test-bridge.ps1` fails here before any test when pytest cannot reach `%TEMP%\pytest-of-<user>\pytest-current`
  (access denied, machine-side); `--basetemp=<folder>` works around it.
- **E2 WebRTC/UDP proof: control at zero on this machine (2026-10-18).** `browser.lifecycle.engine.test.ts › PREUVE RÉSEAU WebRTC/UDP`
  fails every time (it was the "intermittent" `integrations` failure): Chrome's WebRTC UDP never reaches a local witness, while QUIC does.
  Not a leak, not a timeout; machine-side cause not found (see `docs/E2-VALIDATION.md` §6.1). Re-run on another machine.
- **E2 engine daemon started but not yet registered (seen once, 2026-10-18).** A session closed while `browser_harness.daemon`
  was still starting left the daemon running: its pid file was not written yet, and its command line does not carry the profile, so
  neither `close()` nor the sweep can find it. Lead: give the daemon the profile path on its command line (then `killProfileProcesses`
  covers it), or wait for the pid file before closing.
- **`jarod-e2e-*` folders in `%TEMP%`: leak FIXED (2026-10-18), stock left.** This repository's Playwright launcher
  (`apps/desktop/e2e/launch.ts`) now removes its roots robustly and a global teardown fails any run that leaves one (`2f16af8`).
  Stock found: 43 folders (392 MB) from this repository, created since 2026-10-17; 833 folders (131 MB) named by the ORIGINAL Jarod
  project's own e2e harness (`packages/desktop/test/e2e`, prefixes `jarod-e2e-coding`, `-worktrees`, `-mobile`, `-hermesone`,
  `-<pid>-<ts>-hang/stray/upd-local-rel`…, profile at the root), which this repository never creates. One-time cleanup DONE the same
  day at the owner's request: 876 folders (523 MB) removed after checking no process used them, 0 failure, 0 left; `jarod-e2-*`
  and `jarod-e2app-*` (other harnesses) not touched. The original project's harness may create new ones when it runs again.
- **Rotation of `control-audit.jsonl`: DONE (2026-10-17).** `FileJournal` rotates to `<name>.1` (one older generation, replaced each time) once the file reaches 8 MiB (`DEFAULT_JOURNAL_LIMIT`), also at opening; a failed rotation is counted in `failures()` and never changes a decision. Tests: `host-control/tests/journal_rotation.rs`.
- The Python client is more tolerant than the shell on pipe endpoints (the Rust host emits the strict form).
- R2/R3 end-to-end in the real application to re-prove (disposable profile).

## From phase 3.1 / 3.2 (sandbox)

- **`readRoots` in the shell policy: DONE (2026-10-17).** `ShellPolicy.readRoots` (absolute folders), plumbed to `jarod-sandbox exec --read-root`
  (read + execute, never write, appended to the command's PATH), validated by the guard on the REAL path on every command and refused as a
  whole (never silently dropped) when a root is a drive root, the home folder or one of its ancestors, or a key folder (`.ssh` `.aws`
  `.gnupg` `.azure` `.kube` `.docker`, or anything containing/inside one); settings screen (Agent › Shell guard), adding a root is a
  weakening with a native confirmation. MEASURED with the real binary: without it `node` is "not recognised"; with a user-owned folder
  holding `node.exe` it runs (`v24.20.0`) and still cannot write outside the workspace or inside that folder. **Limit measured:** the
  system install folder (`C:\Program Files\nodejs`) does NOT work even with the grant (`Accès refusé`): only folders that belong to the
  user (scoop, cargo, a per-user Python…) are usable; the other mechanisms (bwrap, firejail, MXC, Docker) are unaffected (they already read the
  system, or do not take the option). The sandbox now explains a refused DACL change (Win32 5 / 1314: folder not owned by the account, copy the tool into a folder you own) instead of a bare error number (`acl::hint`, unit-tested); a path that cannot even be opened still reports the OS error.
- **cmd.exe `dir` / `del` / `attrib` fail inside the sandbox** (they resolve every parent folder, which the
  AppContainer cannot list). Granting list on the ancestors was tried and rejected (it rewrites the DACL of the whole
  subtree of `%TEMP%`). Lead to evaluate later: a dedicated sandbox root (own `%TEMP%`-like parent, so the ancestors
  are folders we own and may adjust cheaply) instead of list access on the user's folders.
- **Packaging of `jarod-sandbox`**: found on PATH or through `JAROD_SANDBOX_BIN` (l'ancien `HERALD_SANDBOX_BIN` reste lu), documented but not distributed. The
  real end-to-end test (`shell-guard.test.ts`) skips on a machine without a build.
- Tested on one Windows build (10.0.26300); a second version is still to try.
- Network confinement: **tested (2026-10-17)**, on demand (`JAROD_NET_PROBE=1`, one TCP handshake to 1.1.1.1:443, no data sent; `agent/test/sandbox-network.test.ts`).
  Outside the container the connection succeeds; inside, the kernel refuses it (`EACCES`, not a timeout); with `--network` it succeeds. A loopback
  witness cannot be used: measured, an AppContainer does not reach 127.0.0.1 even with the network capability (ETIMEDOUT both ways).
- Per-attempt audit of refused writes is not possible from the kernel; the host reports what changed in the workspace
  instead (to wire into the audit journal).

## From phase 4 (plugin platform)

- Connect `PluginPlatform` to the kernel's real loader through a `PluginHost`, and sign the shipped plugins.
- Real memory / VRAM / disk measurement feeding `reportUsage`.
- Two frontends on one profile at once: **covered** (`BEGIN IMMEDIATE` + `busy_timeout`, `jarod-core/tests/integration/sqlite-contention.test.ts`, 2026-10-18).

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

  **Branchement à l'application (2026-10-17).** `cli/src/gateway/main.ts` appelle `startConnectedBrowser` au démarrage de la passerelle
  (cycle de vie : `integrations/src/impl/connected-browser-lifecycle.ts`) : rien n'est branché et aucun navigateur ne démarre tant que le
  réglage n'est pas activé avec un domaine ET que le moteur n'est pas trouvé (`JAROD_E2_ENGINE_ROOT`). Changement de réglage = rebranchement à
  chaud et révocation immédiate de la session ; garde perdue = session arrêtée ; balayage des sessions abandonnées au démarrage (marqueur de
  propriété). Navigateur dédié seulement. Preuves exactes, réserves comprises : `docs/E2-VALIDATION.md` (e2e de l'application construite : 9
  essais ; révocation en cours d'opération ; confinement et confidentialité du point d'accès CDP ; nettoyage ; preuve réseau WebRTC/UDP).

  **Voie Firefox par extension (2026-10-17)**, pour lire dans un navigateur déjà ouvert sans l'ouvrir au débogage : plan, manifeste et canal
  dans `docs/E2-FIREFOX-READER-PLAN.md` ; extension `jarod-core/sidecars/firefox-reader/`, courtier `integrations/src/impl/firefox-reader.ts`
  (désactivé, non branché). Essayée sur Firefox ESR 153.5.0 de test (`engines/firefox-test`, geckodriver 0.37.1, empreintes dans
  `engines.lock/README.md`) avec onglets leurres : geste, accord, refus, domaine interdit, navigation/rechargement/fermeture pendant l'attente,
  lecture de l'élément exact, formulaires refusés, document principal seulement, autres onglets intacts, déconnexion propre. Mesuré : Firefox
  met `ws://` à niveau en `wss://` même vers le bouclage, d'où un canal HTTP en interrogation longue. Cette voie ne filtre pas le trafic de
  Firefox. NON fait : installation dans le Firefox de l'utilisateur (extension signée ou chargement temporaire, à décider avec lui), cible
  exacte à confirmer, branchement à l'application et affichage dans l'interface, messagerie native (alternative plus forte, non installée).

  NON fait : essai sur une vraie session connectée de l'utilisateur (volontairement jamais ouvert, nécessite une autorisation distincte) ;
  livraison du moteur et du Chromium dans l'installeur ; preuve réseau hors de la machine et du trafic du système (le confinement n'est PAS
  déclaré exhaustif, voir les réserves de `docs/E2-VALIDATION.md`).
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
