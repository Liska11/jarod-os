# Notices des composants tiers

Politique de licences (révisée le 2026-10-17) : JAROD-OS est une application strictement personnelle, jamais
redistribuée ni offerte en service réseau à des tiers. Les licences copyleft (AGPL-3.0, SSPL…) ne bloquent donc
pas l'intégration. Le registre `jarod-core/packages/plugins/integrations/src/adapters.ts` est **informationnel** :
il trace la provenance et la licence vérifiée, il ne rejette rien sur ce critère.

Les NOTICE et attributions d'origine sont conservées ici. Si l'application était un jour redistribuée ou offerte
en service réseau, les lignes « copyleft » ci-dessous deviendraient des obligations à revoir avant toute diffusion.

Licences lues sur les dépôts le 2026-10-17. Aucun code tiers n'est encore embarqué pour les lignes dont le statut
n'est pas `integrated` (voir `docs/INTEGRATIONS.md`) ; la ligne existe pour la traçabilité.

| Id | Dépôt | Licence | Classe | Attribution à conserver à l'embarquement |
|---|---|---|---|---|
| A1 | microsoft/mxc | MIT | permissive | copyright et texte MIT |
| A2 | sigstore/cosign | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| A3 | microsoft/RAMPART | MIT | permissive | copyright et texte MIT |
| A4 | StackOneHQ/defender | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| A5 | promptfoo/promptfoo | MIT | permissive | copyright et texte MIT |
| B1 | huggingface/transformers.js | Apache-2.0 | permissive | NOTICE Apache-2.0 ; licence des poids de modèle à part |
| B2 | asg017/sqlite-vec | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| B3 | docling-project/docling | MIT | permissive | texte MIT ; licences des modèles optionnels à part |
| B4 | panva/oauth4webapi | MIT | permissive | copyright et texte MIT |
| B5 | microsoft/markitdown | MIT | permissive | texte MIT ; extensions OCR via PyMuPDF (AGPL-3.0, copyleft) : NOTICE de PyMuPDF à conserver |
| C1 | snakers4/silero-vad | MIT | permissive | copyright et texte MIT |
| C2 | k2-fsa/sherpa-onnx | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| C3 | data-privacy-stack/presidio | MIT | permissive | copyright et texte MIT |
| D1 | FlaUI/FlaUI | MIT | permissive | copyright et texte MIT |
| D2 | pywinauto/pywinauto | BSD-3-Clause | permissive | copyright et clauses BSD-3 |
| D3 | microsoft/winget-cli | MIT | permissive | copyright et texte MIT |
| R1 | modelcontextprotocol/typescript-sdk | MIT → Apache-2.0 (transition) | permissive | relire la LICENSE au moment de l'embarquement |
| R2 | microsoft/playwright | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| R3 | open-telemetry/opentelemetry-js | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| R4 | temporalio/temporal | MIT | permissive | concepts seulement ; aucun code repris |
| E1 | pinokiocomputer/pinokio | MIT | permissive | copyright et texte MIT ; dépôt pinokiod : licence à vérifier (phase 6A) |
| E2 | browser-use/browser-harness | MIT | permissive | copyright et texte MIT |
| X1 | linshenkx/prompt-optimizer | AGPL-3.0-only | copyleft | texte AGPL-3.0 et avis de copyright d'origine |
| X2 | harness/harness | Apache-2.0 | permissive | rejeté pour absence de cas d'usage, pas pour sa licence |
| F1 | ranxianglei/billion-context | MIT | permissive | copyright et texte MIT ; détecté seulement (cockpit, 2026-10-20) |
| F2 | mksglu/context-mode | Elastic-2.0 | unknown | texte ELv2 ; usage personnel, jamais offert en service |
| F3 | heygen-com/hyperframes | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| F4 | NationalSecurityAgency/ghidra | Apache-2.0 | permissive | NOTICE Apache-2.0 ; composants tiers de Ghidra listés dans sa distribution |
| F5 | cathrynlavery/diagram-design | MIT | permissive | copyright et texte MIT |
| F6 | mattpocock/skills | MIT | permissive | copyright et texte MIT |
| F7 | boykopovar/AnyPS5 | GPL-2.0-only | copyleft | texte GPL-2.0 ; détecté seulement, rien n'est embarqué |
| F8 | storytold/artcraft | MIT OR Apache-2.0 | unknown | double licence au choix ; application séparée, rien n'est embarqué |
| F9 | morluto/rea | MIT | permissive | copyright et texte MIT |
| F10 | usestrix/strix | Apache-2.0 | permissive | NOTICE Apache-2.0 ; détecté seulement |

Autres composants cités par la mission : Darwinian Evolver (AGPL, utilisable y compris en runtime) : dépôt et
licence à relever lors de son éventuel embarquement, puis à ajouter ici.
