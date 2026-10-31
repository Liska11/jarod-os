# Parité Jarod-OS ↔ jarod-cordis

Objectif posé par l'utilisateur : Jarod-OS retrouve **tout** ce que fait l'application jarod-cordis, sous l'interface du shell (dérivée de Herald OS), sans dépendre de jarod-cordis.
Ce fichier suit l'avancement ; il est tenu à jour à chaque bloc livré. Le noyau (`jarod-core`) contient déjà les plugins de cordis : ce qui manque est
l'**accès** (route de la passerelle + écran du shell) et, pour trois fonctions, un **hôte** que seule l'application Electron de cordis fournissait.

Légende : ✅ fait et vérifié en fenêtre · 🟡 partiel · ⬜ à faire · ⛔ écarté (décision de l'utilisateur)

| # | Fonction (cordis) | État | Où / remarque |
|---|---|---|---|
| 1 | Conversation en flux, accords d'outils, historique | ✅ | passerelle `session.*`, cartes d'accord |
| 2 | Outils Windows (70, dont 14 système) | ✅ | |
| 3 | Mémoire (MEMORY.md / USER.md) | ✅ | `/api/memory/files` |
| 4 | Automatisations cron (création, Run now) | ✅ | `/api/cron/*` |
| 5 | Usage, serveurs MCP (liste, activer, tester, retirer) | ✅ | `/api/analytics/usage`, `/api/mcp/*` |
| 6 | Sélecteur de modèle (+ découverte LM Studio / Ollama) | ✅ | `model.options`, `config.set` |
| 7 | **Fournisseurs et clés API** (coffre, source env, clés de secours, adresse, test) | ✅ | `/api/jarod/providers*`, Réglages → « Providers & keys » (`gateway/providers.ts`) |
| 8 | Modèles locaux : moteur llama.cpp, préréglages, téléchargement Hugging Face, charger/décharger LM Studio | ✅ | Réglages → « Local models » ; canaux `local-models-*`, `local-engine-*`, `hf-*` du pont. Vérifié en fenêtre : liste réelle de LM Studio, recherche et « tient-il ? » sur huggingface.co. Non essayés en fenêtre (boîtes natives, téléchargements) : installation du moteur, chargement, téléchargement ; couverts par les tests du pont |
| 9 | Navigateur de l'agent (`browser_*`) | ✅ | Hôte Electron (`electron/agent-browser`, copié de cordis : fenêtre isolée, web public seulement, jamais la machine ni le réseau local, pas de saisie de mot de passe) ; le noyau le pilote par le geste « browser » (`gateway/browser.ts`). Réglages → « Agent & security » : afficher, garder les connexions, oublier. Vérifié en vraie fenêtre Electron : ouvrir example.org, suivre un lien, refus de 127.0.0.1, de file:, d'une touche hors liste ; les outils apparaissent à l'attache (test) |
| 10 | Voix : micro, mot d'éveil, STT/TTS locaux | 🟡 | Fait : conversation vocale de la fenêtre sur le noyau — transcription par le fournisseur des réglages (OpenAI, Groq, serveur local…) et voix de la machine (SAPI, Piper) rendue en WAV par `/api/audio/*` ; Réglages → « Voice » montre les réglages du noyau. Vérifié : voix réelle (Hortense) rendue en WAV par la passerelle ; transcription non essayée avec un vrai fournisseur (la clé OpenAI de l'environnement n'a pas été utilisée). Pas encore : mot d'éveil et capture continue (modèles OpenVINO non embarqués), voix en flux phrase par phrase (repli : réponse entière), GPT-Live |
| 11 | Skills (écran, hub d'installation) | ✅ | Réglages → « Skills » : installées (activer/couper, lire, archiver) + registre communautaire (skills, serveurs MCP, agents) avec confirmation native. Vérifié en fenêtre : liste, bascule, 349 entrées du registre |
| 12 | Persona / Soul, profils multiples | ✅ | Réglages → « Persona & profiles » : SOUL.md, profils (créer, nom, couleur, retirer, activer = relance du moteur). Persona vérifiée en fenêtre ; l'activation d'un profil n'est pas essayée en fenêtre (relance du moteur) |
| 13 | Messageries : configuration (jetons Telegram, Discord, Slack, WhatsApp, e-mail) | ✅ | Réglages → « Messaging » : champs, jetons au coffre (jamais relus), interrupteurs, démarrer/arrêter. Jeton enregistré vérifié en fenêtre ; aucune passerelle activée (pas de connexion réelle essayée) |
| 14 | Règles d'accord (« Toujours » par outil, politiques) | ✅ | Réglages → « Agent & security » : règles ordonnées, outils « toujours », garde du shell, budget, mode, repli de modèles |
| 15 | Kanban | ✅ | Page « Kanban » (dock) : colonnes par statut, tâches, détails (commentaires, exécutions), actions, « Run next » (une tâche à la main, jamais de minuteur), dossier de tâche choisi en boîte native. Tâche créée en fenêtre ; « Run next » non lancé (il ferait travailler le vrai modèle) |
| 16 | RAG : indexation et documents | ✅ | Réglages → « Documents » : interrupteur, serveur et modèle d'embeddings (un modèle local de LM Studio/Ollama convient), tailles, état de l'index, réindexation avec confirmation. Réglage vérifié en fenêtre ; réindexation non essayée |
| 17 | Automatisations avancées : webhooks, déclencheurs, workflows | ✅ | Réglages → « Automation rules » : règles (déclencheur cron / webhook / manuel, actions agent / notification / appel web), exécuter, activer, plugins utilisateur (activer, classer les outils). Règle créée en fenêtre. Le serveur de webhooks entrants n'a pas de réglage dans le noyau : un déclencheur webhook ne tire que s'il est activé dans le profil |
| 18 | Agents / sous-agents | ✅ | Les « agents » de cordis sont les profils : voir « Persona & profiles » |
| 19 | Sauvegarde / restauration, portabilité | ✅ | Réglages → « Data & folders » : sauvegarde vérifiée, import (fusion) ou restauration dans un profil neuf, dossier de travail (choisi en boîte native ; l'emporte sur `JAROD_WORKSPACE`). Boîtes natives non essayées en fenêtre |
| 20 | Mises à jour du noyau | ⛔ | Le plugin `updates` interroge le canal de Jarod-One ; Jarod-OS n'a pas encore de canal de publication. Les canaux sont servis par le pont mais aucun écran ne les montre (une page qui proposerait de mettre à jour vers un autre produit serait fausse) |
| 21 | Hôtes SSH, serveur API compatible OpenAI, appairage mobile / distant | ✅ | Réglages → « Devices & API » (API : clé montrée une fois, hôte, port ; pont téléphone : code d'appairage, révocation ; adb ; hôtes SSH par clé choisie en boîte native), « Secrets » (coffre de l'agent), « MCP servers » (ajouter / modifier). Clé d'API vérifiée en fenêtre ; ouverture de ports et boîtes natives non essayées |
| 22 | Embeddings, reranker, OpenVINO / NPU, onnxruntime, node-pty | ⛔ | non embarqués (décision d'indépendance) ; reprise possible plus tard |
| 23 | Authentification Nous native (device-code) | ⛔ | reportée, avec audit de sécurité ; clé API en attendant |

## Décisions d'architecture (plan Hermes / Brahma Evo)

Le détail, les exigences de test et le dossier H9 sont dans `docs/DECISIONS-HERMES-BRAHMA.md` ; le plan dans `docs/PLAN-INTEGRATION-HERMES-BRAHMA.md`.
Enregistrées le 2026-10-31, commit « record: décisions D1-D8 tranchées, H9 documentée » (`git log --grep "record: décisions D1-D8"`).

| ID | Décision | État |
|---|---|---|
| D1 | Idées seulement : aucun code de Brahma Evo ni de Hermes, contrôlé à chaque lot | tranchée |
| D2 | Voix en direct : Gemini Live activé par défaut, indicateur permanent (orbe de couleur dédiée), repli automatique et en un clic sur la chaîne locale | tranchée |
| D3 | `self_describe` en lecture seule ; modification de compétences et plugins utilisateur uniquement sur demande explicite, en worktree, activation après « oui », retour arrière en un clic, audit | tranchée |
| D4 | Images : ComfyUI local d'abord, cloud en option coupée, sortie confinée au dossier de travail, accord avant écriture | tranchée |
| D5 | Domotique non requise (B5 écarté) | tranchée |
| D6 | Mises à jour : dossier local signé, signature vérifiée avant installation, aucun canal en ligne | tranchée |
| D7 | Pont Android : l'appli `mobile/` existe, on la fait évoluer ; « go » avant toute installation sur le téléphone | tranchée |
| D8 | Instagram intégré à Jarod (portée à préciser avant le lot B7) ; achats : comparaison de prix en lecture seule seulement | tranchée, portée de B7 à préciser |
| H9 | OAuth : possible, désactivé par défaut, activation par service, coupure en un clic qui efface le jeton. Options A/B/C documentées | **ouverte** (en attente de ton arbitrage, rien d'implémenté) |

## Écarts restants avec Hermes et Brahma Evo

⬜ à faire · 🟡 en cours · ✅ fait et vérifié en fenêtre · ⛔ écarté. Détail et tailles : `docs/PLAN-INTEGRATION-HERMES-BRAHMA.md`.

| ID | Écart | État |
|---|---|---|
| H1 | Progression des sous-agents | ⬜ |
| H2 | `clarify` (question à choix) | ⬜ |
| H3 | Voix phrase par phrase | ⬜ |
| H4 | Mot d'éveil | ⬜ |
| H5 | Studio | ⬜ (essai de la phase 0) |
| H6 | Barres d'usage | ⬜ |
| H7 | `client.capabilities` | ⬜ |
| H8 | Voix en direct (fusionné avec B1) | ⬜ |
| H9 | OAuth | ⬜ décision ouverte |
| H10 | Mises à jour (dossier local signé, D6) | ⬜ |
| H11 | `todo` / `todo.updated` | ⬜ |
| H12 | Embeddings locaux, reranker, NPU | ⛔ |
| B1 | Voix native bidirectionnelle (Gemini Live) | ⬜ |
| B2 | Création Word / Excel / PowerPoint / PDF | ⬜ |
| B3 | Fabrique de compétences (D3) | ⬜ |
| B4 | Auto-réparation (D3) | ⬜ |
| B5 | Domotique | ⛔ (D5) |
| B6 | Spotify | ⬜ (dépend de H9) |
| B7 | Instagram | ⬜ (D8, portée à préciser) |
| B8 | Génération d'images (D4) | ⬜ |
| B9 | Envoi YouTube | ⬜ (dépend de H9) |
| B10 | Pont téléphone complet (appli `mobile/` existante, D7) | ⬜ |
| B11 | Surveillants / déclencheurs système | ⬜ |
| B12 | Assistant de réunion | ⬜ |
| B13 | Surveillance proactive | ⬜ |
| B14 | Carte, vols, itinéraires | ⬜ |
| B15 | Assistant de circuits | ⬜ |
| B16 | Calories, pompes | ⬜ |
| B17 | Achats : comparaison de prix en lecture seule seulement (D8) | ⬜ |
| B18 | Spectre audio et états de l'orbe | ⬜ |
| B19 | Latence par outil, tiroir « Inspecter » | ⬜ |
| B20 | Google Workspace | ⬜ (dépend de H9) |

## Architecture du pont

`packages/bridge` (`@jarod/bridge`) reprend les handlers de l'application jarod-cordis (mêmes validations, mêmes refus) ; la passerelle les sert par `jarod.invoke` (WebSocket, sans le délai de 60 s de l'HTTP) et `POST /api/jarod/invoke`. Les événements des handlers arrivent à la fenêtre en `jarod.event`, les gestes natifs (boîte « Ouvrir », confirmation) sont des requêtes `jarod.shell` que la fenêtre fait exécuter par le processus principal (`electron/ipc/jarod-shell*.ts`). Chaque fonction restante du tableau est donc surtout un écran du shell sur des canaux qui existent déjà.

## Écarts voulus par rapport à jarod-cordis

- `cli/src/context.ts` : `settings.secretKeys()` listait seulement la clé principale des fournisseurs ayant une variable d'environnement. Il liste maintenant tout le
  coffre lisible (tous les fournisseurs, clés de secours comprises) plus les clés de l'environnement, et `settings.keySources()` dit d'où vient chaque clé.
  Sans cela, une clé de Nous, z.ai ou Qwen n'était jamais vue : fournisseur « non configuré », absent du sélecteur de modèles.
