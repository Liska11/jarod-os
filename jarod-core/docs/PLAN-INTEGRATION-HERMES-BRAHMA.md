# Plan d'intégration : ce que Hermes et Brahma Evo font et que Jarod-OS ne fait pas encore

Rédigé le 2026-10-31. Sources : `PARITY.md`, `jarod-os-seam.md`, `gateway/unavailable.ts`, le README et la liste des modules de Brahma Evo
(`D:\Brahma_Evo\_internal`, lus, pas audités ligne à ligne), l'état du dépôt à la révision `1349b4b`.

Légende des tailles (estimations grossières, une personne qui connaît le code) : **S** ≈ ½ à 1 jour · **M** ≈ 2 à 4 jours · **L** ≈ 1 à 2 semaines.
Légende des risques : **faible** (interface ou lecture) · **moyen** (écrit des fichiers, appelle un service) · **élevé** (agit sur la machine, sur un compte, ou sur le code de Jarod).

## 1. Règles qui valent pour tout ce qui suit

1. **Les idées, pas le code.** Brahma Evo est un dépôt public d'un tiers. On reprend des principes (comme au lot 4 du 30/10), on ne copie aucun fichier. Même règle pour Hermes.
2. **Local d'abord.** Tout ce qui envoie des données à un service (Gemini Live, génération d'image, Spotify…) est un réglage coupé par défaut, nommé dans l'interface, avec le mode « 100 % local » intact.
3. **Chaque outil nouveau** : classé dans `tests/repo/effect-paths.ts` ; `dangerous: true` dès qu'il écrit, envoie ou agit ; un `precheck` qui dit la cible dans la demande d'accord ; journal d'audit ; test avec une mutation qui le fait échouer.
4. **Le nombre d'outils.** Il est déjà à 128 (le plafond des fournisseurs). Au-delà de 120 la recherche d'outils prend le relais (`MAX_TOOLS_PER_REQUEST`). Les outils ajoutés doivent donc être **groupés par domaine et trouvables par `tool_search`** (noms et descriptions soignés), jamais tous annoncés au modèle à chaque tour.
5. **Rien n'est installé sans ton « go »**, et rien n'est poussé. Un lot = un ou plusieurs commits locaux + suites de tests vertes + un build.
6. **Auto-modification** (fabrique de compétences, auto-réparation) : jamais d'écriture dans le noyau, jamais d'activation sans ton accord, toujours un retour en arrière (voir B3, B4).

## 2. Inventaire des écarts

### 2.1 Hermes (le moteur d'origine de l'interface)

| ID | Écart | État actuel dans Jarod | Travail | Taille | Risque |
|---|---|---|---|---|---|
| H1 | **Progression des sous-agents** (`subagent.spawn_requested/start/progress/thinking/tool/complete`) | Les sous-agents existent (`delegate_task`, `spawn_subagent`) ; le traducteur de la passerelle ne mappe que `stream-start, delta, tool-start, message, status, error, done` | Émettre des événements depuis `agent/src/subagents.ts` ; les traduire dans `protocol.ts` ; vérifier que l'interface les affiche | M | faible |
| H2 | **`clarify`** : l'agent pose une question à choix dans l'interface | Absent (aucun traitement dans la passerelle). L'interface a déjà un emplacement (`Attention.tsx`, `connections-model.ts`) | Outil `ask_user` côté noyau ; requête serveur→shell `clarify` et sa réponse ; reprise du tour ; délai et annulation | M | faible |
| H3 | **Voix en flux phrase par phrase** (`/api/audio/speak-stream`) | La route répond « repli » ; la réponse est lue en entier | Découper la réponse en phrases pendant qu'elle arrive ; chaîne TTS (`voice/src/tts-chain.ts`) appelée par phrase ; lecture à la file côté interface | M | faible |
| H4 | **Mot d'éveil** (`wake.start/stop/pause/resume/feed`) | Le plugin `voice/src/wakeword*.ts` existe (OpenVINO) ; les modèles ne sont pas embarqués ; la passerelle répond « non disponible » | Brancher `wake.*` sur le plugin ; télécharger le modèle **à la demande, avec ton accord** ; capture continue du micro dans le shell ; indicateur « j'écoute » toujours visible | M | moyen (micro ouvert) |
| H5 | **Studio** (construire une appli avec terminal et aperçu) : `preview.open`, `agent.terminal.output`, `terminal.close`, `tool.generating` | Écran présent dans le shell, sans source de données côté Jarod | **D'abord un essai de 1 jour** pour mesurer ce qui s'affiche vraiment. Puis : terminal intégré (pty ou processus), serveur d'aperçu local, événements | L | moyen |
| H6 | **Barres d'usage et forfait** (`usage.bars`, `billing.state`) | « Non disponible » | Pas d'abonnement à montrer. Proposer à la place : barres du **budget de session** et des jetons par fournisseur (données déjà dans `usage.ts`) | S | faible |
| H7 | **`client.capabilities`** | « Non disponible » | Répondre avec la liste de ce que la passerelle sait faire (le shell l'attend optionnelle) | S | faible |
| H8 | **GPT-Live / voice-live** | Absent | Fusionné avec B1 : un seul moteur de « voix en direct » avec plusieurs fournisseurs | voir B1 | moyen |
| H9 | **Connexion par compte (OAuth)** : compte Nous, fournisseurs, serveurs MCP | Écarté, « reporté avec audit de sécurité » | Audit puis flux « code d'appareil » ; stockage des jetons au coffre (jamais relus par l'interface) ; sert aussi B6, B9, B24 | M | élevé |
| H10 | **Mises à jour du noyau** | Plugin `updates` branché sur le canal de Jarod-One, aucun canal pour Jarod-OS | Décision D6. Variante sans serveur : mise à jour depuis un dossier local de publication, signature vérifiée | M | moyen |
| H11 | **Outil `todo` / événement `todo.updated`** (page Missions) | À vérifier : Jarod a `state_*`, `task_status`, le Kanban, mais le document de couture notait « aucun outil todo » | Contrôler ; si absent, un outil `todo` qui écrit dans l'état de la conversation et émet `todo.updated` | S | faible |
| H12 | Embeddings locaux, reranker, NPU | Écartés (indépendance) | Rien. LM Studio / Ollama servent déjà d'embeddings via « Documents ». À rouvrir seulement si tu le demandes | — | — |

