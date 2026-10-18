# Audit global de Jarod-OS — 2026-10-18

Périmètre : le dépôt `C:\Users\San\herald-os`, branche `feature/windows-port`. Au départ, le HEAD est `309a0d8` et l'arbre de travail est propre. Le dossier `prompt/` est non suivi et préexistant ; il n'a pas été touché.

L'audit précédent, `docs/audit/AUDIT-COMPLET-JAROD-OS-2026-10.md` (16 octobre), couvre :

- les invariants du canal de contrôle ;
- les risques R2 à R9.

Ce rapport ne le recopie pas. Il le complète par :

- l'état du 18 octobre ;
- l'interface lancée réellement ;
- les fondations dont dépendent les huit évolutions demandées dans `prompt/Prompt-Jarod_os-plus.txt`.

Statuts : **confirmé** (preuve reproduite), **hypothèse** (plausible, non reproduite), **corrigé**, **différé**.

## 1. État initial

| Validation | Commande | Résultat |
|---|---|---|
| Types (shell + client) | `npm run typecheck` (racine) | code 0 |
| Lint | `npx biome lint` | code 0, 0 erreur, 597 avertissements, 4 infos |
| Tests unitaires du shell | `npx vitest run` (`apps/desktop`) | 156 fichiers, 1221 réussis, 3 ignorés |
| Build du shell | `npm run build` (`apps/desktop`) | code 0 |
| Tests du noyau | `npm run test:core` | 1 échec, dans `plugins/integrations` (voir A-07). pnpm s'arrête au premier paquet en échec : `cli` et `tests` ont donc été relancés à part (§1.1). |
| e2e (Electron réel, profil jetable) | `npx playwright test` | 33 réussis au dernier commit (`309a0d8`) |

### 1.1 Suites du noyau relancées à part

- `packages/cli` : 43 fichiers ; 461 tests réussis, 1 en échec attendu.
- `tests`, avec `vitest.integration.config.ts` : 26 fichiers, 226 tests réussis.
- Les bancs et portes matériels (`tests/gates`, `tests/bench` : NPU, iGPU, base réelle, Telegram) sont hors de cette configuration. Ils échouent sans leur matériel ou leurs données ; ce n'est pas une régression.

Voir aussi l'annexe A.

### 1.2 Limites de l'environnement

- Pas de second PC : SSH distant réel non testable.
- Pas de disque externe dédié aux essais : un vrai débranchement n'est pas testable sans accord.
- Pas de micro testé en conditions réelles : aucune session vocale réelle n'a été lancée.
- `winget` et Windows Update ne sont jamais lancés en mode installation.
- Aucun profil réel n'est utilisé : les tests vivent dans `%TEMP%\jarod-e2e-*`, supprimés à la fin, ce que vérifie `global-setup`.

## 2. Cartographie

```
Utilisateur
  └─ Shell Electron (apps/desktop)
       ├─ renderer React + nanostores (src/) ── preload (heraldOS.*) ── main (electron/)
       │     pages : Accueil, Jarod (conversation + panneau droit), Missions, Mémoire, Fichiers,
       │             Automatisations, Kanban, Connexions, Réglages ; fenêtres : Terminal, Système, Studio…
       ├─ main : 159 gestionnaires ipcMain.handle, data-root (disque Jarod), sauvegardes, bacs à sable,
       │         environnements, VM WSL, terminal (node-pty), vues web (WebContentsView, partitions isolées),
       │         navigateur d'agent (agent-browser), canal de contrôle (named pipe + jetons, control-authz)
       └─ BackendManager ──ws://127.0.0.1 (jeton par lancement)──▶ Noyau jarod-core (gateway.mjs, Node)
              ├─ agent : executeGuardedTool = porte unique des outils (règles, approbation, journal)
              ├─ outils : fichiers, run_shell, web_search/web_fetch/http_request, navigateur, ssh, système, coffre
              ├─ llm/gateways : fournisseurs locaux (llama, LM Studio, Ollama) et cloud
              ├─ storage : jarod.db chiffrée (SQLCipher, clé DPAPI sous Windows), réglages, coffre
              ├─ mémoire / RAG / embeddings, planificateur, MCP, intégrations (OAuth), voix (STT/TTS)
              └─ passerelle /api/audio/transcribe et /api/audio/speak (pas de speak-stream)
```

