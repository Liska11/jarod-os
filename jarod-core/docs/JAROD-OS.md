# Jarod-OS

Jarod-OS est l'interface dérivée de **Herald OS** (renommée Jarod-OS ; le shell : fenêtre, dock, pages Aperçu, Mémoire, Automatisations, Réglages…) posée sur le **noyau de Jarod-cordis**
(conversation, outils, mémoire, planifications). Herald croit parler à son moteur `hermes serve` ; en réalité c'est la passerelle de ce dépôt
(`packages/cli/src/gateway/`) qui lui répond avec le noyau de Jarod. Aucune modification du shell n'est nécessaire pour la conversation, les accords d'outils
et les automatisations ; la page Mémoire de Herald a reçu un adaptateur (branche `feature/windows-port` du dépôt Herald, commit « Memory page: read and write
through the backend… »).

## Lancer

```
scripts\Jarod-OS.cmd [--workspace D:\JAROD-OS] [--data <dossier>] [--real-profile] [--herald "<Jarod-OS.exe>"]
```

Le lanceur (`packages/cli/src/gateway/launch.ts`) : (1) prépare le profil, (2) démarre la passerelle et attend qu'elle soit prête, (3) lance l'application Jarod-OS
avec l'adresse et le jeton de la passerelle, (4) arrête la passerelle quand la fenêtre se ferme (ou si le lanceur meurt : elle ne reste jamais orpheline).

| Option | Défaut | Rôle |
|---|---|---|
| `--workspace` (ou `JAROD_WORKSPACE`) | `D:\JAROD-OS` | dossier de travail de TOUTES les conversations ; les outils fichiers de Jarod s'y confinent |
| `--data` (ou `JAROD_OS_DATA`) | `%LOCALAPPDATA%\Jarod-OS` | données de Jarod-OS : `profile\`, `herald-home\`, `herald-userdata\`, `gateway.log` |
| `--herald` (ou `HERALD_OS_EXE`) | `…\herald-os\apps\desktop\release\win-unpacked\Jarod-OS.exe` | l'application Jarod-OS empaquetée (`npm run dist:win` dans le dépôt Herald) |
| `--real-profile` | non | ouvre le profil RÉEL de Jarod (fournisseurs, mémoire, planifications) au lieu du profil de Jarod-OS |

Données : Herald reçoit son propre `HERMES_HOME` et son propre dossier utilisateur (`--user-data-dir`) : il ne partage rien avec une installation de Herald ou de
Hermes existante, et peut tourner à côté d'elle.

### Profil

Par défaut Jarod-OS a **son profil** (créé au premier lancement) : il ne touche pas aux données de l'application Jarod. Il est vide : pour parler à un vrai
modèle, donner une clé par l'environnement avant de lancer (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`… : la liste est `ENV_KEYS`
dans `packages/cli/src/context.ts`), ou utiliser un serveur local (Ollama, LM Studio), puis choisir le modèle dans Réglages › Hermes & agents.
`--real-profile` ouvre à la place le profil réel de Jarod : tout ce qu'il contient est alors disponible, mais le verrou du profil interdit de lancer en même temps
l'application Jarod, et les conversations, la mémoire et les planifications créées d'ici apparaissent dans Jarod.

La passerelle tourne avec le cœur complet (`--init` : verrou du profil, tick du planificateur, MCP, passerelles de messagerie) : les automatisations se
déclenchent seules tant que Jarod-OS est ouvert.

## Vérifier le sélecteur de modèles

```
powershell -ExecutionPolicy Bypass -File scriptserify-jarod-os.ps1
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
