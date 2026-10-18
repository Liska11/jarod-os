# Journal de décisions — travail autonome (2026-10-17)

Mandat : finir le maximum de Jarod-OS sans validation humaine ; aucun push, aucune signature, aucun secret, aucun compte tiers.
Un sujet par commit local. Les arbitrages sont ici, un par section, pour revue à la fin.

## Règles tenues
- Aucun contournement du garde `guarded/authorize/audit`, du disjoncteur de routage, de la découverte Cordis, du chiffrement SQLite, du pont d'approbation.
- Rouge avant vert quand le sujet s'y prête ; relance ciblée avant commit.
- « Bloqué par décision propriétaire » : certificat/signature, push, comptes Mozilla/GitHub, secrets réels, domaines externes, actions destructives réelles.

---

## 0. Avant le mandat (même journée) — rappel
- `4dd4f57` journal de contrôle borné (rotation 8 Mo → `.1`), tests `journal_rotation.rs`. Risque : une génération seulement conservée (choix : borne stricte du disque).
- `f678897` message explicite quand un dossier d'outils n'appartient pas au compte (Win32 5/1314). Non reproduit avec un vrai dossier refusé (limite documentée).

## 1. Test instable `plugin-embeddings` (audit D-04)
- **Décision** : remplacer l'attente fixe de 300 ms par une attente d'un fait (le pid a disparu, 5 s max, pas de 50 ms).
- **Pourquoi** : la course au démontage rendait le test non déterministe ; attendre le fait garde la même assertion (le worker est tué par l'arrêt du noyau) sans dépendre de la vitesse de la machine.
- **Risque** : aucun sur le produit (test seul). Une vraie fuite de worker ferait toujours échouer après 5 s.
- **Tests** : `isolated-plugin.test.ts` ×3 passes, 5/5 à chaque fois.
- **Commit** : voir `git log` (sujet « test(embeddings) »).
- **Reste** : rien.

## 2. Journal applicatif `herald-os.log` borné (audit CAP-19 / OPP-14, partie rotation)
- **Décision** : nouvelle classe `RotatingLog` (`apps/desktop/electron/rotating-log.ts`) ; `log.ts` l'utilise. Au-delà de 5 Mo le fichier devient `herald-os.log.1` (une génération), un nouveau fichier démarre ; une ligne n'est jamais coupée ; une erreur d'écriture est avalée.
- **Pourquoi** : le fichier croissait sans borne. Écriture synchrone par ligne (`appendFileSync`, aucun descripteur gardé ouvert) : plus simple et sans fuite, volume de logs faible. Pas d'OpenTelemetry : dépendance et surface réseau inutiles pour ce besoin (l'audit le classe « moyenne », et la rotation seule règle le risque disque).
- **Risque** : une seule génération conservée (au plus ~10 Mo) ; écriture synchrone sur le fil principal (lignes courtes, redactées et bornées à 4 000 caractères).
- **Tests** : `rotating-log.test.ts` 3/3 (rouge avant) ; `vitest run electron` 705 passés, 3 ignorés ; `tsc --noEmit` propre. Une coquille de ma part (appel à l'ancienne fonction) a été attrapée par ces tests et corrigée avant commit.
- **Reste** : métriques/traces locales (non traité, chantier large).

## 3. Journal de contrôle côté shell (`control-audit.jsonl`) borné
- **Décision** : `controlAuditSink(file, limit = 8 Mo)` renomme le fichier en `<nom>.1` (génération précédente remplacée) avant d'ajouter une ligne quand il atteint la limite. Modes 0600/0700 conservés ; erreurs toujours avalées (un journal n'est pas un interrupteur).
- **Pourquoi** : même défaut que côté Rust (fichier sans borne) ; mêmes règles des deux côtés.
- **Risque** : une génération seulement ; `existsSync`+`statSync` à chaque ligne (coût négligeable pour des tentatives de contrôle).
- **Tests** : `control-audit-rotation.test.ts` (rouge puis vert), `vitest run electron/shell` 345 passés, `tsc` propre.
- **Annuler** : `git revert` du commit « bound the shell control journal ».

