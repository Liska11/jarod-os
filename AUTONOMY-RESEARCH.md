# Recherche : harness autonome / auto-amélioration (2026-10-17)

Méthode : recherche web ciblée, puis lecture directe de la source quand c'était possible. **Niveau de preuve indiqué pour chaque référence** : « lu » = page primaire lue ; « résumé » = connu seulement par un résumé de moteur de recherche ou un article secondaire (non vérifié à la source). Rien ici n'a été installé ni exécuté depuis ces dépôts.

## Références

| Référence | Niveau | Ce qu'elle apporte | Transposable à Jarod-OS ? |
|---|---|---|---|
| Anthropic, [Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) (nov. 2025) | **lu** | Agent « initialiseur » puis agent « codeur » qui avance d'**une fonctionnalité par session** ; fichier de progression + commit git propre en fin de session ; **liste de fonctionnalités JSON** dont l'agent ne peut changer que le drapeau `passes` (supprimer ou éditer un test est « inacceptable ») ; routine de démarrage (lire git log + progression + liste, lancer, **test de fumée avant tout travail neuf**) ; une fonctionnalité n'est « passée » qu'après un test de bout en bout. Échecs nommés : tout faire d'un coup puis manquer de contexte ; un agent suivant déclare le projet fini ; fonctionnalités cochées sans test réel. | **Oui** : c'est déjà `HANDOFF.md` + `docs/BACKLOG.md` ; on ajoute un backlog **lisible par machine** (`autonomy/backlog.json`) et une règle « un lot = un sujet = un commit ». |
| Anthropic, conception à trois agents planificateur / générateur / évaluateur (couverture secondaire : [InfoQ](https://infoq.com/news/2026/04/anthropic-three-agent-harness-ai/)) | **résumé** (post primaire non lu ; la date varie selon les sources) | Un évaluateur **séparé** du générateur, car un agent surnote son propre travail ; remises à zéro du contexte avec artefacts de passation structurés plutôt que compaction seule. | **En partie** : l'évaluateur est ici un fichier de vérifications **figé pendant le lot** (voir plus bas), pas un second modèle. Un évaluateur-LLM n'est pas ajouté (coût, et rien ne le justifie encore). |
| Sakana / ICLR 2026, [Darwin Gödel Machine](https://arxiv.org/pdf/2505.22954), code `jennyzzt/dgm` | **résumé** (abstract et page du projet vus dans les extraits) | L'agent modifie son propre code et **valide chaque changement par benchmark** (pas par preuve) ; garde une **archive** de toutes les variantes ; choix du parent par performance + nouveauté. | **Non, sauf l'idée de fond** : « un changement n'est accepté que mesuré ». L'archive évolutive et l'auto-modification du code de l'agent sont hors périmètre (surface d'attaque, aucun gain direct pour finir le produit). |
| Karpathy, `autoresearch` (guides secondaires : [The New Stack](https://thenewstack.io/karpathy-autonomous-experiment-loop/)) | **résumé** (dépôt non lu ; la commande exacte de retour arrière n'est pas confirmée) | Boucle **modifier → committer → exécuter → mesurer → garder ou annuler** ; code d'évaluation en **lecture seule** pour que l'agent ne puisse pas changer la mesure ; budget fixe par essai. | **Oui, l'invariant clé** : l'évaluateur ne doit pas être modifiable par le lot qu'il juge. Repris par l'empreinte SHA-256 de `autonomy/checks.json`. La partie « committer automatiquement » est **refusée** (consigne : rien ne se commite tout seul au titre de l'auto-amélioration). |
| TDAD, [arXiv 2603.17973](https://arxiv.org/abs/2603.17973) (Alonso et al., mars 2026) | **abstract lu** (le corps du PDF n'a pas pu être extrait) | Outil qui relie le code aux **tests concernés avant le commit** pour que l'agent sache quoi vérifier ; régressions 6,08 % → 1,82 % sur SWE-bench Verified (modèles locaux 30B/35B). Constat utile : des consignes TDD **sans contexte de tests ciblés** ont *aggravé* les régressions (9,94 %). | **Idée retenue** : lancer les tests *ciblés* d'un lot, pas une consigne générique. **Correction** : un premier résumé de recherche attribuait à ce papier une boucle externe avec garde-fou d'évaluateur, revert après 5 échecs, etc. **Je n'ai trouvé cela nulle part dans l'abstract** ; je ne le cite donc pas comme provenant de ce papier. |
| `MaximeRobeyns/self_improving_coding_agent` | **résumé** (extrait seulement) | Agent qui évalue ses performances sur benchmarks, archive, et améliore son propre code. | **Non** : même raison que DGM. |

## Ce qui est retenu (réduit à un changement concret, local, réversible)

1. **Backlog lisible par machine** : `autonomy/backlog.json` (statuts `todo` / `blocked-owner` / `too-large` / `done`). Retrait : supprimer le fichier.
2. **Porte de lot** : `node scripts/autonomy/lot.mjs start|check <lot>|status` (`scripts/autonomy/`).
   - `start` : exécute les vérifications de `autonomy/checks.json` (typecheck, tests Electron, tests Rust, tests de la porte elle-même) = **état de base**, enregistre le HEAD et l'empreinte de l'évaluateur.
   - `check` : relance ; **ACCEPT** seulement si plus rien n'échoue ; sinon **REJECT** avec la liste des échecs, des régressions (vert avant, rouge maintenant) et la **commande d'annulation à lancer soi-même**.
   - **Abandon propre** : après 3 échecs sur le même lot, statut `abandoned`, trace écrite (échecs + fin de sortie des vérifications) dans `autonomy/journal.jsonl`, et le lot ne redémarre pas en silence.
   - **Évaluateur figé** : si `checks.json` change pendant un lot, le lot est **refusé** (un lot ne peut pas se faire passer en modifiant sa propre mesure).
   - **Ne fait jamais** : commit, push, reset, suppression. Aucune dépendance, rien ne l'importe, rien ne la lance seule.
   - Score = part de vérifications vertes : **indicatif** ; le verdict repose sur « aucun échec », pas sur le score.
3. **Journal de décisions structuré** : `AUTONOMY-DECISIONS.md` (humain) + `autonomy/journal.jsonl` (machine, une ligne par événement de lot).

## Annuler cette partie

Supprimer `scripts/autonomy/`, `autonomy/`, `AUTONOMY-RESEARCH.md` et la ligne `autonomy/lots.json` de `.gitignore` (ou `git revert` du commit « feat(autonomy) »). Rien d'autre dans le produit ne dépend de ces fichiers.

## Idées séduisantes écartées (trop larges ou risquées)

- **Auto-modification du code de l'agent + archive de variantes (DGM)** : surface d'attaque et aucun gain direct pour finir le produit.
- **Évaluateur-LLM / trois agents** : coût et indépendance non prouvés ; les vérifications déterministes suffisent ici.
- **Commit automatique par lot (autoresearch)** : contraire à la consigne.
- **Sélection de tests par graphe d'impact (TDAD)** : utile, mais exige un outil externe et une analyse de code ; non adopté. La porte accepte déjà des vérifications ciblées par lot en éditant `checks.json` *avant* de démarrer le lot.

## Risques d'intégration

- Les vérifications par défaut coûtent plusieurs minutes (Rust + tests Electron) : à lancer par lot, pas par modification.
- Un état de base déjà rouge n'est pas masqué : `ACCEPT` exige tout vert ; un lot ne peut donc pas être accepté sur un dépôt déjà cassé (voulu).
- Les tests de la porte reposent sur un exécuteur factice : le chemin « vraies commandes » n'a été vérifié qu'à la main (voir journal).
