# Cockpit — lot 2 : permissions, tâches et preuves d'exécution (Windows)

Date : 2026-10-20. Ce lot étend ce qui existait sans le dupliquer :
- la porte unique `executeGuardedTool` ;
- le garde de permissions ;
- l'accord sur l'action résolue (`precheck`) ;
- le journal d'audit (contrat c7, inchangé).

## Permissions par cible et autorisations temporaires

- **Deux champs optionnels sur une règle** (`permissionsRules`) :
  - `target` : un motif de cible. `*` vaut n'importe quelle suite ; la casse est ignorée ; `/` et `\` sont équivalents ; le motif doit couvrir toute la cible ;
  - `expiresAt` : une échéance. Une fois échue, la règle ne joue plus. Une échéance doit être dans le futur, à 30 jours au plus.
- **Un outil dit sa cible** par `ToolDef.targetOf(args)`. Les outils concernés :

  | Outil | Cible |
  |---|---|
  | `read_file`, `write_file`, `edit_file` | le chemin |
  | `run_shell` | la commande |
  | `web_fetch`, `http_request` | l'adresse |
  | `system_open` | l'application, l'adresse, le chemin ou le volet |
  | `system_quit_app` | l'application |
  | `system_kill_process` | le pid, le port ou le nom |

- **Cible inconnue** (l'outil ne la dit pas, ou il lève) : un `deny` ou un `ask` ciblé s'applique tel quel, et un `allow` ciblé ne joue pas (fail-closed).
- **Vue d'ensemble sans appel** (écran Capacités) : un `deny` ciblé vaut « demander ». L'outil reste disponible, mais pas pour toute cible.
- **Une règle `allow` ne dispense jamais un outil sensible de son accord**, comme avant.
- **Confirmation native** : toute règle qui affaiblit la politique la demande. Cela vaut aussi pour un `allow` ciblé et pour une autorisation temporaire, nommés avec leur cible. Un `deny` ciblé n'en demande pas.
- **Écran** : Réglages › Agent et sécurité › Règles. Le formulaire a un champ cible et une durée (permanente, 1 h, 8 h, 1 semaine). La liste affiche `outil → cible` et « jusqu'à … » ou « échue ».

## Preuves d'exécution

- `ToolDef.verify(args, sortie, ctx)` rend une preuve : `verified`, `failed` ou `unverifiable`, avec ce qui a été observé.
- La vérification tourne APRÈS une exécution réussie, bornée à 15 s.
- La preuve est jointe au résultat vu par le modèle : `[Vérification : constatée | ÉCHEC | impossible] …`.
- `failed` rend l'appel en erreur : un code de retour positif ne suffit pas.
- Une vérification qui lève ou qui dépasse le délai est dite impossible, jamais constatée.

Ce que chaque outil vérifie :

| Outil | Vérification |
|---|---|
| `write_file` | Le fichier relu a exactement le contenu écrit. |
| `edit_file` | Le nouveau texte est présent et l'ancien a disparu. |
| `system_open` (application) | L'application paraît parmi les applications ouvertes (plusieurs relectures). Une adresse, un fichier ou un volet donne `unverifiable`, et la raison est dite. |
| `system_quit_app` | Le processus a disparu. Encore ouverte après une fermeture polie : `unverifiable`, car elle peut demander d'enregistrer. Encore ouverte après un arrêt forcé : `failed`. |
| `run_shell` (V-10) | Le code de sortie **rendu par le système** (0 = constaté ; non nul, délai dépassé ou interruption = échec) et ce que la commande a changé dans le dossier de travail (instantané borné avant/après : créés, modifiés, supprimés ; « non mesuré » au-delà de 20 000 fichiers ou 1,5 s ; `node_modules`, `.git` ignorés). |
| `http_request`, `web_fetch` (V-10) | La réponse **réellement reçue** : statut, hôte qui a répondu (redirection dite), taille, type. 2xx = constaté ; 4xx/5xx = échec ; redirection non suivie (requête avec secret) = impossible, avec sa destination. |
| Autres outils à effet | Pas de vérification prévue. La tâche le dit (« aucune vérification prévue pour cet outil ») ; le résultat de l'outil n'est pas modifié. |

## Tâches

- **Ce qui devient une tâche** : chaque appel qui passe par la porte unique avec un effet, une lecture auditée ou un accord à demander.
  - Une tâche porte la cible, l'action résolue, ses étapes, son statut et sa preuve.
  - Les étapes sont : demandée, accord demandé, accordée ou refusée, exécution, vérification, terminée, échec ou annulée.
  - Les statuts sont : `awaiting-approval`, `running`, `verifying`, `done`, `failed`, `refused`, `cancelled`.
- **Annulation** : le signal de la tâche suit celui du tour de l'agent et sa propre annulation (`TaskLedger.cancel`).
  - Annulée pendant la demande d'accord : rien ne tourne.
  - Annulée pendant l'exécution : le signal de l'outil est coupé.
- **Conservation** : les tâches sont gardées en mémoire (200 au plus ; une tâche vivante n'est jamais évincée). Les tâches finies passent au flux d'événements `tasks` et sont relues au démarrage.
- **Accès** :
  - bridge : `tasks-list` et `task-cancel` (le second n'accepte qu'un identifiant) ;
  - écran : Réglages › Tâches, rafraîchi toutes les 2 s tant qu'une tâche est vivante ;
  - outil de l'agent : `task_status`, en lecture seule, qui montre seulement les actions de la conversation en cours avec leur preuve.

## Scénarios de la mission couverts

| Scénario | État |
|---|---|
| 3. Ouvrir une application : l'agent identifie la cible, agit et vérifie | Testé avec PowerShell simulé (la preuve voit l'application paraître ou non). Pas lancé en vrai par les tests. |
| 9. Une action sensible attend l'autorisation | Testé, y compris l'annulation pendant l'attente. |
| 10. Une instruction injectée n'élève pas les permissions | Les règles ne viennent que des réglages, et l'écriture d'une règle qui affaiblit exige la confirmation native. |

## Limites

- Les preuves couvrent les fichiers, le lancement et la fermeture d'applications, et depuis V-10 (2026-10-23) le shell et le réseau. Les constats viennent de ce que l'outil a observé (code du système, réponse reçue), jamais du texte de sortie : une commande qui imprime « code de sortie : 0 » ne fabrique pas de preuve. Les autres outils système n'ont pas de vérification propre : la tâche le dit.
- Les motifs de cible portent sur la chaîne que l'outil déclare. Un même fichier écrit sous deux formes (relative ou absolue) n'est pas normalisé, et un motif doit couvrir les deux formes si besoin.
- L'écran Tâches liste les 50 dernières tâches. Il n'y a pas encore de filtre par conversation.
