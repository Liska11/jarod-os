# Cartographie de Jarod-OS — 2026-10-19

Dépôt : `C:\Users\San\herald-os` @ `4c9883c` (`feature/windows-port`). Deux mondes séparés : le **shell Electron** (`apps/desktop`) et le **noyau Jarod** (`jarod-core`, TypeScript, lancé par le shell).

## 1. Points d'entrée

| Entrée | Chemin | Rôle |
|---|---|---|
| Shell (dev) | `apps/desktop/electron/main.ts` | Fenêtre `MainSurface` + calques (Barre latérale, CommandSurface, ApplicationsOverlay, AskOverlay…) |
| Shell (web/navigateur) | `apps/desktop/src/main.tsx` | Bootstrap React + nanostores ; `@heraldos/*` |
| Pont sécurisé | `apps/desktop/preload/index.ts` | Un seul objet exposé (`window.heraldOS`), ~505 lignes, un domaine par service ; **aucun `ipcRenderer` brut** |
| Backend embarqué | `apps/desktop/electron/main.ts` → `BackendManager` | Lance (`npm run dev` partiel) le noyau `jarod-core/gateway` avec jeton WebSocket par lancement |
| Noyau | `jarod-core/packages/gateway/src/main.*` (bundle `gateway`), `kernel/src` | Serveur WebSocket + plugins |
| CLI | `packages/cli` (`jarod`), sous-commandes `doctor`, `status`, `skill`, `run`… | Diagnostic et pilotage sans interface |
| Tests/bancs | `apps/desktop/e2e/` (Playwright `_electron`), `test/` (Vitest) | E2E 45 tests ; unitaires 161 fichiers |

## 2. Shell Electron — dossiers

```
apps/desktop/
├─ electron/                  main process (Node 24, Electron 44)
│   ├─ main.ts                fenêtre, politique réseau, bac à sable, disque, VM WSL
│   ├─ net-guard.ts           garde net.Socket.connect + cutDisallowed()
│   ├─ network.ts             NetworkPolicyService, DEAD_PROXY, proxyFor()
│   ├─ ipc/                   un module par domaine (voir §3)
│   ├─ windows/               MainSurface, SecondaryWindow, vues web
│   ├─ *.ts                   atomic-write, log, operation-lock, path tokens
├─ shared/                    contrats partagés main/renderer : ipc.ts, network-policy.ts,
│                             backup.ts, external-backup.ts, jarod-disk.ts, updates.ts,
│                             local-models.ts, remote-machines.ts, themes.ts, voice-plans.ts
├─ preload/                   index.ts (pont `heraldOS`)
├─ src/                       renderer React 19 : surfaces/, components/, state/, i18n, styles
├─ e2e/                       Playwright ; profil jetable ; `voice-latency` mesure
└─ resources/                 icônes, notices, scripts de build
```

### Couche `shared/` — contrats

