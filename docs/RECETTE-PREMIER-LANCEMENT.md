# Recette du premier lancement (après l'étape 11b)

Instance installée le 27/10/2026 (deuxième pose à 19:14, avec le bouton « Tout autoriser ») : `C:\Program Files\Jarod-OS`,
version **0.1.0-alpha.1**, `gateway.mjs` **9 079 705** o, `app.asar` **6 331 110** o, `BUNDLE.json` **v26.12.1 / 24 plugins**.
Données : `D:\Jarod-OS` (profil `data\profile\profiles\default`, `HERMES_HOME = data\herald-home`).

Ces six essais se font **à la main, dans l'ordre** ; ils couvrent ce que le portage a changé et ce que
l'installation a déplacé. Le journal à garder ouvert : `D:\Jarod-OS\data\herald-home\logs\jarod-os.log`.

---

## 1. Démarrage

**Faire** : double-clic sur le raccourci du menu Démarrer (ou `C:\Program Files\Jarod-OS\Jarod-OS.exe`).

**Attendu** :

- la fenêtre s'ouvre, pas de dialogue d'erreur ;
- le journal contient `Jarod-OS 0.1.0-alpha.1 starting (dev=false, mode=desktop, HERMES_HOME=D:\Jarod-OS\data\herald-home)`
  puis `backend ready on http://127.0.0.1:<port> via the Jarod core built into Jarod-OS` ;
- les lignes `rpc non servi : client.capabilities / usage.bars / billing.state` sont **normales** (déjà présentes
  dans l'installation du 25/10) : ce sont des appels du shell que le noyau ne sert pas, sans effet.

**Si ça échoue** : copier les 40 dernières lignes du journal et le contenu de `%APPDATA%\Jarod-OS\config`.

## 2. Conversation reprise

**Faire** : ouvrir la conversation « Test direct OK : WhisperPipeline fonctionne sur NPU… » (81 messages),
puis envoyer un message court (« bonjour, tu me lis ? »).

**Attendu** :

- l'historique s'affiche (messages utilisateur, réponses, lignes d'outils repliées) ;
- la jauge de contexte se remplit à l'ouverture ;
- la réponse arrive et s'ajoute à la fin, la conversation garde son titre et son compteur augmente ;
- aucune erreur « base verrouillée » ni « unknown session ».

**Vérifier ensuite** que `D:\Jarod-OS\data\profile\profiles\default\jarod.db` a bien grandi (mtime du jour) — c'est
la preuve que les écritures vont dans le bon profil.

## 3. Page « Capacités & Évolution »

**Faire** : ouvrir la page depuis le dock / le menu (icône Capacités).

**Attendu** :

- les **quatre sections** s'affichent : Confiance, Capacités, Dépendances, Mises à jour ;
- **Confiance** liste les clés de `D:\Jarod-OS\data\herald-home\jarod-os\publisher-keys.json` (dont `local-1`,
  niveau `local`) et le greffon `des` en `local`, `enabled` ;
- **Dépendances** montre les **11 composants** inventoriés (node, npm, pnpm, python, git, docker, wsl, ollama,
  llamacpp, restic, nvidia) avec leur politique (`notify` par défaut) ;
- « Vérifier » sur une capacité affiche un verdict ; « Intégrer » / « Désactiver » / « Retirer » passent par une
  **carte d'accord** (rien ne s'exécute sans réponse) ;
- la bascule de politique d'un composant demande aussi un accord ; « Appliquer » reste inactif tant que la
  politique n'est pas `auto-safe`/`auto-full`.

**Point d'attention** : la page lit `trust.installed`, `capability.registry`, `deps.inventory`, `deps.state` — si
une section reste vide, c'est le RPC qui a refusé, et le message s'affiche dans la page (pas d'écran blanc).

## 4. QR code avec nom `.ts.net`

**Faire** : écran Téléphone → « Associer un téléphone ».

**Attendu** :

- un QR code s'affiche avec un lien d'association valable **10 minutes** ;
- l'adresse proposée est le nom **MagicDNS** `*.ts.net` de la machine (Tailscale en marche), pas une IP brute
  ni `localhost` ;
- régénérer le lien invalide l'ancien (le secret change à chaque demande).

**Si l'adresse est une IP** : vérifier `tailscale status` (BackendState `Running`, `Self.DNSName`) — le nom n'est
proposé que si MagicDNS est actif.

## 5. Appairage du téléphone

**Faire** : scanner le QR avec l'application Android, puis ouvrir l'écran Téléphone côté PC.

**Attendu** :

- l'appareil apparaît dans la liste (nom de l'appareil, ici « Mon téléphone »), avec `pairedAt` et `lastSeen` ;
- la liste se met à jour sans redémarrer l'application ;
- si les accords sur téléphone sont activés, une demande d'accord arrive sur le téléphone et la première réponse
  (fenêtre ou téléphone) l'emporte ;
- « Révoquer » retire l'appareil immédiatement ; un appareil révoqué ne peut plus se reconnecter.

## 6. Le bouton « Tout autoriser »

**Faire** : dans une demande qui enchaîne plusieurs appels, cliquer **« Tout autoriser »** sur une carte d'accord (ou la pastille en bas à
gauche), confirmer une fois dans la boîte native.

**Attendu** :

- la boîte native dit « Autoriser toutes les commandes ? », avec « Annuler » par défaut ;
- la pastille passe en rouge « Tout autorisé — Éteindre », et les appels suivants **ne demandent plus** (l'appel en cours est accordé) ;
- « Éteindre » (pastille, ou interrupteur des Réglages › Agent) rend le profil d'avant : les commandes redemandent ;
- les règles « refuser »/« demander », l'interrupteur Internet, le mode Plan et les gardes des outils s'appliquent toujours — un outil
  frappé par une règle « refuser » reste refusé, bouton allumé ou non.

## 7. Contrôles finaux

```powershell
(Get-Item 'C:\Program Files\Jarod-OS\Jarod-OS.exe').VersionInfo.FileVersion          # 0.1.0-alpha.1
(Get-Item 'C:\Program Files\Jarod-OS\resources\app.asar').Length                    # 6331110
(Get-Item 'C:\Program Files\Jarod-OS\resources\jarod-core\gateway.mjs').Length      # 9079705
Get-Content 'C:\Program Files\Jarod-OS\resources\jarod-core\BUNDLE.json' -Raw | ConvertFrom-Json | Select-Object node,gatewayBytes
```

**Attendu** : les quatre valeurs ci-dessus, et `D:\Jarod-OS\data` inchangé pour tout ce que l'application
n'écrit pas elle-même (les conversations, si).

Rappel : **`install-payload.ps1` de `D:\Jarod-OS\repo` ne doit plus être utilisé** — il écraserait le port (les
Phases 1 à 4 vivent dans `gateway.mjs` / l'asar) et ferait revenir les quatre `.cjs` de l'ancien build. Voir
`docs/PORT-PHASES-1-4.md`, section « À ne plus utiliser ».
