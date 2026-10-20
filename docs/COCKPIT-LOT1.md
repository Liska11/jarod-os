# Cockpit — lot 1 : registre vivant des capacités (Windows)

Date : 2026-10-20. Périmètre : Windows seulement.

## Ce qui existe

- **Registre vivant** (`jarod-core/packages/plugins/integrations/src/cockpit/`) :
  - `catalog.ts` contient les dix intégrations : adaptateurs F1 à F10, capacités et sondes ;
  - `service.ts` contient `CapabilityService`, qui sait lister, chercher par intention, décrire et resonder (cache de 30 s) ;
  - `tool.ts` définit l'outil de l'agent `capabilities`.
- **Outil `capabilities`** : il est en lecture seule et fait partie des outils de base (`CORE_TOOLS`). Ses actions sont `list`, `search`, `describe` et `check`. Aucune action n'ajoute une capacité : le catalogue est celui du code, et le texte d'une page ou d'un document ne peut rien y déclarer.
- **Outils déjà au registre** : chacun apparaît comme une capacité `tool.<nom>`. Son état vient du réglage `disabledTools` et de la porte de permissions.
- **Canaux du bridge** : `capabilities-list` et `capabilities-check`. Le second accepte un identifiant et rien d'autre.
- **Écran** : Réglages › Capacités.

## États

| État | Sens |
|---|---|
| `not-installed` | Le programme, le skill ou l'application est introuvable. |
| `installed-unconfigured` | C'est présent, mais il manque un prérequis (JDK, Docker, déclaration MCP…). |
| `available` | Tous les prérequis sont mesurés présents. |
| `degraded` | C'est présent, mais un prérequis est partiel (FFmpeg absent, Docker arrêté, skills incomplets). |
| `blocked-permission` | L'outil est désactivé ou refusé par la porte de permissions. |
| `error` | La sonde a échoué, n'a pas répondu ou a levé une exception. Ce n'est jamais présenté comme disponible. |
| `unknown` | La capacité est inconnue du catalogue. |

## Matrice d'intégration (sondes réelles sur cette machine, 2026-10-20)

Dans le tableau, « non inst. » veut dire non installé.

| Id | Dépôt (épinglé) | Licence | Capacité | Niveau | Sonde | État mesuré |
|---|---|---|---|---|---|---|
| F1 | ranxianglei/billion-context @39fb841 | MIT | `billion-context.compress-history` | détection | `bili --version` | non inst. |
| F2 | mksglu/context-mode @b31c7ee | Elastic-2.0 | `context-mode.index-output` | détection | `context-mode --version` et serveur MCP déclaré | non inst. |
| F3 | heygen-com/hyperframes @50e7a59 | Apache-2.0 | `hyperframes.render-video` | détection | `hyperframes --version` et `ffmpeg -version` | non inst. |
| F4 | NationalSecurityAgency/ghidra Ghidra_12.1.4_build | Apache-2.0 | `ghidra.static-analysis` | détection | fichiers de Ghidra et `java -version` ≥ 21 | **disponible**, 12.1.4 |
| F5 | cathrynlavery/diagram-design @4762027 | MIT | `diagram-design.draw` | skill | skill installé | non inst. |
| F6 | mattpocock/skills @5beb35b | MIT | `mattpocock-skills.engineering` | skill | 6 skills sélectionnés | non inst. |
| F7 | boykopovar/AnyPS5 @6d89a7b | GPL-2.0-only | `anyps5.relink` (expérimental) | détection | `JAROD_ANYPS5_RELINKER --help` | non inst. |
| F8 | storytold/artcraft @7a2935c | MIT OR Apache-2.0 | `artcraft.create` | application externe, distante | `ArtCraft.exe` présent | non inst. |
| F9 | morluto/rea @b4938ae | MIT | `rea.investigate` | détection | `rea --version` | **disponible**, 6.5.0 |
| F10 | usestrix/strix @a0f8ea2 | Apache-2.0 | `strix.app-security` | détection | `strix --version`, `docker info`, `STRIX_LLM` présent (valeur jamais lue) | non inst. |

Les dix sont au statut `adapter-ready` avec `execution: "none"` : **aucune n'est exécutée par Jarod au lot 1**.

Les règles des sondes :
- une sonde ne lance que le programme de l'intégration, avec un argument de diagnostic constant, sans shell et avec un délai de 8 s ;
- jamais un argument venu du modèle ;
- jamais un fichier cible ;
- `DO_NOT_TRACK=1` est passé à chaque lancement.

## Ce qui reste (lots suivants)

- **Exécution réelle** : chaque capacité utile passe en `agent-tool`, derrière `executeGuardedTool`, avec vérification du résultat et artefacts.
- **context-mode** : l'ajouter comme serveur MCP de Jarod (le client MCP existant suffit).
- **billion-context** : le brancher comme proxy local du transport, si c'est voulu.
- **Skills** : installer diagram-design et la sélection mattpocock dans les skills de Jarod.