### 2.2 Brahma Evo

| ID | Écart | État actuel dans Jarod | Travail | Taille | Risque |
|---|---|---|---|---|---|
| B1 | **Voix native bidirectionnelle** (Gemini Live, < 500 ms) avec vision webcam et écran en flux | Chaîne micro → texte → modèle → voix (STT Groq/Gemini/local, TTS ElevenLabs/Gemini/local) | Abstraction `LiveVoiceEngine` ; fournisseur Gemini Live en WebSocket ; coupure de la voix quand tu parles ; outils appelables pendant la conversation (avec les mêmes accords) ; repli automatique sur la chaîne actuelle | L | moyen (audio et image partent chez Google) |
| B2 | **Création de documents Word, Excel, PowerPoint, PDF** | Lecture seule (docling, markitdown) | Outils `office_docx`, `office_xlsx`, `office_pptx`, `pdf_*` sur des bibliothèques locales ; écriture **confinée au dossier de travail** ; accord ; aperçu dans le volet Artefacts | M | moyen |
| B3 | **Fabrique de compétences** (« Crucible ») : il écrit un outil, le teste en bac à sable, l'enregistre | `skill_manage`, hub de compétences, `capability.*` (évaluer, intégrer, retour arrière), curator | Cycle complet **sous accord** : écrire dans un worktree ; tester dans Sandboxie (réseau coupé) ; montrer le diff et les résultats ; **n'activer qu'après ton « oui »** ; retour arrière en un clic | L | élevé |
| B4 | **Auto-réparation** (lit ses exceptions, corrige le code) | Rien d'équivalent. Existent : `refine`, `refine_rollback`, `deps.*` (à vérifier avant de concevoir) | Limité au code **des compétences et plugins utilisateur**, jamais au noyau. Une exception répétée → l'agent propose un correctif sous forme de diff dans un worktree ; tu l'appliques ou non | L | élevé |
| B5 | **Domotique** (Tuya, Home Assistant) | Absent | Intégration dédiée avec **liste d'hôtes du réseau local autorisés** (le garde réseau actuel refuse tout hôte privé, à juste titre). Home Assistant d'abord (API REST + jeton au coffre) ; Tuya ensuite | M | moyen |
| B6 | **Spotify** (lecture, recherche, file, appareils) | Touches multimédia Windows seulement | Serveur MCP Spotify ou API Web avec PKCE ; dépend de H9 pour les jetons | M | moyen |
| B7 | **Instagram** (messages) | Absent ; Jarod a Telegram, Discord, Slack, WhatsApp, e-mail | **Non recommandé** (conditions d'utilisation, risque de blocage du compte). À écarter sauf demande | — | élevé |
| B8 | **Génération d'images** | Absent | Outil `image_generate` : fournisseur au choix (Gemini, OpenAI, ou ComfyUI local) ; fichier écrit dans le dossier de travail ; D4 | S | moyen |
| B9 | **Envoi de vidéos YouTube** | Téléchargement seul (`media_fetch`) | OAuth Google (H9) puis un outil d'envoi sous accord. Faible priorité | M | élevé |
| B10 | **Brahma Connect** : filtrage d'appels, SMS, position, batterie du téléphone | `android_shell`, `android_devices`, appairage du pont téléphone | **Application Android compagnon** à écrire (projet séparé). Étape 1 sans appli : position, batterie et SMS lus par adb. Étape 2 : l'appli | L+ | élevé |
| B11 | **Surveillants** (jeux, réseau, révisions, attention) | Automatisations : déclencheurs cron, manuel, dossier | **Déclencheurs système** : processus lancé ou fermé, réseau changé, inactivité, fenêtre active. Chaque surveillant devient une règle + une action (notification, agent) | M | moyen |
| B12 | **Assistant de réunion** (transcription + résumé) | Briques présentes : STT, résumé par le modèle | Capture du son système (loopback) ou micro ; transcription au fil de l'eau ; compte rendu enregistré en mémoire ; bandeau « enregistrement en cours » obligatoire | M | élevé (vie privée) |
| B13 | **Surveillance proactive et « anticipatoire »** | Absent | Opt-in strict : règles qui regardent le contexte (agenda, fenêtre active, heure) et proposent, jamais n'agissent seules. Données locales uniquement | M | moyen |
| B14 | **Globe 3D, radar de vols, itinéraires, lieux proches** | Absent | Volet « Carte » (MapLibre) ; vols via un service ouvert (OpenSky) ; lieux via Overpass. Faible priorité | M à L | faible |
| B15 | **Assistant de montage de circuits** (Arduino, ESP32, capteurs) | Absent | Plutôt une **compétence** : reconnaissance par la vision (`screen_look`), schéma de câblage généré en SVG dans le volet Artefacts (`present`, `diagram_export` existent) | S à M | faible |
| B16 | Compteur de calories, de pompes (vision) | Absent | Compétences + webcam. Très faible priorité | M | faible |
| B17 | **Agent d'achats** | Absent | **À écarter** : acheter est une action financière que l'agent ne doit pas faire seul. Au mieux, comparer des prix (lecture) | — | élevé |
| B18 | **Spectre audio et états lumineux** (l'orbe change de couleur selon : écoute, réflexion, outil, muet) | `VoiceOrb.tsx` existe | Ajouter l'analyse de fréquence au micro et les 5 états de couleur | S | faible |
| B19 | **Suivi visuel de l'exécution** (puces de latence, tiroir « Inspecter ») | Onglet Activité et journal d'audit par tour | Ajouter la durée de chaque outil et un tiroir « paramètres / résultat brut » | S | faible |
| B20 | Calendrier Google, Gmail, Drive | Agenda local seulement | Intégration Google Workspace après H9 | M | élevé |

Déjà couvert et donc **hors plan** : centre de réglages avec test de connexion (Réglages → Fournisseurs), pont vers Claude Code (`cli_agent_run`), mémoire à long terme et profil, nettoyage d'espace disque (`system_disk_usage`, rangement de dossier), envoi de messages (passerelles), analyse de binaires (REA, Ghidra), météo, agenda, briefing, débit Internet.

## 3. Ordre de réalisation

Le critère : d'abord ce qui est utile tout de suite et sans risque, ensuite ce qui partage une brique commune, en dernier les gros chantiers et ce qui touche à des comptes.

### Phase 0 : vérifications (1 à 2 jours, aucune ligne de produit)
- Essai d'une journée sur le **Studio** (H5) : qu'affiche l'écran avec des événements simulés ; décision de le faire ou non.
- Contrôler **H11** (`todo`), **B4** (ce que fait réellement `refine`) et le **modèle de mot d'éveil** (H4 : quel fichier, quelle taille, quelle licence).
- Ajouter ce tableau dans `PARITY.md` (une ligne par ID, état ⬜).
- **Sortie** : chaque ID a un état vérifié ; D1 à D8 tranchées (voir §5).

### Phase 1 : gains rapides, interface et passerelle (≈ 2 semaines)
H7, H6, H11, H1, H2, B18, B19, puis **B2** (documents Office et PDF).
- Brique commune : le traducteur d'événements de la passerelle (H1, H2, H11 y passent tous).
- **Critère** : une phrase « fais-moi un tableau Excel des dépenses de mars » produit un `.xlsx` ouvrable dans le dossier de travail, après un accord qui nomme le fichier ; un sous-agent lancé montre sa progression ; une question à choix de l'agent s'affiche et sa réponse reprend le tour.

### Phase 2 : la voix (≈ 3 semaines)
H3 (flux par phrase) → H4 (mot d'éveil) → **B1 + H8** (moteur de voix en direct).
- Brique commune : un moteur de voix à fournisseurs interchangeables avec repli (la chaîne actuelle reste le repli et le mode 100 % local).
- **Critère** : première syllabe de la réponse en moins de 1,5 s en flux par phrase ; « Jarod » réveille l'écoute sans appui, avec indicateur visible et coupure en un clic ; en mode Gemini Live, interrompre la voix en parlant la coupe en moins de 500 ms ; le réseau coupé retombe sur la chaîne locale sans message d'erreur.

### Phase 3 : autonomie encadrée (≈ 3 semaines)
B11 (déclencheurs système) → B13 (proactif) → B12 (réunion) → **B3** (fabrique) → **B4** (auto-réparation).
- Brique commune : les déclencheurs système (B11) servent B13 ; le worktree + Sandboxie servent B3 et B4.
- **Critère** : une compétence forgée n'est jamais active avant ton « oui », son diff et ses tests sont visibles, le retour arrière la retire entièrement ; aucune action de B3 ou B4 ne peut écrire hors du dossier du worktree (test avec une tentative d'évasion qui doit échouer).

### Phase 4 : connexions externes (≈ 3 semaines)
**H9** (OAuth, après audit) → B6 (Spotify) → B20 (Google) → B9 (YouTube) ; en parallèle B5 (domotique) et B8 (images).
- **Critère** : aucun jeton n'apparaît dans l'interface, un journal ou un export de sauvegarde ; chaque service se coupe en un clic et son jeton est effacé du coffre.

### Phase 5 : grands chantiers (à ordonner selon ton usage)
H5 (Studio, si l'essai de la phase 0 le justifie) · B10 (appli Android compagnon) · B14 (carte) · B15/B16 (compétences de vision).

### Phase 6 : distribution
H10 (mise à jour du noyau) une fois D6 tranchée.

## 4. Pour chaque lot, la même liste de contrôle

1. Tests unitaires et un test de bout en bout sur le vrai noyau (profil temporaire).
2. Au moins une **mutation** qui casse la garantie de sécurité et doit faire échouer un test (accord, confinement, jeton).
3. Classement dans `effect-paths.ts` ; le garde du dépôt reste vert pour les outils du lot.
4. Textes en français et en anglais (`fr.ts`, `en.ts`).
5. Vérification dans la vraie fenêtre (build installé, ton « go » avant), puis case cochée dans `PARITY.md`.
6. Un commit par lot, message qui dit le comportement et non les fichiers.

## 5. Décisions qu'il faut que tu prennes

> **Mise à jour du 2026-10-31 :** D1 à D8 sont tranchées par le propriétaire (certaines à l'inverse de ma recommandation : D2, D8) ; H9 reste ouverte. Voir `DECISIONS-HERMES-BRAHMA.md`. Le tableau ci-dessous est conservé tel qu'il avait été posé.

| # | Question | Ma recommandation |
|---|---|---|
| D1 | Brahma : idées seulement, ou aussi des morceaux de code (licence du dépôt à lire d'abord) ? | Idées seulement |
| D2 | Voix en direct : accepter Gemini Live (audio et image envoyés à Google) comme option, coupée par défaut ? | Oui, en option avec le repli local |
| D3 | Auto-modification (B3, B4) : jusqu'où ? | Compétences et plugins utilisateur seulement, toujours sous ton accord, jamais le noyau |
| D4 | Génération d'images : quel fournisseur ? | Un seul au départ (celui dont tu as déjà la clé), ComfyUI local en second |
| D5 | Domotique : quels appareils as-tu, et leur réseau ? | Home Assistant d'abord si tu en as un |
| D6 | Mises à jour : un canal en ligne, ou un dossier local ? | Dossier local signé (rien n'est publié) |
| D7 | Application Android compagnon (B10) : tu la veux vraiment ? | Seulement après la phase 3 ; commencer par adb |
| D8 | Écarter B7 (Instagram) et B17 (achats) définitivement ? | Oui |

## 6. Risques du plan

- **Le nombre d'outils** : B2, B5, B6, B8 et les surveillants ajoutent chacun plusieurs outils. Sans regroupement, chaque tour coûte plus de jetons et le modèle choisit moins bien. Mesure à faire à chaque lot (jetons par requête avant et après).
- **Le micro et la caméra** (H4, B1, B12, B16) : un seul interrupteur général et un indicateur toujours visible, sinon la confiance se perd.
- **Les jetons OAuth** (H9) : c'est la partie qui peut mal tourner ; elle passe par un audit avant tout code.
- **Dérive des estimations** : les tailles supposent que les briques existantes (traducteur d'événements, chaîne vocale, worktrees, Sandboxie) se réutilisent comme prévu. La phase 0 sert à le confirmer avant de s'engager.
