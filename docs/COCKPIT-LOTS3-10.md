# Cockpit — lots 3 à 10 (Windows) : bilan, matrice, installation, diagnostic, retour arrière, reprise

Date : 2026-10-20. Ce document fait suite à [COCKPIT-LOT1.md](COCKPIT-LOT1.md) et [COCKPIT-LOT2.md](COCKPIT-LOT2.md).

## Ce que chaque lot a ajouté

| Lot | Ajout | Où |
|---|---|---|
| 3 — context-mode | Sorties d'outils de plus de 8 000 caractères gardées hors du contexte, entières, dans la base. Le modèle reçoit un aperçu, une référence `out:<id>`, la provenance (outil, SHA-256) et les outils `output_search` (extraits exacts avec n° de ligne) et `output_read` (lignes de l'original). Économies comptées. Effacées avec la conversation. | `agent/src/outputs.ts`, migration `tool_outputs` |
| 3 — context-mode (dépôt) | Préremplissage d'un serveur MCP `npx -y context-mode@1.0.169` (version du commit audité). Rien n'est ajouté tant que vous n'enregistrez pas. | Réglages › Serveurs MCP |
| 3 — skills | Six skills de mattpocock/skills embarquées au commit `5beb35b` : diagnostic, TDD, revue, conception, spécification, passation. Chacune porte une note d'adaptation Jarod. On les installe à la demande, hors ligne, par le hub (`bundled:mattpocock/<id>`) ; l'analyse de sécurité et le verrou de provenance s'appliquent. | `skills/src/bundled/`, `scripts/import-bundled-skills.mjs` |
| 4 — billion-context | Réglage `contextProxy`, éteint par défaut. Le transport des fournisseurs nommés passe par `http://127.0.0.1:<port>/bili/<adresse>`. Bouclage seulement, pas d'interception TLS. Confirmation native à l'activation. La compaction de Jarod se retire pour ces fournisseurs : une seule autorité. La santé est lue sur `/__bili/health`. | `llm/src/providers.ts`, Réglages › Contexte |
| 5 — diagrammes | Skill diagram-design embarquée au commit `4762027` (SKILL.md, références, gabarits). Magasin d'artefacts : chaque fichier est référencé avec son empreinte, et son état (intact, modifié, disparu) est visible. Outils `artifact_register`, `artifact_list` et `diagram_export` (SVG, avec preuve). Aperçu dans un cadre sans script. | `agent/src/artifacts.ts`, Réglages › Artefacts |
| 7 — HyperFrames | `video_render` lance un rendu local `hyperframes render` comme une tâche : accord, annulation, délai de 30 min. La preuve vient de ffprobe (durée, dimensions, codec). Le résultat devient un artefact « video ». Jamais de rendu cloud. Télémétrie coupée. | `agent/src/video.ts` |
| 8 — ArtCraft | Application externe : Jarod l'ouvre avec `system_open` (accord, preuve d'ouverture) et ne la pilote pas. La génération est distante, et le registre le dit. | catalogue du cockpit |
| 6 — REA, Ghidra | **Analyse statique** de fichiers que vous êtes autorisé à analyser. `rea_static` (analyze, decompile, compare… — liste blanche strictement statique, jamais capture/debug/attach d'un processus vivant) et `ghidra_analyze` (import headless : importe et auto-analyse, sans exécuter). Chemins confinés au dossier de travail, accord, annulation, délai ; le résultat devient un artefact « analysis » ; invariant vérifié : la cible n'est jamais exécutée ni modifiée (empreinte relue après coup). | `agent/src/static-analysis.ts` |
| 9 — AnyPS5 | **Détection seule, expérimentale, comme au lot 1.** | — |
| 10 | Ce document, les tests et les vues. | — |

## Matrice finale (statut strict)

| Intégration | Statut |
|---|---|
| context-mode (natif : sorties hors contexte) | **Intégré et testé réellement** : vraie base, vraie boucle d'agent, `read_file` sur un gros journal. |
| context-mode (serveur MCP du dépôt) | **Implémenté mais non vérifié** : préremplissage seulement ; le paquet npm n'a pas été lancé ici. |
| mattpocock/skills | **Intégré et testé réellement** : installation hors ligne par le hub, analyse et verrou. |
| billion-context | **Intégré, testé avec simulation** : réécriture du transport, réglage, confirmation et santé sont testés avec un proxy simulé. Le proxy `bili` n'est pas installé sur cette machine. |
| diagram-design | **Intégré et testé réellement** pour la skill embarquée, l'export SVG et les artefacts. La génération d'un diagramme par le modèle n'a pas été exécutée. |
| HyperFrames | **Intégré, testé avec simulation** : la commande `hyperframes` n'est pas sur le PATH de cette machine ; aucun rendu réel. |
| ArtCraft | **Intégré au niveau « application externe »**. ArtCraft n'est pas installé ici. |
| REA (analyse statique) | **Intégré et testé réellement** : `rea_static` unit-testé (argv exacts, liste blanche, invariant « cible inchangée », annulation) ET smoke réel sur cette machine — `rea analyze` sur un PE de 843 Ko a rendu `format: pe, architecture: x86_64`, exit 0, empreinte de la cible inchangée. Le fournisseur Ghidra de REA est « healthy » (rea doctor). |
| Ghidra (import headless) | **Intégré, testé avec simulation** : `ghidra_analyze` unit-testé (argv `-import`/`-deleteProject`, aucun script, refus sans JDK 21) ; `analyzeHeadless` répond sur cette machine (12.1.4 + Java 21). Une analyse headless complète n'a pas été lancée dans cette session (REA couvre déjà la décompilation via son fournisseur Ghidra). |
| AnyPS5 | **Détection seule, expérimentale.** |
| Strix | **Détection seule.** |

## Lot 6 — analyse statique : ce que c'est, ce que ce n'est pas

- **Ce que c'est** : REA et Ghidra lisent un fichier (exécutable, bundle, etc.) **que vous êtes autorisé à analyser** et en rendent une analyse — format, architecture, décompilation, comparaison de versions. Le fichier doit être **dans le dossier de travail** de la conversation.
- **Ce que ce n'est pas** : ni un scanner de réseau, ni un testeur d'équipement en direct. Aucune des neuf intégrations ne pilote le réseau. « Tester mon réseau local » relèverait d'une capacité différente, non fournie ici.
- **Garanties, tenues par le code** :
  - la cible **n'est jamais exécutée** (Ghidra l'importe ; REA la lit) ;
  - REA n'accepte qu'une **liste blanche de sous-commandes statiques** ; tout ce qui capture, débogue ou s'attache à un processus vivant est refusé ;
  - son **empreinte est relue après coup** : si elle a changé, l'analyse est déclarée en échec ;
  - chemins **confinés au dossier de travail**, accord demandé à chaque fois, annulation et délai, résultat enregistré comme artefact « analysis ».
