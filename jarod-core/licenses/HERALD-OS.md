# Provenance — Herald OS, outils système Windows (portage vers TypeScript, 2026-10-11)

| | |
|---|---|
| Projet | `herald-os` (fork de `PAVADI234/herald-os`), dépôt local `C:\Users\San\herald-os`, branche `feature/windows-port` |
| Révision | commit `6e088b64b117f02c3bd4057ff7fc54779a8c23fd` (2026-10-11T11:57:38+02:00, « Notes: the VM test attempt and why it stopped ») |
| Licence | **MIT** — « Copyright (c) 2026 Luke The Dev (@iamlukethedev) » (`LICENSE` à la racine du dépôt, texte ci-dessous) |
| Usage | **Portage** : les scripts PowerShell et la logique d'analyse du pont système Windows sont repris en TypeScript dans des outils intégrés de Jarod (`packages/plugins/tools/src/system/`). Aucun code Python n'est embarqué (DECISIONS.md:225). |
| Accès | lecture seule sur le dépôt Herald OS ; aucune écriture dans `S:\` |

## Fichiers lus (sous `plugins/herald-os-bridge/bridge/`)

| Fichier | Lu pour |
|---|---|
| `host/winps.py` | l'exécuteur PowerShell (`-EncodedCommand`, arguments en JSON dans l'environnement) et les scripts `SYSTEM_INFO`, `INSTALLED_APPS`, `RUNNING_APPS`, `NETWORK`, `BLUETOOTH`, `EVENT_LOG`, `CRASHES`, `CRASH` |
| `host/windows.py`, `host/search.py` | la recherche de fichiers (`find_files`, `walk_entries`, `matches_search`, `KIND_EXTENSIONS`, `_SKIP_DIRS`), les analyseurs (`parse_system_info`, `build_process_rows`, `parse_wlan`, `parse_network`, `parse_bluetooth`, `parse_start_apps`, `format_log_lines`, `summarise_crash`), la table `EXCEPTION_NAMES`, le parcours de disque (`measure_tree`) |
| `permissions.py` | la liste des emplacements protégés Windows (`WINDOWS_PROTECTED`) |
| `tools.py` | les contrats JSON et les descriptions des outils `system_*` |

## Ce qui est reproduit dans le dépôt Jarod

- **Repris tels quels** (scripts PowerShell, indiqués par l'en-tête de `scripts.ts`) : `SYSTEM_INFO`, `INSTALLED_APPS`, `RUNNING_APPS`, `NETWORK`, `BLUETOOTH`, `EVENT_LOG`, `CRASHES`, `CRASH`.
- **Réécrits** (même contrat de sortie, autre méthode) : `PROCESSES` et `LISTENERS` (échantillons `Get-Process` et lecture du propriétaire dans le jeton du processus, au lieu de `Win32_Process` et `GetOwner` : 9 à 10 s mesurées côté Herald, ≈ 1,3 s ici).
- **Portés en TypeScript** : la recherche de fichiers (`system_find_files`, `find.ts` : parcours borné par un délai, sans ripgrep ; le contenu des fichiers n'est volontairement pas lu), les analyseurs, la table des codes d'exception, la liste des emplacements protégés, le parcours de disque.
- Les descriptions d'outils sont traduites en français ; les contrats JSON de sortie sont conservés.

## Texte de licence

```
MIT License

Copyright (c) 2026 Luke The Dev (@iamlukethedev)

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
