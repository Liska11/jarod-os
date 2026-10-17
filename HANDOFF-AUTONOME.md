# Handoff — session autonome du 2026-10-17

Branche `feature/windows-port`. **Rien n'est poussé, signé ni publié.** Chaque arbitrage est détaillé dans `AUTONOMY-DECISIONS.md` (une section par décision, avec la façon d'annuler). La recherche sur les harness autonomes est dans `AUTONOMY-RESEARCH.md`.

## Commits locaux (ordre chronologique, depuis `a676994`)

| # | Commit | Sujet | Journal |
|---|---|---|---|
| 1 | `4dd4f57` | Journal de contrôle de l'hôte Rust borné (rotation 8 Mo → `.1`) | §0 |
| 2 | `f678897` | Message explicite quand un dossier d'outils n'appartient pas au compte (Win32 5/1314) | §0 |
| 3 | `ec6758c` | Test instable `plugin-embeddings` : attendre un fait, pas 300 ms (D-04) + création du journal | §1 |
| 4 | `80e8807` | `herald-os.log` borné (5 Mo, une génération) | §2 |
| 5 | `f9bad38` | Journal de contrôle côté shell borné (même règle) | §3 |
| 6 | `8637556` | Recherche, backlog lisible par machine, porte de lot locale | §4 |
| 7 | `efa88f3` | Clés de réglage inconnues : écartées mais **nommées** (D-09) | §5 |
| 8 | `98ce3ae` | Embeddings non embarqués : message clair (D-03, partie « expérience ») | §6 |
| 9 | `3c6c3bc` | Vision : délai de 120 s par description + 7 tests (D-05) | §7 |
| 10 | `a05f5c0` | Slack et Discord : délai de 60 s par appel d'API | §8 |
| 11 | `14ec3e7` | Échange de jetons OAuth : délai de 30 s | §9 |
| 12 | `8eddda1` | `taskkill` du worker d'analyse : délai de 15 s | §10 |

Un seul sujet par commit ; chaque commit se défait par `git revert <sha>`.

## Vérifications exécutées à la fin (HEAD `8eddda1`)

- **Porte de lot** (`node scripts/autonomy/lot.mjs`) sur HEAD : typecheck desktop, 705 tests Electron, `cargo test --workspace`, 5 tests de la porte → **ACCEPT 1.00**.
- `npm run test:core` : **exit 0** à la seconde exécution. **La première a échoué dans le paquet `integrations`** (sous charge, pendant que d'autres paquets tournaient) ; ce paquet passe seul (262/262) et à la relance. Je n'ai pas identifié le test intermittent (probablement un des moteurs navigateur réels, déjà vu intermittent sous charge) : **non résolu**.
- Suite jarod-core complète (`npx vitest run` à la racine de `jarod-core`) : les gates `tests/gates/p0..p3` échouent **avec et sans** mes changements (dépendants de la machine : base réelle, NPU) — non touchés.

## Ce qui n'a PAS été vérifié

- Aucun essai dans l'application installée ni lancée (embeddings, vision, Slack, Discord n'ont pas été exercés contre de vrais services : aucun compte ni clé utilisés).
- Le `taskkill` borné (§10) : changement d'option d'une ligne, non reproductible sur demande.
- La porte de lot a été exercée pour de vrai (2 lots + 1 vérification de HEAD) mais ses tests unitaires utilisent un exécuteur factice ; les tests et le code de la porte ont été écrits ensemble (pas de rouge préalable).

## Sujets volontairement non traités

| Id | Sujet | Pourquoi |
|---|---|---|
| B1b | Embarquer réellement embeddings/reranker (OpenVINO + modèle) dans l'installateur | Chantier d'installateur, non vérifiable sans réinstaller |
| B3 | `cmd.exe dir/del/attrib` dans le conteneur : racine de bac à sable dédiée | Conception à part, risque sur les droits des dossiers de l'utilisateur |
| B4 | Métriques / traces locales (OPP-14) | Large ; la rotation (risque disque) est faite |
| B5 | `plugin-workflows` (D-06) | L'audit le décrit comme « workflows durables » mais le code (`plugins.ts`) est un gestionnaire de plugins Hermes ; description à vérifier avant d'écrire des tests |
| — | `electron-builder` (8 modérés), `promptfoo` (10 hauts), `cryptography` (borne Presidio) | Voir `docs/BACKLOG.md` |
| — | `verify.ts` (script manuel), `mobile-page.ts` (code côté navigateur) : fetch sans délai | Hors chemin d'exécution du noyau |

## Blocages qui exigent votre retour

1. **Signer l'extension Firefox** avec votre compte Mozilla (`docs/E2-FIREFOX-READER-PLAN.md` §8), lancer `--verify`, installer ; confirmer la permission `storage`, la cible exacte (onglet/domaine/élément) et le domaine autorisé. *Bloqué par décision propriétaire.*
2. **Pousser** les commits locaux. *Bloqué par décision propriétaire.*
3. **Renommage global JAROD-OS** (plan prêt : `docs/RENAME-PLAN-JAROD-OS.md`). *Bloqué par décision propriétaire.*
4. Décider si la **porte de lot** (`scripts/autonomy/`, `autonomy/`) reste : elle est locale, inerte tant qu'on ne la lance pas, et se retire en supprimant ces dossiers (voir `AUTONOMY-RESEARCH.md`).
5. Savoir si 120 s / 60 s / 30 s / 15 s conviennent comme délais par défaut (§7–§10) ; tous sont réglables ou facilement modifiables.

## Reprise

```bash
git log --oneline a676994..HEAD      # les 12 commits ci-dessus
node scripts/autonomy/lot.mjs status # backlog lisible par machine
```
