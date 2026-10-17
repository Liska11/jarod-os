# Intégrations externes (phase 5)

Source de vérité exécutable : `jarod-core/packages/plugins/integrations/src/adapters.ts` (`REGISTRY`), contrôlé au
démarrage du plugin (`assertAdapters`) et par les tests. Licences lues sur les dépôts le 2026-10-17.

**Politique de licences révisée (2026-10-17, Prompt_maitre-2)** : application strictement personnelle, jamais
redistribuée ni offerte en service réseau. Le registre est INFORMATIONNEL (provenance, licence, classe
permissive/copyleft/inconnue) et ne rejette plus rien sur ce critère ; les attributions sont dans
`docs/THIRD-PARTY-NOTICES.md`.


| Id | Dépôt | Licence | Statut | Version épinglée ; note |
|---|---|---|---|---|
| A1 | microsoft/mxc | MIT | adapter-ready | `@microsoft/mxc-sdk@1.0.1` ; confinement des scripts générés et des outils MCP non approuvés ; vérifier l'exigence de version de Node avant embarquement ; TESTÉ contre MXC réel (ProcessContainer) : écriture hors zone, lecture d'un dossier interdit, réseau et délai tenus ; mesuré : ui.disable=true empêche node de démarrer, et node doit être lancé avec --preserve-symlinks. BRANCHÉ à run_shell (2026-10-17) comme mécanisme `mxc` du garde du shell, essayé après jarod-sandbox, actif seulement si JAROD_MXC_RUNNER et JAROD_MXC_SDK sont réglés (lanceur sidecars/mxc-run) ; testé par l'outil run_shell : écriture dans la zone, hors zone refusée avec témoin, secrets du coffre non transmis donc refusés ; mesuré : la commande interne dir de cmd est refusée, node et PowerShell listent |
| A2 | sigstore/cosign | Apache-2.0 | integrated | `cle-publique-committee` ; intégré en 0a (clé publique committée) ; chaîne CI à vérifier seulement si les secrets existent (réservé à l'humain) |
| A3 | microsoft/RAMPART | MIT | adapter-ready | `scenarios-internes-v1` ; les 7 scénarios obligatoires tournent contre la porte unique avec un faux modèle (agent/test/adversarial.test.ts) ; le dépôt lui-même n'est pas embarqué |
| A4 | StackOneHQ/defender | Apache-2.0 | adapter-ready | `observateur-base-v1` ; observateur d'injections en mode OBSERVATION (aucun blocage) avec détecteur de base et harnais de mesure des faux positifs ; le paquet n'est pas encore branché |
| A5 | promptfoo/promptfoo | MIT | adapter-ready | `promptfoo@0.124.1` ; suite d'évaluation comportementale ; campagnes dans la sandbox dédiée seulement ; TESTÉ : la configuration exportée est exécutée par promptfoo réel (fournisseur echo, hors ligne) |
| B1 | huggingface/transformers.js | Apache-2.0 | adapter-ready | `@huggingface/transformers@4.3.1 + Xenova/all-MiniLM-L6-v2@751bff3` ; embeddings dans le paquet installé ; exige l'accord avant téléchargement du modèle, poids épinglés, test depuis l'installation empaquetée ; TESTÉ avec le moteur réel : poids épinglés SHA-256, altération d'un octet refusée, aucun téléchargement sans accord, vecteurs sémantiques 384 dimensions. Reste : preuve depuis l'installation empaquetée |
| B2 | asg017/sqlite-vec | Apache-2.0 | adapter-ready | `sqlite-vec@0.1.9` ; PoC de compatibilité avec better-sqlite3-multiple-ciphers obligatoire ; repli MemoryVectorIndex ; TESTÉ : PoC d'ABI réel dans better-sqlite3-multiple-ciphers 13.0.3, base en clair ET chiffrée |
| B3 | docling-project/docling | MIT | adapter-ready | `docling-slim@2.140.0 (profil sans PyTorch)` ; sidecar Python derrière le seam documentParser ; licences des modèles optionnels à auditer séparément ; TESTÉ avec Docling réel (docx, pptx, xlsx, html, pdf natif) ; le CLI docling exige la pile complète, un script de conversion natif le remplace ; profil sans modèle : PDF sans titres ni tableaux ; profil COMPLET (PyTorch) testé aussi : titre et tableau d'un PDF reconnus |
| B4 | panva/oauth4webapi | MIT | adapter-ready | `oauth4webapi@3.8.8` ; McpOAuthManager : jetons dans le coffre uniquement ; TESTÉ contre oauth4webapi réel (défi PKCE identique, validation de redirection) et un serveur de jetons HTTP local |
| B5 | microsoft/markitdown | MIT | adapter-ready | `markitdown@0.1.8 + pymupdf@1.28.2` ; parsing ; extensions OCR autorisées (PyMuPDF, AGPL, informationnel) ; à brancher dans le sidecar Python ; TESTÉ avec markitdown réel (HTML, PDF avec --use-plugins) ; sortie nettoyée des caractères invisibles |
| C1 | snakers4/silero-vad | MIT | adapter-ready | `silero-vad@v5.1.2 (silero_vad.onnx sha256 2623a295…)` ; VAD entre capture et Whisper ; TESTÉ avec le modèle ONNX réel sur de la parole synthétisée : segment dans la bonne zone, silence et bruit blanc ignorés |
| C2 | k2-fsa/sherpa-onnx | Apache-2.0 | adapter-ready | `sherpa-onnx@1.13.8 + zipformer-en-20M-2023-02-17` ; processus natif séparé, protocole local, aucun audio vers le cloud par défaut ; TESTÉ avec le modèle réel hors ligne (parole synthétisée) ; le moteur ne rend pas de confiance ; moteur distant refusé par défaut |
| C3 | data-privacy-stack/presidio | MIT | adapter-ready | `presidio-analyzer@2.2.364 + en_core_web_sm@3.8.0` ; détection de PII avant tout envoi cloud ; couche supplémentaire, jamais une garantie absolue ; TESTÉ contre Presidio réel : ce que la couche locale masque est reconnu par Presidio ; l'union masque aussi noms et lieux ; Presidio est anglais seulement dans ce profil |
| D1 | FlaUI/FlaUI | MIT | adapter-ready | `FlaUI.UIA3@5.0.0 (sidecar .NET)` ; sidecar .NET limité à 7 opérations sémantiques ; jamais d'exécution arbitraire ; TESTÉ sur une fenêtre WinForms fabriquée : saisie, clic, lecture, champ protégé jamais rempli |
| D2 | pywinauto/pywinauto | BSD-3-Clause | adapter-ready | `pywinauto@0.6.9` ; alternative UIA si FlaUI est insuffisant, mêmes contraintes ; TESTÉ sur la même fenêtre fabriquée ; politique de gouvernance commune (processus permis/interdits, accord par action, débit) |
| D3 | microsoft/winget-cli | MIT | adapter-ready | `winget@v1.29.380 (version de la machine)` ; identifiants exacts seulement ; jamais une ligne construite par un modèle ; TESTÉ avec winget réel en lecture seule (show, search, list) ; aucune installation lancée par les tests |
| R1 | modelcontextprotocol/typescript-sdk | MIT | adapter-ready | `@modelcontextprotocol/sdk@1.32.1` ; LICENSE en transition MIT → Apache-2.0 (contributions mixtes) : les deux sont permissives, à ré-examiner à l'embarquement ; dépendance directe du noyau ; TESTÉ contre un serveur construit avec le SDK officiel : aperçu avant activation, épinglage, rug-pull retenu, désactivation après 3 échecs. Le SDK n'est qu'une dépendance de test |
| R2 | microsoft/playwright | Apache-2.0 | integrated | `@playwright/test (devDependency de apps/desktop)` ; tests E2E ; jamais le profil Chrome personnel ; TESTÉ : 8 tests e2e sur le shell construit, profil jetable ; mutation-testés |
| R3 | open-telemetry/opentelemetry-js | Apache-2.0 | adapter-ready | `epurateur-v1` ; épurateur d'attributs (liste blanche : identifiants, durées, tailles, statuts, catégories d'erreur) ; le SDK n'est pas encore branché |
| R4 | temporalio/temporal | MIT | adapter-ready | `concepts-temporal-v1 (durable.ts)` ; concepts seulement (activités idempotentes, historique rejouable) → version SQLite minimale à écrire ; pas de serveur Temporal ; TESTÉ sur SQLite réel : reprise depuis une AUTRE connexion sans rejouer les activités terminées, plafond d'échecs, masquage |
| E1 | pinokiocomputer/pinokio | MIT | adapter-ready | `pinokio@8.2.0-comportement-observe` ; phase 6B : moteur de recettes déterministe (recipes/), importeur de scripts JSON simples ; réécriture du comportement observé, aucune ligne de pinokiod reprise. Coexiste avec le moteur embarqué de l'ADR-022, sans le remplacer ni le modifier |
| E2 | browser-use/browser-harness | MIT | planned | POSTURE décidée par l'humain (2026-10-17) : le navigateur connecté est permis, avec un accord explicite PAR OPÉRATION (lectures comprises) et un journal (opération, hôte, résultat — jamais l'adresse complète, le contenu ni le texte saisi). Contrat et politique testés avec un moteur simulé (liste blanche obligatoire, liste noire prioritaire, jamais de champ de mot de passe, aucune opération cookies/stockage/profil). Statut « prévu » tant que le moteur browser-harness n'est ni installé, ni épinglé, ni testé (contrat dans impl/browser.ts) : aucun branchement à un outil ni à l'interface |
| X1 | linshenkx/prompt-optimizer | AGPL-3.0-only | planned | AGPL-3.0 (LICENSE vérifiée) : intégrable si pertinent depuis la révision de la politique (usage strictement personnel) ; NOTICE à conserver |
| X2 | harness/harness | Apache-2.0 | rejected | verdict déjà rendu : aucun cas d'usage |