Un seul fichier de contrat par fonctionnalité, importé par le main, le preload et le renderer. `shared/ipc.ts` centralise les noms de canaux (chaîne constante), ce qui rend un canal non déclaré impossible à câbler par accident. `network-policy.ts` est dupliqué volontairement côté noyau (aucune des deux parties ne peut importer l'autre) ; les tests portent les mêmes cas.

### Couche `renderer` — surfaces

Cockpit (état général), Conversation (fil, composeur, barre d'outils), Applications (en ligne / natives), Réglages (onglets généraux, modèles, voix, secrets, permissions, sauvegardes, mises à jour, environnement, network), CommandSurface (⌘K), AskOverlay (l'agent demande), ApplicationsOverlay, Bacs à sable, Catalogue, Explorer, Remote machines, Mesures, Disque Jarod. La navigation entre surfaces est pilotée par le state nanostore, pas par des routes.

### Vues web (sessions)

Trois natures de sessions web distinctes, toutes passées par l'interrupteur réseau :
1. session par défaut (écrans du shell, pas de navigation arbitraire) ;
2. navigateur du volet droit `persist:desktop-browser/<siteId>` (une par onglet, isolée) ;
3. navigateur de l'agent `persist:desktop-agent-browser/<agentId>` (isolée par agent).

Le `WebContentsView` est stocké sur le slot et non attaché au `BrowserWindow` directement (parcimonie des `webContents`). `webviewTag` est désactivé ; les vues n'ont pas de preload et `setWindowOpenHandler` refuse toute fenêtre.

## 3. IPC — inventaire (hors tests)

183 enregistrements `ipcMain.handle/on`, dont :

| Module | Canaux | Domaine |
|---|---|---|
| `main.ts` | 17 | cycle de vie, configuration, canaux transverses |
| `ipc/fs.ts` | 20 | lecture/écriture, arbres surveillés, jetons de chemins |
| `ipc/terminal.ts` | 181 (handlers + events) | PTY(`node-pty`), sessions par vues, libération à la destruction |
| `ipc/external-backup.ts` | 9 | sauvegarde externe (état, lancement, audit) |
| `ipc/capture.ts` | 9 | captures (écran, fenêtre) |
| `ipc/web.ts` | 9 | navigation, zoom, devtools, fermeture |
| `ipc/plugins/host.ts` | 6 | hôte de plugins externes (processus séparé) |
| autres | ~40 | disque Jarod, bacs à sable, environnements, VM, modèles, MCP, shell, voix, préférences, commandes OS |

Contrôles d'émetteur : **locaux** (propriété des arbres surveillés, des vues web, des PTY), pas de wrapper central — X-01.

## 4. Noyau `jarod-core` — paquets

`pnpm` workspace ; ~25 paquets, moteur de plugins `@jarod/plugins` (24 plugins) :

- `kernel/` : `network.ts` (interrupteur Internet, gardes, `toolVerdict`), `redact.ts`, `util`, `logger`.
- `plugins/agent/` : boucle de l'agent (`agent.ts`, ~1 400 l.) ; `executeGuardedTool` est la porte unique des outils.
- `plugins/permissions/` : porte de décision (`gate`), `shell-guard.ts` (résolution de programme, refus, plan de confinement), politique par défaut **deny**.
- `plugins/tools/` : `builtin.ts` (`run_shell`, `read_file`, `write_file`, `web_search`, `http_request`…), `system/tools.ts` (outils Windows en lecture sauf `system_open`/`system_control`), `ssh.ts` + `ssh-hosts.ts` (BatchMode, StrictHostKeyChecking=yes), `browser-tools.ts`, `connected-browser-tool.ts`, `vault-tools.ts`, `mcp`.
- `plugins/storage/` : `db.ts` (SQLCipher), `dbkey.ts` (DPAPI `CurrentUser`, entropie `Jarod-One db key`), `os-crypt.ts` (relit `ss:` / écrit `pl:`), migrations.
- `plugins/llm`, `gateways` : fournisseurs, flux, prompts, sauvegarde de conversation.
- `plugins/memory`, `embeddings`, `rag` : souvenirs, vectorisation locale (ONNX), recherche.
- `plugins/voice` : STT/TTS, duplex, VAD, barge-in, temporisations (cf. `docs/VOICE.md`).
- `plugins/integrations`, `automation`, `scheduler`, `workflows`, `skills`, `mcp`, `kanban`, `hyperv`, `quarantine`, `sandbox`, `updates`, `gateway`.

### Frontières et flux

```
renderer --(preload bornée)--> main --> (IPC) ipc/*
main --(ws jeton)--> gateway --> agent --> executeGuardedTool --> tools
                                              |                     |
                                   permissions/shell-guard      noyau : réseau, coffre, db
```

- Le renderer **ne parle jamais** au noyau directement ; tout passe par le main.
- L'agent **ne voit jamais** une valeur de secret ; `{{secret:NOM}}` est résolu à l'usage.
- Le noyau **relit la politique réseau à chaque connexion** ; la vérité est le fichier, pas la mémoire du shell.
- Les données : `%APPDATA%\Jarod-OS\{config,data,logs}`, `data/jarod.db` (SQLCipher), coffre dans la base, sauvegardes externes sur disque choisi, arborescence « disque Jarod » avec liens durs.

## 5. Réseau

| Couche | Fichier | Garde |
|---|---|---|
| Sessions Chromium | `electron/ipc/network.ts` | proxy `fixed_servers` → `127.0.0.1:9`, bypass machines distantes déclarées, `closeAllConnections`, WebRTC `disable_non_proxied_udp` |
| Sockets Node du shell | `electron/net-guard.ts` | `net.Socket.prototype.connect` + `cutDisallowed` à chaque changement |
| Sockets Node du noyau | `kernel/src/network.ts` | idem + `watchFile` 500 ms + `toolVerdict` |
| Outils | `plugin tools`, `kernel/toolVerdict` | refus hors ligne avant approbation |
| Enfants | — | non isolés (limite admise) |

## 6. Données

- **Base** : `jarod.db`, SQLCipher ; clé = 32 octets aléatoires protégés par DPAPI (`CurrentUser`) via `powershell`/`Net`, repli Keychain/Libsecret, dernier repli fichier 0600.
- **Coffre** : table dédiée, valeurs `pl:` (base64) dans la base chiffrée ; `ss:` relu (compatibilité). X-02.
- **Sauvegarde externe** : `VACUUM INTO`, retrait des valeurs du coffre, hachage SHA-256, manifeste dernier, `.incomplete`, verrou d'opération, conservation `<cible>.before-restore-*`.
- **Disque Jarod** : `%LOCALAPPDATA%\Jarod-OS\Jarod Disk` (ou emplacement choisi), racine marquée `.jarod-os-root.json`, sandboxes en liens durs vers la corbeille, suppression du profil après 7 jours.
- **Logs** : `logs/*.log` avec rotation et masquage (les valeurs de secrets n'y entrent pas).

## 7. Distribution

- `npm run build` puis Electron Builder : `dist:win` (NSIS, icône, licence) et `dist:mac` (dmg, notarisation à faire). Windows non signé, MSI/portable non fournis.
- Auto-update : absente par choix (mise à jour assistée) ; `docs/UPDATES.md` : contrôle en lecture seule (Windows Update Agent API, `winget upgrade`), installation manuelle, aucun redémarrage provoqué.
- Licence et troisième partie : `resources/licenses`, `NOTICE`.

## 8. Doublons et code mort

- `shell-guard.ts` (noyau) et le contrôle « commandes locales » du shell se recouvrent partiellement : le premier juge ce qui s'exécute, le second l'accès réseau des enfants — volontaire, pas un doublon.
- `network-policy.ts` existe en deux copies (shell/shared et kernel) : duplication documentée, tests identiques.
- Le canal `terminal` expose 181 enregistrements dont une partie est générée par boucle : le décompte « 6 canaux » du README wiki est obsolète.
- Pas de fichier manifestement mort détecté dans les chemins audités ; les marqueurs `TODO`/`FIXME` sont rares et correspondaient à des sujets du backlog (`A-06`, `A-08`).

## 9. Zones non auditées ici

`plugins/automation`, `workflows`, `kanban`, `hyperv`, `quarantine`, `gateway` : lus en survol seulement (contrats et appels), pas de revue ligne à ligne. Les paquets `integrations` et `bridge` n'ont été vus que par leurs tests.

*Fin de cartographie.*
