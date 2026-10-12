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
| 9 | Navigateur de l'agent (`browser_*`) | ⬜ | hôte Electron à écrire (`BrowserPort`) |
| 10 | Voix : micro, mot d'éveil, STT/TTS locaux | ⬜ | plugin `voice` ; routes `/api/audio/*`, `wake.*` |
| 11 | Skills (écran, hub d'installation) | ✅ | Réglages → « Skills » : installées (activer/couper, lire, archiver) + registre communautaire (skills, serveurs MCP, agents) avec confirmation native. Vérifié en fenêtre : liste, bascule, 349 entrées du registre |
| 12 | Persona / Soul, profils multiples | ✅ | Réglages → « Persona & profiles » : SOUL.md, profils (créer, nom, couleur, retirer, activer = relance du moteur). Persona vérifiée en fenêtre ; l'activation d'un profil n'est pas essayée en fenêtre (relance du moteur) |
| 13 | Messageries : configuration (jetons Telegram, Discord, Slack, WhatsApp, e-mail) | ✅ | Réglages → « Messaging » : champs, jetons au coffre (jamais relus), interrupteurs, démarrer/arrêter. Jeton enregistré vérifié en fenêtre ; aucune passerelle activée (pas de connexion réelle essayée) |
| 14 | Règles d'accord (« Toujours » par outil, politiques) | ✅ | Réglages → « Agent & security » : règles ordonnées, outils « toujours », garde du shell, budget, mode, repli de modèles |
| 15 | Kanban | ⬜ | plugin `kanban` |
| 16 | RAG : indexation et documents | ⬜ | plugin `rag` |
| 17 | Automatisations avancées : webhooks, déclencheurs, workflows | ⬜ | plugins `scheduler`, `automation`, `workflows` |
| 18 | Agents / sous-agents | ⬜ | |
| 19 | Sauvegarde / restauration, portabilité | ⬜ | plugin `memory` (portability) |
| 20 | Mises à jour du noyau | ⬜ | plugin `updates` |
| 21 | Hôtes SSH, serveur API compatible OpenAI, appairage mobile / distant | ⬜ | |
| 22 | Embeddings, reranker, OpenVINO / NPU, onnxruntime, node-pty | ⛔ | non embarqués (décision d'indépendance) ; reprise possible plus tard |
| 23 | Authentification Nous native (device-code) | ⛔ | reportée, avec audit de sécurité ; clé API en attendant |

## Architecture du pont

`packages/bridge` (`@jarod/bridge`) reprend les handlers de l'application jarod-cordis (mêmes validations, mêmes refus) ; la passerelle les sert par `jarod.invoke` (WebSocket, sans le délai de 60 s de l'HTTP) et `POST /api/jarod/invoke`. Les événements des handlers arrivent à la fenêtre en `jarod.event`, les gestes natifs (boîte « Ouvrir », confirmation) sont des requêtes `jarod.shell` que la fenêtre fait exécuter par le processus principal (`electron/ipc/jarod-shell*.ts`). Chaque fonction restante du tableau est donc surtout un écran du shell sur des canaux qui existent déjà.

## Écarts voulus par rapport à jarod-cordis

- `cli/src/context.ts` : `settings.secretKeys()` listait seulement la clé principale des fournisseurs ayant une variable d'environnement. Il liste maintenant tout le
  coffre lisible (tous les fournisseurs, clés de secours comprises) plus les clés de l'environnement, et `settings.keySources()` dit d'où vient chaque clé.
  Sans cela, une clé de Nous, z.ai ou Qwen n'était jamais vue : fournisseur « non configuré », absent du sélecteur de modèles.
