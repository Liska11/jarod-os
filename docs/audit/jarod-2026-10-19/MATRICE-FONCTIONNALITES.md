# Matrice des fonctionnalités — Jarod-OS @ 4c9883c (2026-10-19)

Statuts : **vérifié** (preuve exécutée ou code + test concordants), **partiel** (chemin principal prouvé, cas limites non), **cassé**, **simulé** (interface factice), **implémenté non vérifié** (code et tests unitaires, pas de preuve d'usage réel), **absent**.

## 1. Écrans (interface)

| Écran / surface | Statut | Preuve / mesure | Notes |
|---|---|---|---|
| Cockpit (état général, modèle, latence, réseau) | vérifié | e2e `cockpit.spec.ts` 6/6 | bandeau haut, états et boutons câblés |
| Conversation (fil, composeur, pièces jointes, recherche) | vérifié (chemin principal) | e2e ; 1268 tests ; pas de revue visuelle fine | composeur non recouvert après correctif `4c9883c` |
| Sélecteur de modèle en haut de conversation | vérifié | e2e + code relu | A-01 corrigé, non revu visuellement |
| Barre latérale (repliable, largeur mémorisée) | vérifié | e2e + `localStorage` | A-05 corrigé |
| Applications (en ligne / natives) | vérifié | e2e, `ApplicationsOverlay` | avertissement de build X-05 |
| Réglages — Général | vérifié | e2e | thème, langue, mise à jour assistée |
| Réglages — Modèles | partiel | e2e sélection, pas d'installation de modèle (règle : ne rien installer) | catalogue et statut lus |
| Réglages — Voix | partiel | e2e, mesure 263 ms | micro réel non testé (M3) |
| Réglages — Secrets | vérifié (code) / partiel (UI) | `VaultService`, e2e ajout/suppression | valeurs masquées, jamais renvoyées |
| Réglages — Permissions | vérifié | e2e + `gate` (défaut deny) | outils listés avec descriptions |
| Réglages — Sauvegardes | partiel | cycle dans `%TEMP%` seulement | USB réel non testé (M2) |
| Réglages — Mises à jour | implémenté non vérifié | lecture seule, jamais d'installation | « Non vérifié » honnête sans Internet |
| Réglages — Environnement / VM | implémenté non vérifié | code + tests unitaires | déplacement WSL non rejoué |
| Réglages — Réseau | vérifié (code + e2e) | politique, machines distantes, commandes locales | interrupteur réel (§ coupures) |
| Explorer / Disque Jarod | vérifié | e2e | racine `.jarod-os-root.json`, corbeille |
| Remote machines | partiel | code `remote-machines.ts`, ssh | pas de second PC (M1) |
| Bacs à sable | partiel | code + tests | Windows dépend de `jarod-sandbox` (X-03) |
| Catalogue / Skills | partiel | code + unitaires | hub réseau non rejoué hors ligne |
| Mesures (latence, tokens) | vérifié | e2e `voice-latency` | chiffres affichés conformes |

## 2. Capacités d'agent

| Capacité | Statut | Preuve | Notes |
|---|---|---|---|
| Boucle agent + streaming | vérifié | tests + e2e | — |
| Porte d'outils unique (`executeGuardedTool`) | vérifié | code relu + tests | ordre : réseau → plan → perm → args → approbation |
| Mode Plan (lecture seule) | vérifié | test unitaire | — |
| Approbations (ask / always-allow / auto) | vérifié | tests | `NEVER_ALWAYS` non contournable |
| `run_shell` | vérifié (chemin) / partiel (confinement) | code + tests ; confinement `workspace` refusé sous Windows | X-03 |
| Outils fichiers | vérifié | `path-guard` + tests | écritures bornées au workspace |
| Outils navigateur (agent) | partiel | code + tests | hors ligne refusé |
| `web_search` / `http_request` | partiel | tests | fournisseur réel non branché |
| MCP (serveurs) | partiel | code + unitaires | refus hors ligne sauf « commandes locales » |
| SSH vers une machine déclarée (terminal utilisateur) | implémenté non vérifié | unitaires (ssh-keygen, known_hosts) | pas de pair (M1) |
| Exécution distante par l'agent | **absent** | docs/REMOTE-SSH.md, code | l'agent ne lance pas de commande sur l'autre PC |
| Kanban / Workflows / Automatisations | implémenté non vérifié | contrats + unitaires | pas d'essai d'usage |
| Mémoire / RAG | partiel | unitaires, indexation locale | recherche réelle non mesurée |
| Sous-agents (`task`) | partiel | code + tests | limites de profondeur non essayées |

## 3. Réseau

| Capacité | Statut | Preuve | Notes |
|---|---|---|---|
| Interrupteur Internet — arrêt immédiat | vérifié | code des deux côtés ; e2e cockpit ; tests unitaires policy | proxy mort + `closeAllConnections` + `cutDisallowed` |
| Persistance et reprise | vérifié | fichier `network-policy.json` relu par `stat` | fichier absent/invalide → coupé |
| Machines distantes déclarées | vérifié (code) | `proxyBypassRules`, `decideHost 'remote'` | liste limitée à 64 hôtes |
| « Commandes locales » hors ligne | vérifié (code) | `toolVerdict` + option | sinon `run_shell`/MCP refusés |
| WebRTC hors ligne | vérifié (code) | `disable_non_proxied_udp` | restauration par page |
| Fuites UDP (`dgram`) | **limite admise** | garde `connect` seulement | X-04 |
| Enfants non isolés | **limite admise** | comportement documenté | X-04 |
| Backend Hermes | **limite admise** | seul le shell applique | X-12 |

## 4. Voix

| Capacité | Statut | Preuve | Notes |
|---|---|---|---|
| Synthèse (TTS) | vérifié | e2e 263 ms (phrase), 290 ms (réponse) | modèle local du noyau |
| Duplex (écoute pendant la parole) | partiel | tests + code ; micro réel non testé | VAD, barge-in, invalidation de tour |
| Interruption | vérifié (code + test) | `stop` → invalidation du tour | pas de reprise fantôme |
| Transcription | partiel | unitaires | pas de micro réel (M3) |
| Écho (haut-parleurs) | non vérifié | — | à mesurer en réel |
| Mode classique (bouton) | vérifié | e2e | bascule conservée |

## 5. Données et sécurité

| Capacité | Statut | Preuve | Notes |
|---|---|---|---|
| Chiffrement de la base | vérifié (code) | SQLCipher, clé DPAPI | — |
| Coffre de secrets | partiel | code + tests | X-02 : `pl:` en base |
| Masquage des sorties d'outils | vérifié | `redact` avant troncature | — |
| Sauvegarde externe | partiel | cycle `%TEMP%`, tests, manifeste | USB réel (M2) |
| Restauration | partiel | validation complète testée | retour arrière non rejoué réellement |
| Contrôle d'émetteur IPC | **partiel** | contrôles locaux seulement | X-01 |
| Confinement des écritures shell | partiel | refus si mécanisme absent | X-03 |
| Journal d'audit des outils | vérifié | `redactText` + troncature 500 | — |

## 6. Mises à jour et distribution

| Capacité | Statut | Notes |
|---|---|---|
| Contrôle des mises à jour | implémenté non vérifié | lecture seule, aucun téléchargement |
| Installation d'une mise à jour | absent (volontaire) | manuelle |
| Redémarrage système | absent (volontaire) | jamais provoqué |
| Paquet Windows | partiel | NSIS ; non signé |
| Paquet macOS | absent | non construit / non notarié |

## 7. Écarts constatés entre documentation et réalité

1. `docs/AUDIT-GLOBAL.md` annonce 159 canaux IPC sans contrôle : l'inventaire courant en compte **183** (X-01, dérive doc).
2. Le README/wiki annonce 6 canaux terminal : `ipc/terminal.ts` en expose bien davantage (générés), sans impact.
3. `UPDATES.md` et l'écran Réglages disent « Non vérifié » hors ligne : conforme au code, pas un défaut.
4. `VOICE.md` documente des mesures 241–293 ms ; l'e2e du 19-10 mesure 263/290 : cohérent.
5. Les limites réseau (DNS, `dgram`, enfants, Hermes) sont **exactes** : la doc ne promet pas plus que le code.

*Fin de matrice.*
