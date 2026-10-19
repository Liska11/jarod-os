# Jarod-OS : le noyau

`jarod-core/` est le **noyau de Jarod-OS** : conversation, outils, mémoire, planifications, messageries. Le shell (`apps/desktop` : fenêtre, dock, pages Aperçu,
Mémoire, Automatisations, Réglages…, dérivé de Herald OS) le démarre lui-même et lui parle comme à un `hermes serve` : la passerelle de ce dossier
(`packages/cli/src/gateway/`) répond au protocole JSON-RPC / REST que le shell connaît. Jarod-OS n'a besoin ni de `jarod-cordis`, ni d'une installation de Jarod,
ni de Hermes (Hermes reste possible en option : `JAROD_OS_BACKEND=hermes`). Origine du code : `PROVENANCE.md`.

## Lancer

Installé : lancer **Jarod-OS** (raccourci du menu Démarrer). L'application démarre son noyau (`resources\jarod-core\node.exe gateway.mjs`, fourni avec elle), attend
qu'il soit prêt, puis l'arrête proprement (entrée fermée, 8 s de délai) quand la fenêtre se ferme ; il ne reste jamais orphelin.

En développement (dépôt Herald) :

```
npm run bundle:core --workspace apps/desktop     # compile le noyau dans jarod-core/dist/gateway (pnpm requis)
npm run dev --workspace apps/desktop             # le shell lance ce noyau
```

| Réglage (variable d'environnement) | Défaut | Rôle |
|---|---|---|
| `JAROD_OS_DATA` | `%LOCALAPPDATA%\Jarod-OS` (Linux : `~/.local/share/jarod-os`) | données du noyau : `profile\` (base chiffrée, fournisseurs, mémoire, planifications) et `herald-home\` (fichiers du shell) |
| `JAROD_WORKSPACE` | `Documents\Jarod-OS` | dossier de travail de TOUTES les conversations ; les outils fichiers de Jarod s'y confinent |
| `JAROD_OS_BACKEND` | `jarod` si le noyau est présent, sinon `hermes` | choix du backend |
| `JAROD_OS_JAROD_CORE` | (emplacement par défaut) | dossier contenant un `gateway.mjs` compilé à utiliser à la place |
| `JAROD_OS_BACKEND_URL` + `JAROD_OS_BACKEND_TOKEN` | non défini | se brancher sur un backend déjà lancé (passerelle de développement, par exemple) |

### Profil

Jarod-OS a **son propre profil**, créé au premier lancement : il ne partage rien avec une installation de Jarod. Il est vide : pour parler à un vrai modèle, donner
une clé par l'environnement avant de lancer (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`… : la liste est `ENV_KEYS` dans
`packages/cli/src/context.ts`), ou utiliser un serveur local (Ollama, LM Studio), puis choisir le modèle dans Réglages › Hermes & agents.

Le noyau tourne avec le cœur complet (`--init` : verrou du profil, tick du planificateur, MCP, passerelles de messagerie) : les automatisations se déclenchent seules
tant que Jarod-OS est ouvert.

### Ce que le paquet n'embarque pas

Les workers d'embeddings et de reranker (ils lancent du TypeScript par `tsx` et OpenVINO), `onnxruntime-node`, `openvino` et `node-pty`. Les fonctions locales qui en
dépendent (recherche sémantique par modèle d'embedding local, reranker, accélération NPU) ne sont pas disponibles dans l'application installée ; la conversation, les outils,
la mémoire, les planifications et les messageries le sont.

## Vérifier le sélecteur de modèles

```
powershell -ExecutionPolicy Bypass -File scripts\verify-jarod-os.ps1
```

Profil jetable, faux serveur LM Studio local, vrai noyau et passerelle (`src/gateway/verify.ts`) : passerelle joignable, modèles découverts, `/model fournisseur:modèle`,
réglage persistant après réouverture du noyau, `/api/config/raw` à jour et sans secret. Ne touche ni au profil réel de Jarod ni à Hermes ; code de sortie 0 seulement si tout passe.

## Ce qui est servi à Herald

Vérifié dans l'interface (avec la passerelle de démonstration `src/gateway/demo.ts`, un faux modèle) :

- **Conversation** en flux, avec les cartes d'accord des outils (la phrase de l'action vient de `precheck`) ; reprise des conversations.
- **Outils système Windows** (14 : processus, disques, réseau, journaux, applications, recherche de fichiers par le nom, volume, mode sombre, ouverture, fichiers, arrêt de processus…) : voir
  `packages/plugins/tools/src/system/` et `licenses/HERALD-OS.md`.
