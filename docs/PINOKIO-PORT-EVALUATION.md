# Évaluation du portage de Pinokio (phase 6A)

Statut : **audit en lecture seule, aucun code écrit**. Ce document attend la validation humaine avant toute phase 6B.
Date : 2026-10-17. Sources lues via l'API GitHub, sans clonage ni exécution.

## 1. Périmètre réellement lu

| Dépôt | Version lue | Dernier push | Licence |
|---|---|---|---|
| pinokiocomputer/pinokio | 8.2.0 | 2026-09-02 | MIT (fichier LICENSE, SPDX reconnu) |
| pinokiocomputer/pinokiod | 8.1.1 | 2026-09-02 | `package.json` dit « MIT » mais **aucun fichier LICENSE** dans le dépôt ; GitHub ne détecte aucune licence |

Lu en détail : `kernel/api/index.js` (le moteur d'étapes, 2185 lignes), `kernel/api/shell/index.js`, `kernel/shell.js`
(1939 lignes, parties venv, env, sudo), `kernel/api/script/index.js`, et les listes de fichiers de `kernel/api/*` et
`kernel/bin/*`. **Non lus** : `kernel/api/fs` en détail, `kernel/api/net`, `gradio`, `hf`, `kernel/git.js`,
`server/`, l'interface web, les scripts de lancement de la communauté. Les affirmations ci-dessous portent sur ce
qui a été lu ; le reste est signalé comme tel.

**Point de licence à trancher par l'humain** : `pinokiod` n'a pas de LICENSE. Le champ `package.json` est une
déclaration, pas un texte de licence avec attribution. La politique du 2026-10-17 écarte le copyleft, mais ici il
ne s'agit pas de copyleft : c'est l'absence de texte. Recommandation : ne **copier aucune ligne** de pinokiod, réécrire
le moteur à partir du comportement observé, et conserver la référence dans `docs/THIRD-PARTY-NOTICES.md`.

## 2. Ce que Pinokio est

Un lanceur d'applications d'IA locales. Une « application » est un dossier de scripts (JSON ou JS) qui décrivent
installation, démarrage, arrêt et mise à jour. Le noyau (`pinokiod`, Node.js) interprète ces scripts étape par étape
et fournit un jeu de méthodes (`shell.run`, `fs.*`, `script.*`, `net.*`, `json.*`, `input`, `notify`…). Une
interface web locale pilote le tout.

## 3. Cartographie du DSL de scripts

Un script est une liste d'étapes `{ method, params, … }`. Constats tirés du code :

| Notion | Observé dans le code | Équivalent JAROD |
|---|---|---|
| Étape | `{ method: "ns.verbe", params }` ; la méthode est résolue dans `kernel/api/<ns>/index.js` | outil du pont, appelé par `executeGuardedTool` |
| Enchaînement | `next` (index ou `id` d'étape), sinon `i+1` ; `when` (expression de gabarit) saute l'étape si faux | graphe d'étapes avec garde, à écrire |
| Gabarits | `{{ … }}` rendus en boucle jusqu'à disparition du motif, contre une mémoire (`input`, `args`, `local`, `global`, `cwd`, `port`, `self`, `exists()`, `running()`, `ready()`…) | **à restreindre** : voir §6, c'est la surface d'attaque principale |
| Sortie d'une étape | `input` de l'étape suivante (stdout, réponse) | résultat typé, jamais ré-évalué comme code |
| Démon | `script.daemon` : le script reste vivant après la dernière étape | tâche du planificateur |
| Hooks | `script.on.stop` etc. | arrêt propre du plugin |
| `shell.run` | `params.message` (chaîne ou liste), `path` (cwd), `env`, `venv`, `venv_python`, `sudo`, `input`, `on` (écouteurs sur le flux), `buffer`, `persistent`, `id`/`group` | `run_shell` via la sandbox 3.1/3.2 |
| `venv` | `params.venv` = chemin ; avec `venv_python`, utilise `uv venv --python …` ; sinon `python -m venv` | étape d'installation dans la zone du plugin |
| `sudo` | `params.sudo` passe par `sudo-prompt` (élévation Windows) | **à supprimer**, voir §6 |
| Clonage git | pas de méthode dédiée vue dans `kernel/api` ; fait par `shell.run` (`git clone …`) et par `kernel/bin/git.js` | outil `git_clone` à identifiants exacts, épinglé sur un commit |
| Téléchargement | `fs.download` (+ worker) | `http_request` / quarantaine 3.3, puis promotion |
| Isolation | « bluefairy » : option par application (`protection_enabled`), **désactivée par défaut** (`"off"` quand aucune préférence) | notre confinement est l'inverse : actif par défaut |
| Binaires gérés | `kernel/bin/` : conda, uv, python, node, git, ffmpeg, cuda, torch, huggingface, playwright… installés par Pinokio | hors périmètre : installation de toolchain = action humaine |

## 4. Écarts de sécurité par rapport à JAROD (constats, pas jugements sur Pinokio)

Pinokio part du principe que **le script est de confiance** : l'utilisateur l'a choisi, il s'exécute avec ses droits.
JAROD part du principe inverse (échec fermé). Conséquences du portage naïf :

1. **Exécution directe** : `shell.run` lance un vrai shell avec les droits de l'utilisateur, sans AppContainer.
2. **Gabarits évalués** : `{{ … }}` est rendu sur une mémoire riche ; une valeur venue d'une sortie d'outil ou d'un
   fichier téléchargé peut devenir une expression. C'est l'équivalent d'une injection de gabarit.
3. **`sudo`** : élévation par invite, interdite chez nous (modifier la sécurité système).
4. **Réseau** : `net`, `web.expose`, proxys, `cloudflare` ouvrent des ports ou des tunnels.
5. **Scripts tiers** : le catalogue de la communauté est du code non audité qui télécharge et lance des
   dépendances (pip, npm, modèles).
6. **Aucun journal signé** : le flux de sortie est transmis à l'interface, pas écrit dans un registre d'audit.

## 5. Architecture proposée (si la phase 6B est validée)

Principe directeur : **un script Pinokio n'est jamais exécuté ; il est traduit en plan, et chaque étape du plan passe
par `executeGuardedTool`**. Aucune seconde porte d'exécution.

```
 recette (JSON déclaratif)
   -> chargeur : schéma strict, signature + empreinte du manifeste (plateforme de plugins, phase 4)
   -> compilateur : étapes -> appels d'outils typés (liste blanche de verbes)
   -> exécuteur déterministe : pour chaque étape, executeGuardedTool(outil, paramètres)
        -> permissions par outil (demande à l'utilisateur au premier usage)
        -> run_shell : shell-guard + herald-sandbox (AppContainer), zone = dossier de la recette
        -> téléchargements : quarantaine 3.3 puis promotion explicite
        -> secrets : coffre uniquement, jamais dans la recette
        -> audit : une entrée signée par étape (condensat, jamais le contenu)
```

Correspondance des verbes à porter (sous-ensemble minimal proposé) :

| Verbe Pinokio | Outil JAROD | Remarque |
|---|---|---|
| `shell.run` | `run_shell` | `path` forcé dans la zone ; `sudo` refusé ; `env` filtré par liste blanche |
| `fs.read` / `fs.write` / `fs.copy` / `fs.rm` | `read_file` / `write_file` / … | chemins résolus puis contraints à la zone |
| `fs.download` | `http_request` + quarantaine | promotion explicite |
| `json.get` / `json.set` | outils purs, sans E/S | |
| `input`, `notify` | demande utilisateur, notification | |
| `script.start` / `stop` | `plugin.start` / `stop` | via la plateforme de plugins |
| `net`, `web`, `local`, `gradio`, `hf`, `cloudflare`, `exec`, `proc` | **refusés par défaut** | un par un, avec preuve, si un besoin réel apparaît |

Gabarits : remplacer `{{ … }}` par une substitution **sans évaluation** (variables nommées, pas d'expression, pas
d'appel de fonction). Les conditions `when` deviennent des comparaisons structurées.

## 6. Moteur déterministe ou skills agentiques ?

| Critère | Moteur de recettes déterministe | Skills agentiques (le modèle lit un guide et agit) |
|---|---|---|
| Reproductibilité | élevée : même recette, même plan | faible : dépend du modèle |
| Audit | une entrée par étape, plan connu **avant** exécution | plan découvert pendant l'exécution |
| Surface d'injection | le texte de la recette est signé ; seules les sorties d'outils sont « données » | toute sortie d'outil est lue par le modèle : surface large (voir l'observateur A4) |
| Coût / latence | nul pour le modèle | tokens à chaque installation |
| Adaptation à l'imprévu | nulle : échec net, retour arrière | bonne, mais c'est précisément le risque |
| Réutilisation du catalogue Pinokio | partielle (sous-ensemble de verbes) | large mais non maîtrisée |

**Recommandation** : moteur déterministe pour **installation, démarrage, arrêt, mise à jour** (opérations où le
risque est maximal et la variabilité faible), skills agentiques réservés au **diagnostic d'un échec** (le modèle lit
les journaux et *propose* une correction, qui repasse par l'approbation). Le portage ne cherche pas la
compatibilité totale avec le catalogue communautaire : il importe un sous-ensemble et refuse le reste.

## 7. Plan de la phase 6B (non démarrée)

1. Spécification du format de recette (JSON Schema) et du sous-ensemble de verbes ; tests rouges d'abord.
2. Substitution sans évaluation ; tests d'injection de gabarit (valeur malveillante venant d'une sortie d'outil).
3. Compilateur recette → plan, refus de tout verbe hors liste blanche.
4. Exécuteur branché sur `executeGuardedTool`, journal signé, retour arrière.
5. Une recette de référence écrite à la main (installation d'un outil simple dans la sandbox), mesurée.
6. Importeur facultatif de scripts Pinokio JSON simples, avec rapport des étapes refusées.

## 8. Risques et inconnues

- Licence de `pinokiod` non établie (voir §1) : bloque toute reprise de code, pas la réécriture.
- Parties non lues (`fs`, `net`, `git.js`, `server/`) : le §3 peut être incomplet.
- Les scripts du catalogue communautaire n'ont pas été examinés : le taux de scripts importables est **inconnu** ;
  à mesurer sur un échantillon avant de promettre une compatibilité.
- L'installation de toolchains (conda, CUDA, torch) reste une action humaine ; Pinokio la fait automatiquement, pas nous.

## 9. Décisions demandées à l'humain

1. Valider ou refuser le principe « traduire, jamais exécuter ».
2. Trancher le statut de `pinokiod` sans LICENSE (réécriture seule, ou contact avec l'auteur).
3. Valider le sous-ensemble de verbes et la liste des verbes refusés.
4. Confirmer la répartition déterministe / agentique du §6.

## 10. Correction et statut de la phase 6B (2026-10-17)

**Omission de l'audit 6A.** Ce document n'avait pas vu que le dépôt embarque déjà `pinokiod` sans modification
(`docs/DECISIONS.md`, ADR-022 : `pinokio-runtime/`, hôte `apps/desktop/electron/pinokio/`, outils `pinokio_search`,
`pinokio_status`, `pinokio_logs`, `pinokio_install`, `pinokio_run`, `pinokio_stop`, un accord par appel). Constat de
sécurité : les scripts installés ou lancés par ce moteur s'exécutent avec les droits de l'utilisateur, hors de la
sandbox et hors de `executeGuardedTool` ; seul l'appel d'outil est soumis à l'accord. L'ADR choisit la compatibilité
totale avec les lanceurs publiés ; le §5 propose l'inverse (sous-ensemble, tout confiné).

**Décision prise pour 6B, additive** (instruction du 2026-10-17 : « valider l'audit puis lancer 6B ») :
1. principe « traduire, jamais exécuter » retenu pour le NOUVEAU chemin (`integrations/src/recipes/`) ;
2. `pinokiod` sans LICENSE : réécriture seule, aucune ligne reprise ; l'embarquement existant de l'ADR-022 n'est pas touché ;
3. sous-ensemble de verbes : `shell.run`, `fs.read|write|list`, `http.get`, `log`, `set`, `json.get` ; refusés :
   net, web, local, gradio, hf, cloudflare, exec, proc, script, fs.download, et `sudo`/`env`/`venv`/`daemon`/`next` partout ;
4. déterministe pour installation/démarrage/arrêt/mise à jour, agentique réservé au diagnostic (non écrit ici).

**Reste à trancher par l'humain** : l'ADR-022 doit-il rester la voie par défaut (compatibilité) ou le moteur embarqué
doit-il passer derrière un accord renforcé / être retiré au profit des recettes ? Cette question n'est pas tranchée
par le code livré : les deux voies coexistent.

**Livré** : `recipes/template.ts` (substitution sans évaluation, un seul passage), `recipes/recipe.ts` (schéma strict,
liste blanche, plan empreinté SHA-256, isolation du shell imposée), `recipes/run.ts` (exécuteur injecté, échec fermé,
retour arrière, valeurs sûres pour un shell, journal d'empreintes), `recipes/pinokio-import.ts` (sous-ensemble sûr + rapport
des refus). Tests : `integrations/test/recipes.test.ts` (16) et `agent/test/recipes-reference.test.ts` (4, vraie porte
unique, recette de référence mesurée). Non fait : signature du plan par la plateforme de plugins, branchement à une
commande/UI, rôle agentique de diagnostic, taux d'import mesuré sur le catalogue communautaire (non examiné).

