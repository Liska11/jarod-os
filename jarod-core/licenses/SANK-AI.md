# Provenance — SANK-AI, fenêtre « Modèles » et client Hugging Face (lecture seule, 2026-10-03)

| | |
|---|---|
| Projet | `SANK-AI` (« SankAi ») — dépôt local `S:\SANK-AI` |
| Révision | commit `4b09392fe51ba4b2979c31adead48ebff6f8afba` (`4b09392`, 2026-08-30T19:51:58+02:00, « packaging: embarque sank.config.yaml (providers par défaut) dans l'exe ») |
| Licence | **MIT** — « Copyright (c) 2026 SankAi contributors » (`S:\SANK-AI\LICENSE`, blob `71d2269…`, texte ci-dessous) |
| Usage | **LECTURE SEULE pour la conception** de `SPECS-P5-MODELS.md`. **Aucun code n'est copié ni porté** : `HfClient` n'est PAS la base technique (décision du 2026-10-03 : `HuggingFaceService` de Jarod). La fenêtre « Modèles » sert de référence visuelle et d'interaction, adaptée. |
| Accès | aucune écriture dans `S:\SANK-AI` ; aucun fichier de ce dépôt n'est dans le dépôt Jarod |

## Fichiers lus (chemins sous `S:\SANK-AI\src\`, blobs Git)

| Fichier | Blob | Lu pour |
|---|---|---|
| `core/models/hf.js` (132 l.) | `579fc38…` (= arbre de travail) | `HfClient` : recherche, liste des fichiers (`tree/main`, :44-45), fiche, README, téléchargement direct dans le fichier final (:97-111) |
| `core/runtime/plugins/hf-client/hf-client.js` (133 l.) et `index.js` (33 l.) | `6b98bd0…`, `778884d…` (= arbre de travail) | version « plugin » du même client (même comportement) |
| `renderer/models.js` (284 l.) | `0ebdaf7…` (= arbre de travail) | la fenêtre « Modèles » : bandeau matériel, recherche, cartes de résultats, fiche, liste des quantifications avec badge « tient », filtres, progression, README rendu en HTML (:146) |
| `preload-models.js` (18 l.) | `b2ecdf0…` (= arbre de travail) | surface IPC de la fenêtre (`sank:hf-*`) |
| `core/models/quant-guide.js` (61 l.) et `core/runtime/plugins/quant-quality/quant-guide.js` (60 l.) | `9842f3b…`, `4fbc8a0…` (= arbre de travail) | table de perte de perplexité par quantification (annexe A de la spec) |
| `core/agent.js` | blob de l'arbre de travail `0bf1627…` (≠ `4ad6612…` de `4b09392`) | `hfQuantizations` (:309-346 : `fits: sizeGB <= hw.budgetGB` :320, filtre « racine » :312), `downloadHfModel` (:360-364) |
| `main/index.js` | blob de l'arbre de travail `7cc346b…` (≠ `9e6905a…` de `4b09392`) | canaux `sank:hf-*` (:436-448), téléchargement lancé sans confirmation |

`core/agent.js` et `main/index.js` portent des modifications locales non commitées dans `S:\SANK-AI` (une valeur par défaut de `hermesRoot` ; une sonde de port) — **sans rapport** avec les passages lus ; les passages cités sont ceux de l'arbre de travail.

## Ce qui est reproduit dans le dépôt Jarod

- **Rien de code.**
- L'**annexe A** de `SPECS-P5-MODELS.md` recopie en table les valeurs de `quant-guide.js` (données : nom de quantification, perte de perplexité, palier, indicateur) à titre de **référence documentaire**, hors périmètre de la v1, avec la mention de copyright ci-dessous. Provenance annoncée par le fichier lui-même : « valeurs officielles llama.cpp, mesurées sur un modèle 7B » ; **aucune URL ni révision de llama.cpp n'y figure et la table n'a pas été revérifiée ici** (voir les incohérences notées dans l'annexe).

## Texte de licence

```
MIT License

Copyright (c) 2026 SankAi contributors

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