- **Usage** : demandez par exemple « analyse statique de ce .exe » (place le fichier dans le dossier de travail d'abord). Outils : `rea_static` (action `analyze`, `decompile`, `compare`…) et `ghidra_analyze`.

## Installation (Windows)

- **Skills** : demandez à l'agent « installe la skill embarquée tdd », ou appelez `skill_hub_install` avec `bundled:mattpocock/tdd`. Pour les diagrammes : `bundled:diagram-design/diagram-design`.
- **HyperFrames** : `npm i -g hyperframes@0.8.177`, plus FFmpeg et ffprobe (par exemple `scoop install ffmpeg`).
- **billion-context** :
  1. `npm i -g billion-context@0.1.202` ;
  2. lancez `bili` avec `ACP_AUTO_UPDATE=0` et `BILI_ADVISORY_CHECK=0` ;
  3. dans Réglages › Contexte, allumez le proxy et nommez les fournisseurs.
- **context-mode** : Réglages › Serveurs MCP › context-mode › Préremplir, puis Enregistrer.

## Diagnostic

| Où regarder | Ce qu'on y voit |
|---|---|
| Réglages › Capacités | État mesuré de chaque intégration, ce qui manque, la provenance. Le bouton ⟳ refait la mesure. |
| Réglages › Tâches | Chaque action avec sa preuve, ou la raison pour laquelle on ne peut pas la constater. |
| Réglages › Contexte | Économies de contexte, santé du proxy. |
| Réglages › Artefacts | État des fichiers produits. |

## Retour arrière

- Toutes les migrations ajoutées (`tool_outputs`, `tool_output_chunks`, `artifacts`) sont **additives**. Une base migrée reste lisible par la version précédente, qui ignore ces tables.
- Une sauvegarde de la base est faite automatiquement avant toute migration (`*.vN-avant-vM.*.bak`).
- `contextProxy` éteint rend le transport direct.
- Une skill installée se désinstalle par le hub (elle est archivée, donc récupérable).

## Reprise

- **Fait** : lots 1 à 5, 7, 8 et 10.
- **Reste** :
  - lot 9 (AnyPS5) au-delà de la détection ;
  - Ghidra : un script headless d'export (liste des fonctions, décompilation) en plus de l'import/auto-analyse ;
  - progression ligne à ligne d'un rendu dans l'écran Tâches (aujourd'hui : statut et annulation) ;
  - export PNG des diagrammes ;
  - essais réels de bili et de hyperframes une fois installés.
