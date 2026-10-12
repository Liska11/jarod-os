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
| 8 | Modèles locaux : moteur llama.cpp, préréglages, téléchargement Hugging Face, charger/décharger LM Studio | ⬜ | plugin `llm` (`engine`, `localModels`, `huggingface`) |
| 9 | Navigateur de l'agent (`browser_*`) | ⬜ | hôte Electron à écrire (`BrowserPort`) |
| 10 | Voix : micro, mot d'éveil, STT/TTS locaux | ⬜ | plugin `voice` ; routes `/api/audio/*`, `wake.*` |
| 11 | Skills (écran, hub d'installation) | ⬜ | plugin `skills` |
| 12 | Persona / Soul, profils multiples | ⬜ | plugin `persona` |
| 13 | Messageries : configuration (jetons Telegram, Discord, Slack, WhatsApp, e-mail) | 🟡 | état en lecture seule ; écriture à faire (jetons au coffre) |
| 14 | Règles d'accord (« Toujours » par outil, politiques) | 🟡 | seul « Ask first » est réglable |
| 15 | Kanban | ⬜ | plugin `kanban` |
| 16 | RAG : indexation et documents | ⬜ | plugin `rag` |
| 17 | Automatisations avancées : webhooks, déclencheurs, workflows | ⬜ | plugins `scheduler`, `automation`, `workflows` |
| 18 | Agents / sous-agents | ⬜ | |
| 19 | Sauvegarde / restauration, portabilité | ⬜ | plugin `memory` (portability) |
| 20 | Mises à jour du noyau | ⬜ | plugin `updates` |
| 21 | Hôtes SSH, serveur API compatible OpenAI, appairage mobile / distant | ⬜ | |
| 22 | Embeddings, reranker, OpenVINO / NPU, onnxruntime, node-pty | ⛔ | non embarqués (décision d'indépendance) ; reprise possible plus tard |
| 23 | Authentification Nous native (device-code) | ⛔ | reportée, avec audit de sécurité ; clé API en attendant |

## Écarts voulus par rapport à jarod-cordis

- `cli/src/context.ts` : `settings.secretKeys()` listait seulement la clé principale des fournisseurs ayant une variable d'environnement. Il liste maintenant tout le
  coffre lisible (tous les fournisseurs, clés de secours comprises) plus les clés de l'environnement, et `settings.keySources()` dit d'où vient chaque clé.
  Sans cela, une clé de Nous, z.ai ou Qwen n'était jamais vue : fournisseur « non configuré », absent du sélecteur de modèles.