## Ce qui est réellement fait

Chaque adaptateur est un CONTRAT (politique d'échec fermé, refus par défaut) dans `integrations/src/impl/`, et la plupart sont
testés contre leur moteur RÉEL (`integrations/test/engines/*.engine.test.ts`, 49 tests) : voir `jarod-core/engines.lock/README.md`
pour recréer les moteurs. Les documents, fenêtres, voix et phrases des tests sont fabriqués ; aucun profil réel n'est touché.

- **Tenu contre le moteur réel** : A1 (MXC ProcessContainer : écriture hors zone, dossier interdit, réseau, délai), A5 (promptfoo),
  B1 (transformers.js + MiniLM épinglé), B2 (sqlite-vec dans la base chiffrée), B3 (Docling sans PyTorch), B4 (oauth4webapi),
  B5 (markitdown + OCR), C1 (silero-vad), C2 (sherpa-onnx), C3 (Presidio), D1 (FlaUI), D2 (pywinauto), D3 (winget, lecture
  seule), R1 (SDK MCP officiel), R2 (Playwright, 8 tests e2e du shell), R4 (SQLite réel, reprise sur une autre connexion).
- **A3, A4, R3** : comme avant (scénarios adversariaux, observateur en observation, épurateur d'attributs).
- **E1** : moteur de recettes déterministe (voir `PINOKIO-PORT-EVALUATION.md` § 10).

## Ce qui n'est PAS fait, et pourquoi

- **Branchement** : seul A1 est câblé, à `run_shell` (mécanisme `mxc` du garde du shell, après jarod-sandbox, actif seulement si
  JAROD_MXC_RUNNER et JAROD_MXC_SDK sont réglés ; il ne remplace pas la sandbox 3.1/3.2). Les autres ne sont câblés ni au plugin
  rag, ni à la voix, ni à l'interface : ils sont prêts et testés, les brancher est un travail par intégration.
- **E2** : posture décidée (navigateur connecté permis, accord par opération, journal) ; contrat testé avec un moteur simulé, moteur
  non installé, aucun branchement (voir BACKLOG). X1 (prompt-optimizer) : AGPL intégrable, aucun cas d'usage écrit.
- **B1** : la preuve depuis l'installation empaquetée reste à faire. **C1/C2** : testés en anglais synthétique, pas sur une voix
  humaine. **C3** : Presidio est anglais seulement dans ce profil. **B3** : PDF sans titres ni tableaux (profil sans PyTorch).
- **D1/D2** : approbation de chaque action par l'utilisateur obligatoire ; aucun outil n'est encore exposé au modèle.

## Découverte de sécurité (corrigée le 2026-10-17)

Le client MCP prenait la description d'un outil telle quelle à chaque connexion (rug-pull possible). Correctif dans
`mcp/src/mcp.ts` : `fingerprintTool` (SHA-256 de nom + description + schéma, clés triées) est épinglé à la première
connexion (`SqlPinStore`, table `mcp_tool_pins`). À la reconnexion, un outil dont l'empreinte diffère, ou un outil
nouveau, n'est PAS enregistré (échec fermé) ; il apparaît dans `McpServerStatus.pending` jusqu'à `McpManager.approve`.
Chaque événement (épinglé, changé, nouveau, approuvé) entre dans le journal d'audit existant avec des empreintes
seulement, jamais le texte de la description. Tests : `mcp/test/pins.test.ts` (7).
Reste à faire : l'écran d'approbation (bridge + interface) ; aujourd'hui `approve` n'est appelable que par le code.
