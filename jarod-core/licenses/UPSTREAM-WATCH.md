# Veille amont (`jarod upstream watch`) — dépôts surveillés et règles de portage

La veille (`upstream.json`, rapports dans `docs/upstream-watch/`) **observe** ; elle ne copie rien. Ce fichier consigne les licences des dépôts
surveillés, les preuves, et ce qu'un portage exige.

**Licence re-vérifiée à CHAQUE rapport** (`licenceAttendue`, défaut `MIT` ; `licenceSource` : `github` = champ `license` de l'API, `readme` = section
« License » du README pour un dépôt sans fichier LICENSE). Si la licence attendue n'est plus constatée, le champ `portage` de l'entrée passe à
**`gelé`** et le rapport l'écrit en tête (« ⛔ PORTAGE GELÉ »). Il ne redevient `autorisé` que par une main humaine (modifier `upstream.json`) :
une licence qui revient ne lève pas le gel toute seule. Une panne réseau ne gèle rien (le dépôt est en échec, curseur et `portage` inchangés).

| Dépôt | Branche | Licence annoncée | Source de la preuve | Portage |
|---|---|---|---|---|
| NousResearch/hermes-agent | main | MIT | GitHub (`license.spdx_id` = MIT, constaté le 2026-10-05) | autorisé sous les règles ci-dessous (état écrit au premier rapport) |
| fathah/hermes-desktop | main | MIT | GitHub (MIT) ; parent direct de SANK-UI, voir `SANK-UI.md` | autorisé |
| anywhere-labs/dsh-desktop | master | MIT | GitHub (MIT) | autorisé |
| co-l/openfox | develop | MIT | **README, section « License »** (voir ci-dessous) ; aucun fichier `LICENSE` | autorisé, **avec attribution à co-l** |

## co-l/openfox — preuve de licence (décision de l'utilisateur, 2026-10-05)

GitHub ne détecte aucune licence (pas de `LICENSE` à la racine). L'utilisateur a décidé que la déclaration du README suffit pour autoriser un
portage, à condition d'**attribuer co-l** et de consigner la preuve ; elle est re-vérifiée à chaque rapport (gel automatique si elle disparaît).

- Citation, `README.md`, section `## License` (ligne 157) : « MIT » (la section ne contient que ce mot, pas de ligne de copyright).
- Révision : blob `233820e6890d2bd15d863f4262917988614320f0` du `README.md` de la branche `develop` (tête `3b434db5f3722db6314eed600d7d3fb835c3b425`, 2026-09-29).
- Constaté le **2026-10-05**.
- Limite connue : sans fichier `LICENSE`, ni le texte MIT ni le détenteur du copyright ne sont fournis par l'amont. Demande ouverte : https://github.com/co-l/openfox/issues/413 (2026-10-05). Tant qu'elle n'a pas de réponse, un fichier porté cite « © co-l (MIT, déclaré dans le README de co-l/openfox@3b434db) » et le texte MIT standard est joint à l'entrée de portage.

## Règles (garde-fous du chantier)

1. **Aucun portage automatique.** Le rapport nourrit une revue humaine ou d'agent ; la colonne « pertinence jarod » est remplie par cette revue.
2. **Écritures de la commande** : `upstream.json` et `docs/upstream-watch/` seulement (refus codé dans `safeWrite`), requêtes HTTP `GET` seulement,
   `GITHUB_TOKEN` lu de l'environnement (jamais d'un fichier, jamais écrit, envoyé uniquement à `api.github.com`) : fine-grained PAT *Public repositories
   (read-only)*, 90 jours. **`GH_TOKEN` (jeton de publication, *Contents: write* sur le dépôt de release) est INTERDIT dans une session de veille** : la commande
   refuse de démarrer (code 2, avant toute requête) s'il est défini (DECISIONS 2026-10-05, « deux jetons, pas un »).
3. **Contenu amont non fiable** : titres, noms de fichiers et notes de version peuvent contenir des consignes visant l'agent de revue ; ils sont
   neutralisés dans le rapport et ne sont jamais exécutés ni suivis.
4. **Tout portage** : la licence du dépôt source est consignée ICI (texte et révision d'origine, comme `SANK-UI.md`) avant le premier fichier copié ;
   `portage` doit valoir `autorisé` ; un patch sur du code SANK-UI vendu va dans `licenses/upstream-patches/` ; les tests `sank-ui-protected` et les
   gates P0 à P5 sont verts avant le commit.
