# Intégrations externes (phase 5)

Source de vérité exécutable : `jarod-core/packages/plugins/integrations/src/adapters.ts` (`REGISTRY`), contrôlé au
démarrage du plugin (`assertAdapters`) et par les tests. Licences lues sur les dépôts le 2026-10-17.

**Politique de licences révisée (2026-10-17, Prompt_maitre-2)** : application strictement personnelle, jamais
redistribuée ni offerte en service réseau. Le registre est INFORMATIONNEL (provenance, licence, classe
permissive/copyleft/inconnue) et ne rejette plus rien sur ce critère ; les attributions sont dans
`docs/THIRD-PARTY-NOTICES.md`.


| Id | Dépôt | Licence | Statut | Note |
|---|---|---|---|---|
| A1 | microsoft/mxc | MIT | planned | confinement des scripts générés et des outils MCP non approuvés ; vérifier l'exigence de version de Node |
| A2 | sigstore/cosign | Apache-2.0 | integrated | intégré en 0a (clé publique committée) ; chaîne CI complète vérifiable seulement si les secrets de CI existent (réservé à l'humain) |
| A3 | microsoft/RAMPART | MIT | adapter-ready | 7 scénarios obligatoires contre la porte unique, faux modèle (`agent/test/adversarial.test.ts`) ; le dépôt n'est pas embarqué |
| A4 | StackOneHQ/defender | Apache-2.0 | adapter-ready | observateur d'injections en mode observation + mesure des faux positifs ; le paquet n'est pas branché |
| A5 | promptfoo/promptfoo | MIT | planned | évaluation comportementale, campagnes dans la sandbox dédiée seulement |
| B1 | huggingface/transformers.js | Apache-2.0 | planned | embeddings dans le paquet installé ; accord avant téléchargement, poids épinglés |
| B2 | asg017/sqlite-vec | Apache-2.0 | planned | PoC d'ABI avec better-sqlite3-multiple-ciphers obligatoire ; repli MemoryVectorIndex |
| B3 | docling-project/docling | MIT | planned | sidecar Python derrière documentParser ; licences des modèles optionnels à auditer |
| B4 | panva/oauth4webapi | MIT | planned | McpOAuthManager, jetons dans le coffre uniquement |
| B5 | microsoft/markitdown | MIT | planned | parsing ; extensions OCR autorisées (PyMuPDF, AGPL, informationnel) |
| C1 | snakers4/silero-vad | MIT | planned | VAD entre capture et Whisper |
| C2 | k2-fsa/sherpa-onnx | Apache-2.0 | planned | processus natif séparé, aucun audio vers le cloud par défaut |
| C3 | data-privacy-stack/presidio | MIT | planned | PII avant envoi cloud ; couche supplémentaire, pas une garantie |
| D1 | FlaUI/FlaUI | MIT | planned | sidecar .NET, 7 opérations sémantiques, jamais d'exécution arbitraire |
| D2 | pywinauto/pywinauto | BSD-3-Clause | planned | alternative UIA, mêmes contraintes |
| D3 | microsoft/winget-cli | MIT | planned | identifiants exacts seulement, jamais une ligne construite par un modèle |
| R1 | modelcontextprotocol/typescript-sdk | MIT → Apache-2.0 (transition) | planned | LICENSE mixte en transition, les deux permissives ; à ré-examiner à l'embarquement |
| R2 | microsoft/playwright | Apache-2.0 | reference-only | tests E2E ; jamais le profil Chrome personnel |
| R3 | open-telemetry/opentelemetry-js | Apache-2.0 | adapter-ready | épurateur d'attributs (liste blanche) ; SDK non branché |
| R4 | temporalio/temporal | MIT | reference-only | concepts seulement → version SQLite minimale à écrire |
| E1 | pinokiocomputer/pinokio | MIT | planned | phase 6A : audit écrit, puis arrêt |
| E2 | browser-use/browser-harness | MIT | planned | question de posture pour l'humain avant tout branchement |
| X1 | linshenkx/prompt-optimizer | AGPL-3.0-only | planned | AGPL, intégrable si pertinent (politique révisée) ; NOTICE conservée |
| X2 | harness/harness | Apache-2.0 | rejected | verdict déjà rendu |

## Ce qui est réellement fait

- **A3** : les 7 scénarios adversariaux tournent contre la porte unique, sans profil réel. 6 passent ; le 3e (un
  serveur MCP change la description d'un outil) est une **découverte** (ci-dessous).
- **A4** : le texte passe inchangé en observation, seules des catégories sont journalisées ; `enforce` est refusé
  sans taux de faux positifs mesuré sous 2 %. Corpus : 10 bénins, 6 malveillants, 0 faux positif, 100 % de détection.
  C'est un petit corpus, pas une preuve de robustesse.
- **R3** : épurateur d'attributs de trace à liste blanche (nom ET forme de valeur) ; le SDK OpenTelemetry n'est pas branché.

## Ce qui n'est PAS fait, et pourquoi

A1, A5, B1 à B5, C1 à C3, D1 à D3, R1, R2 (tests E2E), R4, E1, E2 : adaptateur non écrit.

- installations et téléchargements hors périmètre automatique (modèles ONNX, runtimes natifs, sidecars Python ou
  .NET, toolchains) : B1, B3, B5, C1, C2, C3, D1, D2 ;
- preuve exigée depuis l'installation empaquetée (B1) ou PoC d'ABI natif (B2) ;
- gouvernance d'abord pour la vague D (pouvoir fort), et décision humaine pour E2 (navigateur connecté) ;
- dépendance directe du noyau à choisir (R1), OAuth qui a besoin du coffre côté TypeScript (B4).

## Découverte de sécurité (non corrigée, hors périmètre)

Le client MCP relit `tools/list` à chaque connexion et prend la description telle quelle (`mcp/src/mcp.ts`,
`[MCP nom] …`). Aucune empreinte de la description au moment de l'accord n'est conservée : une description modifiée
ensuite ne redemande rien. À traiter avec R1 (outils et permissions affichés avant activation, serveur défaillant
désactivé).