### 2.1 Propriétaires des données

| Donnée | Propriétaire | Où |
|---|---|---|
| Préférences du shell | main (`prefs.ts`) | `%APPDATA%\Jarod-OS\config\prefs.json` (ou `HERALD_OS_CONFIG_DIR`) |
| Choix du disque | main (`data-root.ts`) | `config\data-location.json` |
| Profil du noyau, conversations, mémoire, coffre | noyau (storage) | `JAROD_OS_DATA` (`data\`) |
| Fichiers de travail | utilisateur | `JAROD_WORKSPACE` |
| Sessions des sites (panneau droit) | Electron | partitions dans `%APPDATA%\Jarod-OS` |

### 2.2 Capacités

| Capacité | État | Preuve |
|---|---|---|
| Conversation, outils, approbations | fonctionnelle et vérifiée (unitaire + e2e shell) | `agent.ts:executeGuardedTool`, `e2e/shell.spec.ts` |
| Disque Jarod, sauvegardes locales, bacs à sable, environnements | fonctionnels et vérifiés (e2e réel) | `e2e/jarod-disk.spec.ts` |
| VM WSL | implémentée, vérifiée en lecture seule | installation et déplacement non lancés réellement |
| Coffre de secrets | fonctionnel côté noyau ; l'agent ne voit que les noms | `bridge/handlers/vault.ts`, `tools/vault-tools.ts`, tests `vault.test.ts` |
| Hôtes SSH (exécution par l'agent) | implémentée, vérifiée en unitaire | `tools/ssh.ts` : clé seule, `StrictHostKeyChecking=yes`, argv en tableau |
| Tailscale | absente | aucune occurrence dans le dépôt |
| Mise à jour du système / des pilotes | absente | `SoftwareSection` = catalogue d'installation, pas de vérification |
| Interrupteur Internet | absent | aucun point central de sortie réseau (§3, A-01) |
| Voix : mode classique et interruption | implémentée côté shell (VAD + barge-in), non vérifiée en réel | `lib/voice/chained-engine.ts:bargeIn`, `vad.ts` |
| Voix : lecture phrase par phrase avec le noyau Jarod | partielle | le noyau ne sert pas `speak-stream` (`gateway/audio.ts:3`) : la réponse est dite d'un bloc |
| Sélecteur de modèle | fonctionnel, sous la saisie | `hermes/ComposerBar.tsx:ModelPicker` |
| Barre latérale repliable | fonctionnelle (toute la barre) | `shell/Sidebar.tsx`, `store/sidebar.ts` |

## 3. Constats

| Id | Gravité | Composant | Preuve | Impact | Correction proposée | Test de non-régression | Statut |
|---|---|---|---|---|---|---|---|
| A-01 | élevée | réseau | Pas de politique de sortie : `net.fetch` (`ipc/environments.ts:26`), `fetch` (`ipc/catalog.ts:168`), vues web, et dans le noyau `llm`, `gateways`, `tools`, `voice`, `integrations` sortent directement. Les enfants (`run_shell`, `uv`, `wsl --install`) aussi. | Impossible de garantir « pas d'Internet » | Politique centrale : fichier lu par le shell (proxy Chromium mort pour toutes les sessions, garde `assertNetworkAllowed` pour Node) et par le noyau (garde au niveau du socket + refus des outils qui contournent) | tests unitaires de la garde, e2e : bascule, puis requête refusée | **corrigé** (lot 1) : `docs/NETWORK-POLICY.md`, tests `network.test.ts` (shell et noyau), `offline-gate.test.ts`, `e2e/cockpit.spec.ts` |
| A-02 | moyenne | UI barre latérale | Capture `01-Accueil.png` : la section « Espaces » est coupée en bas de la fenêtre, sans défilement. Capture `30-small-chat.png` (900×620) : le bouton « Réduire » et les espaces sont inaccessibles. `Sidebar.tsx:75` : `aside` sans `overflow` | Les espaces et le repli sont inatteignables sur un petit écran | Zone centrale défilante, bouton de repli toujours visible | e2e : à 900×620, « Réduire » est visible | **corrigé** : bouton de repli en haut, zone centrale défilante, infobulles en `position: fixed` ; `e2e/cockpit.spec.ts` |
| A-03 | faible | UI barre latérale | Libellés tronqués à la largeur par défaut (132 px) : « Automat… », « Connexi… », « Navigate… » | Lisibilité | Largeur par défaut adaptée aux libellés français | capture | **corrigé** : 184 px ; une largeur restée à l'ancien défaut de 132 px suit le nouveau |
| A-04 | moyenne | UI conversation | Capture `30-small-chat.png` : à 900×620, les suggestions de l'accueil chevauchent la zone de saisie, et l'avatar chevauche l'en-tête. `Conversation.tsx:104` : `Hero` centré sans défilement | Saisie masquée dans une petite fenêtre | Accueil défilant, centrage sûr | capture + e2e | **corrigé** (capture à 900×620 revue) |
| A-05 | moyenne | UI fenêtre de conversation détachée | `ChatPopout.tsx:13` affiche l'ancien `chat/ChatSurface.tsx` : chaînes anglaises codées en dur (« Message Hermes », « Open Safari »), nom « Hermes », pas de sélecteur de modèle | Incohérence de marque et de langue, fonction différente de la page principale | Réutiliser `Conversation` | e2e : la fenêtre détachée montre le compositeur français | **corrigé** : `ChatPopout` rend `Conversation` ; l'ancien `chat/ChatSurface`, `chat/Composer` et `chat/Transcript` ne servaient plus qu'à lui et sont retirés |
| A-06 | faible | IPC | 159 `ipcMain.handle` sans contrôle de l'expéditeur (`senderFrame`). Les vues web n'ont pas de preload, et la navigation des fenêtres à preload est verrouillée (`window.ts:69-76`, `panels.ts`) | Défense en profondeur seulement : pas d'exploitation trouvée | Différé : un contrôle commun de l'expéditeur dans un lot dédié | — | hypothèse, différé |
| A-07 | faible | tests du noyau | `integrations/test/engines/browser.lifecycle.engine.test.ts:121` : « contrôle WebRTC : aucun datagramme STUN/TURN-UDP n'atteint le témoin sur cette machine, preuve non concluante » | Le contrôle de la preuve UDP dépend de la machine. Ce n'est pas une fuite : c'est le témoin qui ne voit rien sans durcissement. | Aucune correction de code. Documenté (E2-VALIDATION §6.1). | — | confirmé, préexistant, différé |
| A-08 | moyenne | secrets | Sous Windows, le coffre du noyau écrit ses valeurs en `pl:` (base64) dans `jarod.db` (`storage/src/os-crypt.ts:102`). La base est chiffrée par SQLCipher, avec une clé DPAPI (`dbkey.ts:121`). Repli : un fichier de clé « faible » si DPAPI échoue. | Protégé par le chiffrement de la base. Si la clé tombe sur le fichier, protection faible (signalée `weak`). Les sauvegardes copient `jarod.db`, donc le coffre chiffré. | Afficher l'état de chiffrement dans Secrets, exclure le coffre des sauvegardes externes (volets 1 et 4) | test : manifeste de sauvegarde sans valeur de secret | **en partie corrigé** : la sauvegarde externe retire les valeurs du coffre (`snapshotWithoutSecrets`, testé en e2e). L'affichage de l'état du chiffrement reste au volet 4. |
| A-09 | moyenne | SSH | `tools/ssh.ts:435` : un hôte inconnu échoue, et le message demande d'utiliser `ssh-keyscan` à la main. Il n'y a ni première confiance avec empreinte dans l'interface, ni test réseau séparé, ni Tailscale. | Le premier usage est bloqué hors terminal | Volet 2 : test TCP séparé, lecture de l'empreinte (`ssh-keyscan` + `ssh-keygen -lf`), confirmation, ajout au `known_hosts` de Jarod | tests unitaires avec transport simulé | à traiter (volet 2) |
| A-10 | faible | voix | `gateway/audio.ts:3` : le noyau Jarod ne sert pas `speak-stream`. La réponse est synthétisée d'un bloc, ce qui allonge la latence avant le premier son. | Duplex moins réactif avec le noyau Jarod qu'avec Hermes | Volet 7 : mesurer, puis découper la synthèse par phrase côté shell | test unitaire du découpage | à traiter (volet 7) |
| A-11 | faible | qualité | 597 avertissements biome (surtout `noControlCharactersInRegex`, `noNonNullAssertion`) | Bruit | Différé : pas de nettoyage en masse | — | différé |
| A-12 | faible | sauvegardes locales | `electron/backups.ts` copie `data\` entier, coffre compris (chiffré), et vit sur le même disque que les données | Une panne du disque Jarod emporte données et sauvegardes | Volet 1 : sauvegarde externe distincte | — | **corrigé** (volet 1) : sauvegarde externe distincte, `docs/BACKUP-EXTERNE.md` |

Aucun constat critique. A-01 est le préalable des volets 2, 3 et 7 (politique réseau avant tout nouvel accès externe).

## 4. Parcours inspectés (captures réelles, profil jetable)

L'application construite a été lancée par Playwright avec un profil jetable. Captures prises :

- premier lancement (8 étapes) ;
- toutes les pages : Accueil, Jarod, Missions, Mémoire, Fichiers, Automatisations, Kanban, Connexions, Réglages ;
- dans Réglages : Stockage, Réseau, Voix, Confidentialité, Logiciels ;
- la conversation en 900×620.

Les captures restent hors dépôt, dans le dossier de travail de la session.

Constats visuels : A-02, A-03, A-04. Le reste est cohérent : états vides explicites (« Aucune mission pour l'instant »), boutons désactivés hors connexion.

## 5. Zones non couvertes

- Parcours avec un vrai modèle (aucun fournisseur réel n'a été branché pendant l'audit).
- Panneau droit avec des sites réels (sessions des réseaux sociaux) : non ouvert, pour ne pas toucher les comptes.
- Missions, Kanban et Automatisations avec des données : seuls les états vides ont été vus.
- Revue ligne à ligne de tout le noyau : seules les parties liées aux évolutions l'ont été (agent, coffre, ssh, voix, stockage).

## 6. Plan de correction par lots

1. **Lot UI-socle** (A-02, A-03, A-04, A-05) : barre latérale défilante, accueil de la conversation défilant, fenêtre détachée sur `Conversation`. Indépendant des autres lots.
2. **Volet 8, réseau** (A-01) : avant tout nouvel accès externe.
3. **Volet 4, secrets** (A-08) : renforcer l'existant plutôt que créer un second coffre.
4. **Volets 5 et 6** : sélecteur de modèle et navigation.
5. **Volet 1** (A-12) : sauvegarde externe.
6. **Volet 2** (A-09) : Tailscale et SSH, après le réseau et les secrets.
7. **Volet 3** : mises à jour, après le réseau.
8. **Volet 7** (A-10) : voix, après l'audit de l'existant (déjà fait ci-dessus).

## Annexe A — résultats détaillés du noyau

| Paquet | Fichiers | Tests |
|---|---|---|
| plugins/llm | 21 | 293 |
| plugins/voice | 9 | 71 |
| plugins/tools | 15 | 224 |
| plugins/agent | 48 (+1 ignoré) | 344 |
| plugins/gateways | 14 | 84 |
| bridge | 37 | 440 |
| plugins/integrations | 31 (+1 en échec) | 272 (+1 en échec, A-07) |
| autres plugins (scheduler, vision, sandbox, mcp, automation, workflows) | tous réussis | — |

## Bilan de consolidation (lot 1)

- **Corrigés** :
  - A-01 : interrupteur Internet, appliqué dans le shell et dans le noyau ;
  - A-02, A-03 et A-04 : barre latérale et accueil de la conversation ;
  - A-05 : fenêtre de conversation détachée.
- **Constat découvert pendant la correction et corrigé** : le menu des modèles, une fois déplacé dans l'en-tête, était coupé à gauche dans une fenêtre étroite. Il s'ancre désormais sur l'en-tête (capture revue).
- **Différés, avec leur raison** :
  - A-06 : défense en profondeur, sans exploitation ;
  - A-07 : dépend de la machine ;
  - A-11 : bruit de lint.
- **Pris en charge par leurs volets** : A-08, A-09, A-10 et A-12.
