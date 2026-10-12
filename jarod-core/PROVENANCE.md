# jarod-core : provenance

`jarod-core/` est le **noyau de Jarod-OS** : agent, outils, fournisseurs, mémoire, planificateur, messageries, passerelle JSON-RPC pour le shell.
C'est une **copie indépendante** du dépôt `jarod-cordis` (branche `spike/hermes-gateway`), faite le 2026-10-12 à partir du commit
**`2d5bf46d75fd0e8a8682bc1bf485a3eb42b1a2aa`** (`git archive` du commit : les modifications non commitées de ce dépôt n'y sont pas).

Depuis cette copie, `jarod-core` et `jarod-cordis` évoluent séparément : rien dans Jarod-OS n'importe, ne lance ni ne référence `jarod-cordis`.
Les corrections utiles aux deux sont à reporter à la main (aucune synchronisation automatique).

## Ce qui a été copié

`packages/{cli,contracts,kernel,plugins/*}`, `tests/` (intégration et gardes du dépôt), `licenses/`, `scripts/`, `sidecars/`, `DECISIONS.md`,
`docs/JAROD-OS.md`, les fichiers de configuration du workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`).

## Ce qui n'a pas été copié

- `packages/desktop` : l'application Electron de Jarod (Jarod-One). Son rôle est tenu par le shell de Jarod-OS (`apps/desktop`, interface dérivée de Herald OS).
- Les documents de phase et de spécification, `workspace/`, les sauvegardes et le plan de travail de `jarod-cordis`.

## Ce qui a été adapté

- `package.json` et `pnpm-workspace.yaml` : nom `jarod-core`, plus de dépendances propres à l'application desktop (`electron`, `node-pty`), plus de script `dist`.
- Tests retirés parce qu'ils ne portaient que sur `packages/desktop` : les gardes de la sonde de fumée (8 fichiers), `sank-ui-protected`, le crochet git `pre-commit`.
  `tests/repo/effect-paths.test.ts` ne compte plus les appels du desktop et vérifie qu'aucun `ipcMain` n'apparaît dans le noyau.
- Scripts retirés : `channels-count`, `sweep-temp`, `sank-manifest` (ils importaient `packages/desktop`).
- Le lanceur de `jarod-cordis` (`gateway/launch.ts`, `scripts/Jarod-OS.cmd`) et son test : c'est le shell (`apps/desktop/electron/backend/`) qui démarre le noyau.
- Ajouts : `setBundledPlugins` dans le noyau, `scripts/bundle-gateway.mjs` et `packages/cli/test/gateway-bundle.test.ts` (compilation en un fichier pour l'application installée).
- Lockfile : l'importeur `packages/desktop` en est retiré ; les versions résolues des autres paquets sont celles de l'origine.

## Vérifié sur la copie (Windows 11, Node 24.20, pnpm 12.6)

`pnpm install --prefer-frozen-lockfile`, `pnpm -r typecheck` et `pnpm -r test` passent, avec les mêmes totaux qu'à l'origine pour chaque paquet
(llm : 290 ; agent : 243 ; tools : 210 ; rag : 164 + 13 ignorés ; …) sauf `cli` : 350 + 1 échec attendu (355 à l'origine : 8 tests du lanceur retirés, 3 de la passerelle
compilée ajoutés). Les tests racine passent à 226 (269 à l'origine : la différence est celle des tests retirés ci-dessus).

## Écarts voulus depuis la copie

- Le message d'erreur de dépassement de contexte (`plugins/llm/src/openai.ts`) ne renvoie plus à « Paramètres → Local engine » de l'application Jarod (inexistant dans Jarod-OS) :
  il nomme le réglage « Context Length » de LM Studio et `lms load <modèle> --context-length 16384`. Test ajouté.
- `cli/src/context.ts` : `settings.secretKeys()` liste tout le coffre lisible et les clés de l'environnement (et non plus seulement la clé principale des fournisseurs à variable d'environnement) ; `settings.keySources()` dit d'où vient chaque clé. Voir `PARITY.md`.
- Ajout : `cli/src/gateway/providers.ts` et ses routes `/api/jarod/providers*` (écran Fournisseurs du shell), test `cli/test/gateway-providers.test.ts`.
- Ajout : `packages/bridge` (`@jarod/bridge`) = les handlers de l'application jarod-cordis (`packages/desktop/src/main/handlers/*` + leurs modules de support et les tests, copiés du commit `2d5bf46d`), sans Electron ni pty (`terminal-*` écartés : 271 canaux au lieu de 277), servis par la passerelle (`POST /api/jarod/invoke`, `jarod.event`, `jarod.shell`) : voir `PARITY.md`. Tests retirés : ceux qui lisent l'`index.ts`, le `scripts/` ou les ressources du desktop.
