# Backlog de correction — audit du 2026-10-19

Aucun de ces points n'a été appliqué : ce document est le plan proposé, à valider avant toute modification du code applicatif. Priorités : **P0** perte de données / compromission / blocage majeur, **P1** sécurité ou fonction importante, **P2** fiabilité / UX / maintenabilité, **P3** non bloquant.

État de départ : `4c9883c`, arbre propre, 1268 tests verts, 1 échec machine-dépendant, 45 e2e verts.

## Lot A — Sécurité (à faire avant d'ajouter une surface)

| Id | Priorité | Constat | Action | Effort | Dépend de | Critère d'acceptation |
|---|---|---|---|---|---|---|
| BL-01 | ~~P1~~ **FAIT** (2026-10-21) | X-01 : aucun contrôle d'émetteur central sur 183 canaux IPC | Introduire un wrapper `handle(channel, fn, { surfaces })` dans `electron/ipc/`, migrer par domaine (fs, terminal, capture, backup, web) ; refuser avec un journal si `event.senderFrame` n'est pas une frame du shell ; garder les contrôles locaux existants | 2–4 j | aucune | Un canal privilégié appelé depuis une frame non autorisée est refusé et journalisé ; tests unitaires par domaine ; e2e inchangés |
| | | **Clôture (2026-10-21)** : le garde central existait déjà — `electron/ipc/sender-guard.ts`, commit `1555fc2` du 2026-10-18 (« A-06 »), la veille de l'audit — il enveloppe `ipcMain.handle/handleOnce/on/once` et refuse toute frame qui n'est pas la page du shell (sous-frame, page étrangère, frame disparue), avec journal sans charge utile. Ajouté : preuve observable (`ipcGuardReport`) et test de bout en bout `e2e/ipc-sender-guard.spec.ts` dans l'application réelle — **171 gestionnaires et 7 écouteurs, tous passés par le garde, aucun enregistré avant lui** (seuls `error` et un écouteur interne d'Electron, nommés). La liste blanche PAR SURFACE (`{ surfaces }`) ne change rien sous Windows : la fenêtre principale est la seule à charger la page du shell avec son preload (panneaux : mode Linux ; panneau d'emojis : macOS ; mini-fenêtre et fenêtres web : leur propre page, sans canal du shell). | — | — | Fait : refus testé par domaine (12 tests unitaires) ; e2e de couverture vert |
| BL-02 | P2 | X-07 : témoin UDP machine-dépendant | Sortir le témoin de la suite (script séparé `test:network-witness`) ou `skip` conditionnel avec rapport explicite « non concluant » | 0,5–1 j | aucune | `npm run test:core` vert sur une machine sans UDP ; le témoin reste exécutable et rapporte son verdict |
| BL-03 | **P1** | X-02 : valeurs `pl:` (base64) dans la base | Chiffrer la valeur elle-même avec `os_crypt` (DPAPI) au lieu de la seule base ; migration des lignes `pl:` ; ne jamais écrire de clair | 1–2 j | BL-01 (canaux du coffre) | Un `SELECT` brut sur la base ne contient aucun octet de valeur ; tests de migration |
| BL-12 | P2 | Cohérence des canaux du coffre | Revoir les canaux `vault.*` avec le wrapper de BL-01 et un test « aucun retour de valeur » | 0,5 j | BL-01 | Test : aucune API ne renvoie une valeur (seulement noms/domaines) |

## Lot B — Réseau et confinement

| Id | Priorité | Constat | Action | Effort | Critère d'acceptation |
|---|---|---|---|---|---|
| BL-04 | P2 | X-03 : `isolation: "workspace"` refusée sous Windows (mécanisme absent) | Livrer `jarod-sandbox` (AppContainer) avec `selftest` au bootstrap, documenter comme prérequis ; garder le refus explicite tant qu'il n'est pas prouvé | 3–5 j | Une commande écrivant hors workspace est refusée sous Windows ; `selftest` vert |
| BL-07 | P2 | X-04 : `dgram` du noyau non gardé | Hook `dgram.createSocket`/`send` avec la même politique ; limite documentée si impossible | 1–2 j | Envoi UDP hors ligne → refus `JAROD_OFFLINE` |
| BL-08 | P3 | X-12 : backend Hermes hors garde noyau | Afficher dans l'UI que l'interrupteur est partiel en backend Hermes ; documenter | 1 j | Mention visible dans Réglages › Réseau |

## Lot C — Qualité et outillage

| Id | Priorité | Constat | Action | Effort | Critère d'acceptation |
|---|---|---|---|---|---|
| BL-05 | P3 | X-05 : 2 avertissements `INEFFECTIVE_DYNAMIC_IMPORT` | Rendre les imports cohérents (statique **ou** dynamique) pour `ApplicationsOverlay` et `CommandSurface` | 0,5 j | `npm run build` sans avertissement ; tailles de chunks comparées |
| BL-06 | P3 | X-06 : 606 avertissements de lint | Trier par règle ; corriger d'abord `noControlCharactersInRegex` et `noNonNullAssertion` là où ils masquent un défaut ; seuil ratchet en CI | 2–3 j | Avertissements restants explicitement acceptés ; aucun masquage de défaut |
| BL-09 | P3 | X-08 : e2e sensibles à `ELECTRON_RUN_AS_NODE=1` | Garde dans `e2e/launch.ts` : si la variable est présente, la retirer de l'environnement enfant (ou échouer tôt avec un message clair) ; note QA | 0,5 j | e2e verts dans un shell qui exporte la variable |

## Lot D — Documentation

| Id | Priorité | Constat | Action | Effort | Critère d'acceptation |
|---|---|---|---|---|---|
| BL-10 | P3 | Décompte IPC obsolète (159 → 183) | Mettre à jour `docs/AUDIT-GLOBAL.md` et `docs/DECISIONS.md` ; pointer ce dossier d'audit | 0,5 j | Comptes alignés sur l'inventaire |
| BL-11 | P3 | Limites dispersées entre docs | Une section « Limites connues » unique dans `docs/README.md` renvoyant aux documents | 0,5 j | Un lecteur trouve les 4 limites (DNS, `dgram`, enfants, Hermes) en un endroit |

## Vérifications manuelles (hors code)

| Id | Vérification | Préparation | Critère |
|---|---|---|---|
| M1 | SSH/Tailscale réels | second PC sur le même réseau ou pair Tailscale | empreinte vérifiée, première confiance explicite, changement de clé détecté, terminal utilisateur OK, agent sans exécution distante |
| M2 | Sauvegarde externe sur disque amovible | disque dédié, données factices | dossier complet + manifeste valide ; débranchement → état « incomplet » ; restauration OK ; ancien conservé `.before-restore-*` |
| M3 | Voix duplex réelle | micro + haut-parleurs | interruption sans reprise fantôme, pas de doublon, latence affichée cohérente avec 263–290 ms |
| M4 | Contrôle visuel des correctifs A-02..A-16 | aucune | petite/grande fenêtre, focus clavier, infobulles, états vides |

## Ordre recommandé

1. **BL-01** (wrapper IPC) → 2. **BL-03** (valeurs du coffre) → 3. **BL-02** (débloquer `test:core`) → 4. **BL-04/BL-07** (confinement) → 5. **BL-05/BL-06/BL-09** (qualité) → 6. **BL-10/BL-11** (doc) → 7. M1–M4.

Rationnel : BL-01 réduit la surface d'attaque de tous les canaux ; BL-03 corrige le seul point où une valeur sensible est en clair dans un fichier ; BL-02 rend la CI exploitable sur toute machine ; le reste est de la dette.

## Ce qui ne doit pas être fait

- Ne pas « nettoyer » les 606 avertissements en masse sans tri (risque de masquer un vrai défaut).
- Ne pas installer de dépendance ou de modèle pour corriger un point.
- Ne pas rendre l'isolation `workspace` « disponible » sans `selftest` réel : mieux vaut un refus explicite qu'une fausse promesse.
- Ne pas modifier les tests pour les faire passer sans corriger la cause (sauf BL-02, où le test est explicitement non concluant).

*Fin du backlog.*