- **Automatisations** : liste, création, modification, pause, reprise, « Run now », suppression.
- **Mémoire** : les deux listes de la page (MEMORY.md = souvenirs de Jarod, USER.md = lignes du profil), ajout, modification, suppression.
- **Sélecteur de modèles** (Réglages › Hermes & agents › Preferred model) : les fournisseurs LOCAUX (LM Studio, Ollama, llama.cpp, vLLM) sont interrogés à
  l'ouverture (`GET <adresse>/models`, 2 s au plus, résultat gardé 5 s, 2 s si le serveur est éteint) : un modèle chargé après l'ouverture de Jarod-OS apparaît
  sans redémarrage, et changer de modèle relit tout de suite. Les modèles d'embedding (nom contenant « embed ») et le Whisper local (transcription seulement) ne
  sont pas proposés. Aucun fournisseur distant n'est interrogé par ce moyen : leurs modèles viennent du catalogue.
- **`GET /api/config/raw`** : Jarod n'a pas de `config.yaml` ; Herald y lit seulement le fournisseur actif. La passerelle en sert une VUE en lecture seule
  (`model.provider`, `model.default`, valeurs masquées si elles ressemblent à une clé) ; l'écriture du YAML brut est refusée (405). Rien d'autre n'y figure.
- **Réglages › Hermes & agents** : modèle et fournisseurs configurés, « Ask first » (seul niveau d'autonomie réglable d'ici : l'approbation automatique de Jarod garde
  sa confirmation dans l'application Jarod), groupes d'outils (couper « This computer » retire les outils système de l'offre au modèle), terrain d'exécution « This device ».
- **Commandes `/`** de Jarod au composer (`slash.exec`, `commands.catalog`).
- **Usage** : jetons et coût estimé par jour et par modèle, tirés des messages (« This week », « Last 30 days »).
- **Connexions / Réseau** : serveurs MCP (liste sans secrets, activer, couper, supprimer, tester) ; groupes d'outils comme connexions ; état des cinq messageries
  (en lecture : les activer se fait dans l'écran « Passerelles » de Jarod, qui demande les jetons).
- Vérifié avec un VRAI modèle local (Ollama, `qwen3.5:0.8b`, démonstration `JAROD_DEMO_OLLAMA`) : la conversation se déroule, le modèle connaît le prénom du profil, et appelle
  `system_info` (résultat réel). Le très petit modèle se trompe d'unité en recopiant la mémoire (« 36,65 TB ») : c'est le modèle, pas l'outil.

## Ce qui n'est pas servi (consigné par la passerelle dans `gateway.log`)

`client.capabilities`, `usage.bars` et `billing.state` (plan du fournisseur : sans objet pour Jarod), OAuth des serveurs MCP, catalogue MCP,
Studio, voix en flux, clarification (`clarify`). Les pages concernées affichent « indisponible » ou vide.

## Limites connues

- L'historique (Hermes › Sessions…) est vérifié en interface : liste, titres, reprise du transcript (avec la passerelle de démonstration). Il n'est pas
  encore essayé avec un vrai modèle sur de longues conversations.
- `system_find_files` cherche par le NOM seulement (le contenu des fichiers n'est pas lu) ; `find_files` de Jarod reste confiné au dossier de travail.
- « Run now » ne répond qu'à la fin de l'exécution (au plus 30 s) : Herald ne relit la liste qu'une fois, et la conversation de l'exécution n'existe qu'à la
  fin. Une exécution plus longue continue seule ; son historique apparaît à la prochaine ouverture de la page. Les exécutions d'une automatisation s'ajoutent à
  UNE conversation : « Recent runs » n'a qu'une ligne par automatisation.
- Le sélecteur de modèles de Herald (Réglages › Hermes & agents) : avec une conversation ouverte il envoie `/model fournisseur:modèle` ; la passerelle le traduit en
  `fournisseur/modèle`, la forme que la commande de Jarod lit (sans cela le fournisseur ne changeait pas). Sans conversation ouverte il envoie `config.set model`,
  que la passerelle applique (modèle par défaut des nouvelles conversations). Le Hermes d'origine refuse ce cas (« config.set model requires a live session ») :
  le shell retombe alors sur l'ancien message « Open a session first ». Ce choix sans conversation est une modification du shell (dépôt Herald, `AgentsSection.tsx`).
- Un très petit modèle choisit mal ses outils ; un modèle plus capable est conseillé pour le pilotage (Réglages › Hermes & agents).
- Windows 10 et Windows non francophone non testés.
