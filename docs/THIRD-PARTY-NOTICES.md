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
| F1 | ranxianglei/billion-context | MIT (+ clause d'attribution) | permissive | copyright et texte MIT ; CLAUSE ADDITIONNELLE : Jarod-OS utilise billion-context — https://github.com/ranxianglei/billion-context (proxy local, branché au transport par Réglages › Contexte, 2026-10-20) |
| F2 | mksglu/context-mode | Elastic-2.0 | unknown | texte ELv2 ; usage personnel, jamais offert en service |
| F3 | heygen-com/hyperframes | Apache-2.0 | permissive | NOTICE Apache-2.0 |
| F4 | NationalSecurityAgency/ghidra | Apache-2.0 | permissive | NOTICE Apache-2.0 ; composants tiers de Ghidra listés dans sa distribution |
| F5 | cathrynlavery/diagram-design | MIT | permissive | copyright et texte MIT |
| F6 | mattpocock/skills | MIT | permissive | copyright et texte MIT |
| F7 | boykopovar/AnyPS5 | GPL-2.0-only | copyleft | texte GPL-2.0 ; détecté seulement, rien n'est embarqué |
| F8 | storytold/artcraft | MIT OR Apache-2.0 | unknown | double licence au choix ; application séparée, rien n'est embarqué |
| F9 | morluto/rea | MIT | permissive | copyright et texte MIT |
| F10 | usestrix/strix | Apache-2.0 | permissive | NOTICE Apache-2.0 ; détecté seulement |
| G1 | anchore/syft | Apache-2.0 | permissive | NOTICE Apache-2.0 ; outil de développement, jamais embarqué |
| G2 | open-telemetry/opentelemetry-js | Apache-2.0 | permissive | NOTICE Apache-2.0 ; @opentelemetry/api, sdk-trace-base, core, resources, semantic-conventions groupés dans la passerelle (licenses/G2.md) |
| G3 | ethz-spylab/agentdojo | MIT | permissive | copyright et texte MIT ; banc de test, jamais embarqué |
| G4 | restic/restic | BSD-2-Clause | permissive | **embarqué** dans le paquet Windows (`resources\restic\restic.exe`, 0.19.1) avec son texte BSD-2 (`resources\restic\LICENSE.txt`, copie de `jarod-core/licenses/G4-restic-LICENSE.txt`, tag v0.19.1) |
| G5 | yt-dlp/yt-dlp | Unlicense | unknown | évalué ; domaine public (Unlicense) |
| G6 | mostlygeek/llama-swap | MIT | permissive | évalué |
| G7 | CursorTouch/Windows-MCP | MIT | permissive | évalué |
| G8 | reladraw/reladraw | Apache-2.0 | permissive | évalué |
| G9 | modelcontextprotocol/inspector | MIT (transition vers Apache-2.0 ; SPDX NOASSERTION) | unknown | outil de développement, jamais embarqué ; contributions MIT et Apache-2.0 mêlées |
| G10 | smol-machines/smolvm | Apache-2.0 | permissive | intégré (lot C, 2026-10-21 ; `engines/smolvm`, non embarqué dans le paquet) |
| G11 | bytedance/UI-TARS-desktop | Apache-2.0 | permissive | différé ; licence du modèle de vision à relever séparément |
| G12 | Louis-CFM/coucou | MIT (code) ; nom, Mochi et sons © Louis Raillé | unknown | différé ; seuls les concepts et le code MIT sont réutilisables |
| G13 | osquery/osquery | Apache-2.0 OR GPL-2.0-only | copyleft | évalué ; double licence au choix (Apache-2.0 retenue s'il est embarqué) |
| G14 | LaurieWired/GhidraMCP | Apache-2.0 | permissive | évalué ; bethington/ghidra-mcp (Apache-2.0) écarté |
| G15 | sandboxie-plus/Sandboxie | GPL-3.0 (informationnel : usage personnel) | copyleft | bloqué (pilote et élévation) ; application séparée, rien n'est embarqué |
| G16 | alibaba/open-code-review | Apache-2.0 | permissive | NOTICE Apache-2.0 ; moteur hors paquet (engines/) |
| G17 | trycua/cua | MIT | permissive | différé |

Autres composants cités par la mission : Darwinian Evolver (AGPL, utilisable y compris en runtime) : dépôt et
licence à relever lors de son éventuel embarquement, puis à ajouter ici.
