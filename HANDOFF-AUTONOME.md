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

## Mise à jour du 2026-10-18 — décisions reçues, push préparé (non exécuté)

- Délais et porte de lot : conservés. Renommage global : séparé, non lancé.
- **Push prêt, pas lancé.** L'arbre est en avance de **30** commits sur `origin/feature/windows-port` (les 13 ci-dessus + 17 de la session précédente), avance simple, 104 fichiers. Balayage des lignes ajoutées : aucune forme de clé ou de jeton ; aucun binaire. Le push ne dépend pas de la signature Firefox (extension non câblée ni distribuée). Commande : `git push origin feature/windows-port`.
- Restent à vous : signature Firefox (peut suivre), puis le renommage dans son propre lot.

## Mise à jour du 2026-10-18 (suite) — après l'essai Firefox

Commits ajoutés : `846fee9` (chargement temporaire sans signature), `76ff0c2` (essai guidé sur page neutre + son test de moteur réel), `1a65aea` (résultat du premier essai réel), `5c6e846` (traductions d'un lot de composants, backlog périmé fermé).

- **Premier essai réel dans votre Firefox : réussi** (2e tentative) — voir `docs/E2-FIREFOX-READER-PLAN.md` §9.1. Reste non essayé là : refus d'accord, domaine interdit, navigation pendant l'attente, onglets leurres (couverts dans le Firefox de test).
- **Traductions** : 73 → 59 chaînes anglaises. `CommandSurface` et le composant de classe `error-boundary` laissés.
- **Plus de sujet autonome utile restant** : ce qui reste est soit à votre décision (signature, push, renommage), soit trop large (embarquer les embeddings, `cmd` dans le conteneur, métriques), soit non vérifiable sans application installée.
- L'arbre est en avance de 36 commits sur `origin/feature/windows-port` (`git rev-list --count origin/feature/windows-port..HEAD`). Rien n'est poussé.


## Mise à jour du 2026-10-18 (analyse et corrections)

Commits : `16c22a9` (`useT` rend un `t` stable entre deux rendus, avec son test : les `useMemo`/`useEffect` qui dépendent de `t` ne se recalculent plus à chaque rendu), `992ffee` (`jarod-core/.work/` ignoré : les sorties des gates et des bancs peuvent contenir du texte de documents), puis ce lot (test UDP et documentation).

- **L'échec « intermittent » de `npm run test:core` est identifié.** C'est `browser.lifecycle.engine.test.ts › PREUVE RÉSEAU WebRTC/UDP`, qui échoue maintenant **à chaque fois** sur cette machine : le contrôle (sans durcissement) ne voit plus aucun datagramme WebRTC. Ce n'est pas une fuite et ce n'est pas un délai ; la cause est sur la machine (diagnostic : `docs/E2-VALIDATION.md` §6.1). Le test échoue désormais avec un message qui y renvoie. **Non résolu** : à refaire sur une autre machine, ou ici une fois la cause trouvée.
- **Profils jetables orphelins (défaut corrigé).** À la fermeture et au balayage, un `rmSync` récursif pouvait effacer le marqueur `owner.json` puis buter sur un fichier encore verrouillé par Chrome : le dossier restait SANS marqueur, donc plus rien n'avait le droit de le nettoyer (14 dossiers `jarod-e2-*` d'environ 20 Mo trouvés dans `%TEMP%`, supprimés après vérification qu'aucun processus ne les utilisait). `removeDisposableProfile` efface maintenant le marqueur en dernier ; test `test/browser-profile-removal.test.ts`. Après une suite complète : 0 dossier restant. C'était aussi la cause de l'échec intermittent du test « balayage au démarrage » sous charge.
- `pnpm-lock.yaml` parasite à la racine (ne contenait que biome ; la racine est gérée par npm) : supprimé.
- Lint : 616 avertissements (543 notés avant). Ceux qui pouvaient cacher un bug ont été relus (`${price}` dans les traductions : voulu ; `default` au milieu d'un `switch` : légal) ; le reste est de la dette de style.

## Mise à jour du 2026-10-18 (suite, pendant votre recherche réseau)

- **Traductions** : 59 → 23 chaînes anglaises (les 23 restantes sont des URL d'exemple, des identifiants et des noms de produit). Les textes qui disaient « Hermes » utilisent le nom choisi pour l'assistant. `2def20d`.
- **Avatar** : l'image de l'assistant est remplacée par `Pictures\Jarod_OS.jpg` partout où `HermesAvatar` est utilisé (Dock, barre de commandes, conversations…). `ecb4535`. Les **noms** « Hermes » écrits en dur (titre du Dock, barre de menus…) relèvent du renommage global, non lancé.
- **Navigateur jetable qui survivait à sa fermeture (défaut corrigé).** Chrome peut continuer sous un autre numéro de processus que celui noté au lancement : `close()` et le balayage n'arrêtaient pas le vrai navigateur, qui gardait son profil verrouillé et le recréait après effacement. Trois navigateurs orphelins trouvés. Les processus sont maintenant arrêtés **par le profil** (`killProfileProcesses`, ligne de commande contenant CE dossier), avec un test. Après trois passages complets du paquet `integrations` : 0 processus, 0 profil restant.
- **Tests qui ne testaient pas ce qu'ils disaient.** Des chemins Windows écrits avec un seul antislash (`"\serveur\partage"` valait `\serveurpartage`, `"C:\a:flux"` valait `C:a:flux`) : le refus des chemins UNC et des flux alternatifs n'était pas réellement vérifié. Corrigé (7 fichiers) ; la protection fonctionnait.
- **Courses entre fichiers d'essai** (dossiers et démons comptés sur toute la machine) : les essais ne comptent plus que ce qui appartient à leur propre session.
- Lint : corrections sûres appliquées (échappements inutiles, `const`), 616 → 595 avertissements.
- Restent : la preuve WebRTC/UDP (côté machine), et deux points notés au backlog (démon du moteur pas encore enregistré, ~880 dossiers `jarod-e2e-*` laissés par les e2e).
