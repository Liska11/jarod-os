# Provenance — renderer SANK-UI (D1)

| | |
|---|---|
| Projet | `hermes-desktop` 0.7.4 (« Hermes One Desktop »), auteur **fathah** |
| Dépôt amont | https://github.com/fathah/hermes-desktop (remote `upstream` de `S:\SANK-UI`) |
| Révision | commit `3aaadb01076a749d7f9389dca4ffce081cf8ebaa` (`3aaadb0`, 2026-08-06T19:57:28+05:30, « Merge pull request #880 from eachann1024/fix/settings-i18n-alignment ») ; `FollowUsModal.tsx` : commit `20759e7` (B15, ci-dessous) |
| Licence | **MIT** — texte ci-dessous (`S:\SANK-UI\LICENSE`) |
| Copie | faite par l'utilisateur (B13, 2026-09-27) : `src/renderer` et `src/shared` → `packages/desktop/src/sank/src/` ; `S:\SANK-UI` n'est jamais modifié (lecture seule) |

## Ce qui a été copié

- **Arbre de travail** de `S:\SANK-UI` au moment de la copie : `3aaadb0` plus une modification de
  `src/renderer/src/components/FollowUsModal.tsx` (blob `319429ea…` au lieu de `6e8de81…` : la fenêtre
  « Follow us » d'accueil n'est plus affichée — commentaire « Désactivé: nag d'onboarding forcé »). Vérifié par
  `diff -r` contre `git archive 3aaadb0 src/renderer src/shared` : c'est le SEUL écart hors Office.
- **B15 résolu (2026-09-28)** : cette modification est committée par l'utilisateur dans `S:\SANK-UI`, commit local
  `20759e767e81b421feb5c1581a858575f19a38a8` (`20759e7`, « Hide FollowUsModal - desactive le nag d onboarding force »,
  1 fichier, +4/−8). Provenance : `FollowUsModal.tsx` = `20759e7`, tous les autres fichiers copiés = `3aaadb0`.
  Hash communiqué par l'utilisateur, non relu par l'agent (aucun accès à `S:\SANK-UI`).
- Retiré par l'utilisateur : `src/renderer/src/screens/Office/` (78 fichiers suivis, dont les 28 modèles `.glb`) — Q8 = A.
  Aucun modèle 3D (`.glb`/`.gltf`) ne reste : les 28 étaient tous sous `Office/office3d/assets/`, Office était leur seul consommateur.
- 540 fichiers : 348 `.ts`, 115 `.tsx`, 55 `.svg`, 9 `.ttf`, 4 `.webp`, 4 `.png`, 2 `.css`, 1 `.mp4`, 1 `.html`, 1 `.gif`.
- Ajouté ensuite par `scripts/gen_hermes_shim.cjs` (lecture seule de SANK-UI, fichier non modifié exigé) :
  `src/sank/src/preload/index.d.ts` = `src/preload/index.d.ts` verbatim — contrat de type contre lequel SANK-UI
  vérifie son renderer (`tsconfig.web.json`).

## Modifications Jarod (fichiers:lignes, dans `packages/desktop/src/sank/src/`)

- Fins de ligne : les 487 fichiers texte en CRLF passés en LF (règle du dépôt `.gitattributes eol=lf` ; git les
  stockerait ainsi). Contenu identique à la source hors fins de ligne, sauf les fichiers modifiés ci-dessous.
- `renderer/src/screens/Layout/Layout.tsx` — Office retiré : :30 (import → commentaire), icône `Building` (source :43),
  vue `"office"` (source :59), entrée de navigation (source :72), volet (source :928-933).
- `renderer/src/screens/Chat/slashCommands.ts` — commande `/office` retirée (source :147-151).
- `renderer/src/screens/Chat/slash/desktopCommands.ts` — navigation `office` retirée (source :68).
- `renderer/src/components/profile/ProfileModal.tsx` — volet Portefeuilles désactivé AU MONTAGE (fichiers conservés) :
  :1 (`lazy`, `Suspense`), :25-32 (import dynamique conditionné par `__JAROD_WALLET_PANE__`, `openableSection`),
  :75-89 (entrée « wallet » filtrée), :111 et :116 (section « wallet » demandée → « profile »), :531-535 (rendu conditionnel).
- `renderer/src/screens/Chat/Chat.tsx` — :802-817, écoute `jarod:voice-transcript` (micro continu Jarod, W10).
- `renderer/src/components/AgentMarkdown.test.tsx` — :1 (import `beforeAll`), :21-29 (`beforeAll` qui attend les deux
  `import()` du surligneur ; le test « box-drawing » n'a plus de délai propre : la décision utilisateur du 2026-09-28
  (15 s) est remplacée, cause = `waitFor` interne de 5 s sur un import de durée non bornée, DECISIONS 2026-10-01).
  Assertions inchangées ; composant `AgentMarkdown.tsx` inchangé.
- `renderer/src/components/settings/DataPane.tsx` — :4 (import) et :34 (`<WorkspaceSection />`), section « Dossier de travail par défaut »
  (SPECS-P5-WORKSPACE.md) ; `shared/i18n/locales/en/settings.ts` — :133-140, six clés `workspace*` (anglais seulement, les autres langues
  retombent sur l'anglais). Fichiers AJOUTÉS (pas de SANK-UI) : `renderer/src/components/settings/WorkspaceSection.tsx` et ses tests
  `WorkspaceSection.test.tsx`, `DataPane.test.tsx`.
- `renderer/src/screens/Chat/hooks/useChatActions.ts` — :18-19 (source :18), `/pair` ajouté aux commandes transmises telles
  quelles (`RENDERER_NATIVE_SLASH`, comme `/approve` et `/deny`) : le catalogue Hermes ne la connaît pas ; le main
  l'exécute localement (appairage des messageries, jamais le LLM). DECISIONS 2026-09-28.

- **Parité UI (SPECS-P5-UI-PARITE.md, 2026-10-03)** — `renderer/src/components/settings/SettingsModal.tsx` : icônes `Bot`, `Cpu`, `Server`, `Lock`, `FileSearch`, `Smartphone` (import), import des volets `AgentPane`, `ModelsPane`, `LocalEnginePane`, `SecurityPane`, `RagPane`, `DevicesPane`, sections `"agent"`, `"models"`, `"engine"`, `"security"`, `"rag"`, `"devices"`, groupe `"jarod"` (type `NavGroup`, entrées de navigation, ordre des groupes, rendu des volets) ; `renderer/src/screens/Layout/Layout.tsx` : import et montage de `<ToolApprovalHost />` en tête de `layout-shell` ; `shared/i18n/locales/en/settings.ts` : `nav.groups.jarod`, `nav.agent`, `nav.models`, `nav.engine`, `nav.security`, `nav.rag`, `nav.devices`, objets `approval`, `agent`, `terminal`, `models`, `engine`, `security`, `rag` et `devices` (anglais seulement, les autres langues retombent sur l'anglais) ; `shared/i18n/locales/en/navigation.ts` : clé `terminal` ; `renderer/src/screens/Layout/Layout.tsx` : entrée de navigation « Terminal » (vue `"terminal"`, `PINNED_NAV_ITEMS`) et son volet (§5). Fichiers AJOUTÉS (pas de SANK-UI) : `renderer/src/components/jarod/` (`oneai.ts`, `useJarodSettings.ts`, `fields.tsx`, `jarod.css`, `ToolApprovalHost.tsx` et son test), `renderer/src/components/settings/AgentPane.tsx`, `ModelsPane.tsx`, `LocalEnginePane.tsx`, `SecurityPane.tsx`, `VaultSection.tsx`, `RagPane.tsx`, `DevicesPane.tsx` et leurs tests, `renderer/src/screens/Terminal/Terminal.tsx` et son test.

- **Écrans « non disponible » cachés au montage (SPECS-P5-UI-PARITE.md § 24, 2026-10-04)** — fichier SANK-UI MODIFIÉ (déjà exception) : `renderer/src/components/settings/SettingsModal.tsx` (constante `HIDDEN_SECTIONS` d'après la constante de construction `__JAROD_REMOTE_PANES__` de `vite.config.ts` › `define`, valeur `false` : entrée « Connection » filtrée du menu, `resolveSection` exportée et qui renvoie la section par défaut pour « connection » et « network », volet jamais rendu ; `true` rend tout). **Fichier PROTÉGÉ NON modifié ici** : `renderer/src/screens/Providers/Providers.tsx` (section « Hermes account », connexion OAuth des fournisseurs, onglet « Auxiliary ») : le correctif est un PATCH AMONT prêt à appliquer par l'utilisateur dans `S:\SANK-UI` (`licenses/upstream-patches/0001-providers-remote-panes.patch`, établi sur la révision amont `20759e7`, vérifié par `git apply --check` contre l'amont en lecture seule, gardé par `tests/repo/upstream-patches.test.ts`) ; il ne cache ces trois éléments que si `__JAROD_REMOTE_PANES__` est défini et faux. **À appliquer en amont, PUIS synchroniser ici** (ligne du tableau des exceptions pour `Providers.tsx`, manifeste régénéré par `pnpm sank:manifest`) ; tant que ce n'est pas fait, le volet Fournisseurs montre encore ces trois éléments, qui ne répondent que par un refus.

- **Fenêtre « Hugging Face models » (SPECS-P5-MODELS.md § 3.8 et § 3.11, 2026-10-03)** — fichier SANK-UI MODIFIÉ : `shared/i18n/locales/en/settings.ts` (objet `engine.hf` : libellés de la fenêtre et de son point d'entrée, anglais seulement ; attribut « lecture seule » déjà levé le 2026-10-01). Fichiers AJOUTÉS (pas de SANK-UI) : `renderer/src/components/settings/HuggingFaceDialog.tsx` et son test. Fichiers AJOUTÉS par la parité UI, MODIFIÉS ici : `renderer/src/components/settings/LocalEnginePane.tsx` (section « Models from Hugging Face » et bouton « Browse Hugging Face… »), `renderer/src/components/jarod/fields.tsx` (`NumberRow` / `TextRow` : le brouillon est resynchronisé pendant le rendu, plus par un effet de montage qui l'écrasait ; test `fields.test.tsx`), `renderer/src/components/jarod/jarod.css` (styles `hf-*`). **Aucun code de SANK-AI n'est copié** (`licenses/SANK-AI.md`) : la disposition de sa fenêtre « Modèles » (bandeau matériel, deux colonnes résultats / détail, liste des quantifications, filtres, barre de progression avec annulation) est reprise comme IDÉE, l'écriture est neuve ; retirés : README rendu en HTML, score 4D, étoile, étiquette de qualité (annexe A de la spec).

- **Section « Local models » du volet Local engine (2026-10-06, chargement / déchargement des modèles locaux et hotswap)** — fichier SANK-UI MODIFIÉ (déjà exception) : `shared/i18n/locales/en/settings.ts` (objet `engine.models`, anglais seulement). Fichiers AJOUTÉS (pas de SANK-UI) : `renderer/src/components/jarod/LocalModelsSection.tsx` et son test. Fichiers Jarod MODIFIÉS : `renderer/src/components/settings/LocalEnginePane.tsx` (la section montée en tête du volet), son test (réponse par défaut du canal `local-models-list`), `renderer/src/components/jarod/jarod.css` (styles `local-models-*`). **Aucun autre fichier protégé touché** (complément du même jour : `renderer/src/screens/Layout/Layout.tsx`, déjà exception, monte `<LocalModelsActivityHost />` — notification « Loading … / … loaded (N s) » de chaque chargement et déchargement, quelle qu'en soit l'origine ; fichiers AJOUTÉS `components/jarod/LocalModelsActivityHost.tsx` et son test ; second complément : champ « Context » des modèles LM Studio, nouvelles clés `engine.models.context*`, `presetContext`, `loadedContext*`, `reload` dans `en/settings.ts`, même objet, aucun nouveau fichier protégé) : le sélecteur de modèle du chat (`screens/Chat/ModelPicker.tsx`, `Chat.tsx`) est inchangé — le hotswap passe entièrement par le main (`set-model-config` et la préparation du fournisseur).

Attribut « lecture seule » : hérité de `S:\SANK-UI` par la copie ; levé seulement sur ces 11 fichiers (conservé sur les autres ; `DataPane.tsx` et `en/settings.ts` levés le 2026-10-01 ; `SettingsModal.tsx` et `en/navigation.ts` levés le 2026-10-03).

## Exceptions (garde `tests/repo/sank-ui-protected.test.ts`, SPECS-P5-UI-PARITE.md § 14)

Tout fichier de l'arbre `packages/desktop/src/sank/src/` qui vient de SANK-UI est PROTÉGÉ : identique à la révision amont ci-dessus (529 sur 618), attribut « lecture seule » conservé. Ce tableau est l'unique liste des écarts ; il est lu par machine (une ligne par fichier, ou par dossier pour un retrait). Ajouter une exception = une ligne ici + `pnpm sank:manifest` (jamais l'inverse). Une correction se fait d'abord dans `S:\SANK-UI`.

| Fichier | Statut | Où et pourquoi |
|---|---|---|
| `renderer/src/components/AgentMarkdown.test.tsx` | modifié | `beforeAll` qui attend les deux `import()` du surligneur (DECISIONS 2026-10-01) ; assertions inchangées. |
| `renderer/src/components/profile/ProfileModal.tsx` | modifié | volet Portefeuilles désactivé AU MONTAGE (fichiers conservés). |
| `renderer/src/components/settings/DataPane.tsx` | modifié | section « Dossier de travail par défaut » (SPECS-P5-WORKSPACE.md). |
| `renderer/src/components/settings/SettingsModal.tsx` | modifié | groupe « Jarod » : volets Agent, Models, Local engine, Security, Documents, Devices (SPECS-P5-UI-PARITE.md) ; entrée « Connection » cachée au montage, `__JAROD_REMOTE_PANES__` (§ 24). |
| `renderer/src/screens/Chat/Chat.tsx` | modifié | écoute `jarod:voice-transcript` (micro continu Jarod, W10). |
| `renderer/src/screens/Chat/hooks/useChatActions.ts` | modifié | `/pair` transmis tel quel au main (appairage des messageries ; DECISIONS 2026-09-28). |
| `renderer/src/screens/Chat/slash/desktopCommands.ts` | modifié | navigation `office` retirée. |
| `renderer/src/screens/Chat/slashCommands.ts` | modifié | commande `/office` retirée. |
| `renderer/src/screens/Layout/Layout.tsx` | modifié | Office retiré ; `<ToolApprovalHost />` et `<LocalModelsActivityHost />` montés en tête de `layout-shell`. |
| `shared/i18n/locales/en/navigation.ts` | modifié | entrées de navigation du groupe Jarod (anglais seulement). |
| `shared/i18n/locales/en/settings.ts` | modifié | libellés des volets Jarod, de la fenêtre Hugging Face et de la section « Local models » (anglais seulement). |
| `renderer/src/screens/Office/` | retiré | dossier retiré par l'utilisateur (Q8 = A) : 78 fichiers, dont les 28 modèles 3D. |

Les fichiers AJOUTÉS par Jarod (absents de l'amont : `components/jarod/*`, les volets Jarod, `HuggingFaceDialog`, `Terminal`, `WorkspaceSection`, `preload/index.d.ts`…) ne sont pas protégés : ce sont les fichiers possédés.

## Ressources tierces à régulariser avant distribution (installeur)

- Polices `Cairo-*`, `Manrope-*`, `SpaceGrotesk-Variable` (`renderer/src/assets/fonts/`) : familles publiées sous
  SIL Open Font License 1.1 par leurs auteurs ; SANK-UI ne livre pas les textes OFL — à joindre au paquet.
- Logos de fournisseurs (`renderer/src/assets/logos/*.svg`) et identité « Hermes One » (`hermes-one.svg`, `hermesbg.webp`,
  `splash*.png|webp`, `startvid.mp4`, `icon.png`, `iconv2.png`) : marques de tiers / de SANK-UI, hors MIT du code.
- Rien de cela n'est modifié ici ; consigné pour la release (P4).

## Texte de licence

```
MIT License

Copyright (c) 2026 github.com/fathah

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
