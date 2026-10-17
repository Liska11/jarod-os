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