## 4. Recherche « harness autonome » + porte de lot locale
- **Décision** : `AUTONOMY-RESEARCH.md` (références avec niveau de preuve), `scripts/autonomy/` (porte start/check/status), `autonomy/{checks,backlog}.json`, `autonomy/journal.jsonl` (créé à l'usage), `lots.json` ignoré par git.
- **Pourquoi** : retenir seulement les invariants utiles et peu coûteux — évaluateur figé pendant le lot, accepter/rejeter par vérifications déterministes, abandon après 3 échecs avec trace, annulation seulement *proposée*. Pas de commit automatique, pas d'auto-modification.
- **Honnêteté sur la recherche** : un résumé de moteur attribuait à l'arXiv 2603.17973 (TDAD) une boucle d'auto-amélioration ; la lecture de l'abstract ne la confirme pas → non citée comme telle. DGM et autoresearch ne sont connus que par extraits/articles secondaires.
- **Tests** : `node --test scripts/autonomy/lot.test.mjs` 5/5. NB : les tests et le code ont été écrits ensemble (pas de rouge préalable) — contrairement aux lots 2 et 3. Le test « évaluateur modifié » vérifie le garde-fou ; pas de mutation faite.
- **Annuler** : voir la section « Annuler cette partie » de `AUTONOMY-RESEARCH.md`.

## 5. Clés de réglage inconnues : plus de perte silencieuse (audit D-09) — lot B2, passé par la porte (ACCEPT)
- **Décision** : `SettingsService.patch` écarte toujours une clé absente de `DEFAULT_SETTINGS`, mais **dit son nom** (`console.warn`, jamais la valeur) ; les clés connues du même lot sont écrites. Au passage `k in DEFAULT_SETTINGS` devient `Object.hasOwn` (une clé comme `toString` n'est plus « connue » par héritage du prototype).
- **Option rejetée** : lever une erreur. Premier essai (rouge → vert) : cela a cassé `settings-memory.test.ts`, qui documente l'écartement des clés inconnues. Lever une erreur ferait aussi échouer l'enregistrement d'un profil venant d'une autre version : trop risqué pour un gain de diagnostic.
- **Risque** : l'avertissement n'est qu'un journal ; il ne remplace pas l'ajout de la clé aux défauts. Le test mal posé a été remplacé, pas contourné.
- **Tests** : `settings-unknown-keys.test.ts` (rouge avant) ; `vitest` sur storage/bridge/cli 955 passés ; suite jarod-core complète : les gates P0/P1/P2/P3 échouent avec et sans ma modification (dépendants de la machine) ; les moteurs navigateur (avant) et `hyperv` (après) échouent par intermittence sous charge — `hyperv` repasse seul ; le seul échec réellement causé par ma première version (`settings-memory.test.ts`) a mené au changement de décision ci-dessus. Porte de lot : ACCEPT 1.00.
- **Annuler** : `git revert` du commit « fix(settings) ».

## 6. Embeddings absents de l'application installée : message clair (audit D-03, partie « expérience »)
- **Décision** : `makeGenaiLoader` (`embeddings/src/openvino.ts`) transforme `ERR_MODULE_NOT_FOUND` en « Le moteur d'embeddings (OpenVINO) n'est pas inclus dans cette installation : le RAG ne peut pas indexer ni chercher ici. » (cause d'origine conservée) ; toute autre erreur (DLL, version) passe telle quelle ; un échec n'est plus mis en cache à vie.
- **Pourquoi** : le message affiché dans `metrics().lastError` citait un chemin de module Node, incompréhensible. Embarquer vraiment OpenVINO (natifs + modèle) est un chantier d'installateur : **non traité** (`B1b`, trop large, et non vérifiable sans réinstaller).
- **Risque** : on ne distingue « non embarqué » que par le code d'erreur de Node ; une autre cause du même code recevrait le même message (cause conservée dans `cause`).
- **Tests** : `openvino-missing.test.ts` 3/3 (rouge avant) ; `vitest packages/plugins/embeddings` 101 passés, 3 ignorés ; `tsc` propre. Pas relancé dans l'application installée (non vérifiable ici).
- **Annuler** : `git revert` du commit « fix(embeddings) ».

## 7. `plugin-vision` : couverture (audit D-05) et délai d'une description
- **Décision** : 7 tests ImageDescriber/supportsVision (cache, réponse vide non gardée, repli « Image non décrite », annulation utilisateur propagée, familles de modèles). Les tests de comportement existant sont verts d'emblée ; **un test était rouge et révélait un vrai défaut** : un fournisseur qui ne répond jamais suspendait le tour sans fin. Correctif : délai de 120 s par description (`AbortSignal.timeout`, combiné avec l'annulation de l'utilisateur), réglable par l'option `timeoutMs` du constructeur.
- **Pourquoi 120 s** : une description de 2 000 jetons par un modèle local lent reste très en dessous ; au-delà, mieux vaut continuer sans l'image que bloquer.
- **Risque** : un modèle local très lent au premier chargement pourrait dépasser 120 s → image non décrite (dite dans le texte, jamais en silence, non gardée en cache).
- **Tests** : `vitest packages/plugins/vision` 7/7 ; `tsc` propre.
- **Annuler** : `git revert` du commit « fix(vision) ».

## 8. Délais sur les appels d'API Slack et Discord (robustesse/timeouts)
- **Décision** : audit des `fetch(` du noyau (ceux sans aucun `signal`/`timeout` dans leur fichier) ; Slack (3 appels) et Discord (2) n'avaient aucune borne. Chaque appel reçoit `AbortSignal.timeout(requestTimeoutMs ?? 60 000)`. Telegram et WhatsApp en avaient déjà.
- **Pourquoi 60 s** : au-dessus des 30 s de WhatsApp, car l'envoi d'un fichier est plus long ; un message texte qui prend plus d'une minute est de toute façon perdu.
- **Reste non traité** : `cli/src/gateway/verify.ts` (script de vérification manuel), `gateways/mobile-page.ts` (fetch côté page du navigateur, pas du noyau) et `integrations/src/impl/oauth.ts` (échange de jeton via un `fetch` injecté : le délai dépend de l'appelant — à vérifier lors du câblage OAuth, qui n'est pas branché).
- **Tests** : `gateway-timeouts.test.ts` (serveur muet, rouge avant : 3 tests suspendus 5 s), puis `vitest packages/plugins/gateways` 84/84 ; `tsc` propre.
- **Risque** : un envoi de très gros fichier sur lien lent pourrait dépasser 60 s (erreur dite, pas de perte silencieuse).
- **Annuler** : `git revert` du commit « fix(gateways) ».

## 9. Échange de jetons OAuth borné (30 s)
- **Décision** : `completeAuthorization` passe `AbortSignal.timeout(deps.timeoutMs ?? 30 000)` à l'échange. Une échéance fait échouer l'échange ; rien n'est déposé dans le coffre ; l'autorisation en attente reste marquée « utilisée » (fermeture par défaut : il faut recommencer).
- **Pourquoi** : le module n'est branché nulle part aujourd'hui (OPP-05 non fait) ; la borne est posée maintenant pour que le futur câblage ne l'oublie pas. Aucune clé réelle ni compte tiers touchés.
- **Tests** : `oauth-timeout.test.ts` (rouge avant : suspendu) ; `wave-b.test.ts` inchangé 15/15 ; `tsc` propre.
- **Annuler** : `git revert` du commit « fix(oauth) ».

## 10. `taskkill` du worker d'analyse de documents : délai 15 s
- **Décision** : balayage de tous les `spawnSync/execFileSync` non-test : un seul n'avait pas de délai (`rag/parser-worker.ts`, `taskkill`). Ajout de `timeout: 15_000`, comme les autres appels `taskkill` du dépôt.
- **Tests** : `vitest packages/plugins/rag` 164 passés ; `tsc` propre. **Non testé en isolation** : un `taskkill` qui se bloque n'est pas reproductible sur demande ; la modification est une option d'appel d'une ligne.
- **Annuler** : `git revert` du commit « fix(rag) ».

## 11. Décisions du propriétaire (2026-10-18) et préparation du push
- **Reçu** : délais conservés ; porte de lot conservée « pour l'instant » ; push à préparer (Firefox d'abord seulement si le lot en dépend) ; renommage global séparé, hors de ce lot.
- **Dépendance Firefox ?** Non : l'extension (`jarod-core/sidecars/firefox-reader/`) n'est ni signée, ni installée, ni câblée dans l'application ni dans l'installateur ; aucun des commits ne la rend nécessaire au fonctionnement. La signature peut donc suivre le push sans le bloquer. (À vous de confirmer si vous préférez quand même signer d'abord.)
- **Écart de compte** : l'arbre local est en avance de **30** commits sur `origin/feature/windows-port` (et non 13 : les 13 de cette session s'ajoutent à 17 de la session précédente, E2/Firefox/readRoots/audits). 104 fichiers, +8 379 / −1 053.
- **Vérifié avant push** : balayage des lignes ajoutées (8 483) à la recherche de formes de clés (OpenAI/Anthropic, GitHub, AWS, Slack, bloc de clé privée, affectation de jeton longue) : **0 résultat** ; aucun binaire/archive/clé parmi les fichiers modifiés (`.exe .zip .xpi .db .pem .key`). Le dossier `jarod-core/.work/` (rapports de gates générés, non suivi) n'est pas commité.
- **Fait** : rien n'est poussé. Commande à lancer par vous : `git push origin feature/windows-port` (aucune réécriture d'historique, avance simple).
- **Renommage** : non lancé ; plan intact dans `docs/RENAME-PLAN-JAROD-OS.md`.
