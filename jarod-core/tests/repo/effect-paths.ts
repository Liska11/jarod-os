/**
 * Q19 — carte des chemins d'effet (BESOINS Q19, PHASE-4 « Q19 ») : classement des 64 outils du registre (78 sous Windows) et des
 * 31 commandes `/` tels que le kernel les charge. Le test `effect-paths.test.ts` échoue si un outil ou une
 * commande apparaît (ou disparaît) sans être classé ICI : ajouter un chemin d'effet exige de dire ce qu'il fait.
 *
 * Classes d'effet :
 *   lecture     — ne change rien (une requête réseau en lecture seule reste « lecture »)
 *   conversation— écrit un état propre à UNE conversation (effaçable avec elle)
 *   persistant  — écrit ce qui survit à la conversation (mémoire, profil, annotations, index, planification…)
 *   fichiers    — écrit ou supprime des fichiers
 *   exécution   — lance des processus
 *   réseau      — requête sortante pouvant emporter des données ou déclencher un effet distant
 *   envoi       — envoie un message ou un fichier vers une passerelle de messagerie
 *   agent       — lance un sous-agent (LLM) sous les garanties de `delegate_task`
 *   réglage     — change un réglage du profil
 *   machine     — change l'état de l'ordinateur (volume, thème, écrans, notification)
 */
export type EffectClass = "lecture" | "conversation" | "persistant" | "fichiers" | "exécution" | "réseau" | "envoi" | "agent" | "réglage" | "machine";

export interface ToolClass {
  effect: EffectClass;
  /** Attendu du registre : l'outil exige l'accord de l'utilisateur (`dangerous`). */
  approval: boolean;
  /** Pourquoi un outil qui a un effet n'exige pas d'accord (obligatoire quand `effect !== "lecture"` et `approval` faux). */
  why?: string;
}

const ro: ToolClass = { effect: "lecture", approval: false };
const ask = (effect: EffectClass): ToolClass => ({ effect, approval: true });
const free = (effect: EffectClass, why: string): ToolClass => ({ effect, approval: false, why });

export const TOOLS: Readonly<Record<string, ToolClass>> = {
  android_devices: ro,
  android_shell: ask("exécution"),
  annotate_line: free("persistant", "annotation locale d'un fichier du dossier de travail, réversible (`annotation_remove`)"),
  annotation_remove: free("persistant", "retire une annotation locale"),
  annotations_list: ro,
  // File 4d (SPECS-P5-AUTOMATION.md) : CRUD des règles « quand X alors Y ». lecture = aucun effet ;
  // écriture = persistant (une règle survit à la conversation et déclenche des exécutions) ;
  // `automation_run` exécute IMMÉDIATEMENT les actions (agent ou notification) → exécution.
  // Cockpit, lot 5 : artefacts. Enregistrer = une ligne en base sur un fichier DÉJÀ écrit (confiné au dossier de travail) ; lister = lecture.
  artifact_list: ro,
  artifact_register: free("persistant", "référence un fichier du dossier de travail déjà écrit (empreinte en base) ; ne crée ni ne modifie aucun fichier"),
  automation_create: ask("persistant"),
  automation_delete: ask("persistant"),
  automation_get: ro,
  automation_list: ro,
  automation_run: ask("exécution"),
  automation_update: ask("persistant"),
  // Cockpit, lot 1 : lit le registre vivant. `check` resonde : lance SEULEMENT le programme d'une intégration avec un argument de diagnostic constant.
  capabilities: free("exécution", "sondes de diagnostic à arguments constants (--version, --help, -version, docker info), sans shell, délai de 8 s ; aucun argument venu du modèle, aucun fichier cible"),
  // File 4c (SPECS-P5-LSP.md) : diagnostics/navigation LSP. Le registre n'exige PAS d'accord
  // (dangerous absent) ; c'est LspManager qui en demande UN avant tout démarrage de serveur (G1).
  // G16 : `ocr delegate preview|rule` — lit le dépôt git du dossier de travail ; ni modèle, ni réseau, ni écriture (profil redirigé).
  permissions_explain: free("lecture", "lit les règles de permissions et la décision du garde pour un appel décrit ; n'écrit rien (seul un canal de l'utilisateur écrit les règles)"),
  code_review_plan: free("exécution", "lance OpenCodeReview en mode délégation (aperçu, règles) : lecture du dépôt seulement, sans modèle ni réseau, profil d'OCR redirigé dans un dossier temporaire, aucune écriture dans le dépôt"),
  code_diagnostics: free("exécution", "démarrage d'un serveur de langage soumis à l'accord G1 de LspManager (porte ctx.approve) ; lecture seule une fois lancé"),
  code_navigate: free("exécution", "idem code_diagnostics : accord G1 avant démarrage du serveur, navigation en lecture"),
  compact: ask("persistant"),
  cronjob: ask("persistant"),
  cronjob_list: ro,
  delegate_task: free("agent", "sous-agent en lecture seule, borné (3 simultanés), journalisé"),
  // Q19-4 : tout outil de plugin exige l'accord tant que l'UTILISATEUR ne l'a pas classé (`/plugin trust`) — y compris ce témoin de lecture.
  des_roll_dice: ask("lecture"),
  diff_numbered: ro,
  // Cockpit, lot 5 : écrit un .svg dans le dossier de travail.
  diagram_export: ask("fichiers"),
  edit_file: ask("fichiers"),
  // Cockpit, lot 7 : lance `hyperframes render` (local) et écrit la vidéo dans le dossier de travail.
  video_render: ask("exécution"),
  // Cockpit, lot 6 : lancent un analyseur STATIQUE (Ghidra headless / REA) sur un fichier du dossier de travail ; la cible n'est jamais exécutée.
  ghidra_analyze: ask("exécution"),
  rea_static: ask("exécution"),
  find_files: ro,
  http_request: ask("réseau"),
  list_dir: ro,
  load_skill: ro,
  local_model_server: ask("exécution"),
  memory_save: free("persistant", "bloqué en mode Plan (PERSISTENT_TOOLS), absent des sous-agents ; souvenir réversible (/memory)"),
  memory_search: ro,
  // Cockpit, lot 3 : sorties volumineuses gardées hors du contexte, de la conversation en cours.
  output_read: ro,
  output_search: ro,
  present: free("envoi", "n'écrit que vers la passerelle d'ORIGINE de la conversation (`gatewayChatOf`), jamais vers une cible choisie par le modèle"),
  rag_index: free("persistant", "indexe un chemin confiné au dossier de travail (`resolveInWorkspace`) dans l'index local"),
  rag_search: ro,
  read_file: ro,
  read_skill_file: ro,
  refine: ask("persistant"),
  refine_history: ro,
  refine_rollback: ask("persistant"),
  remote_exec: free("exécution", "demande lui-même l'accord pour CHAQUE commande (« une fois » ou « refuser » seulement), hôte activé et clé connue exigés, journal de contrôle obligatoire"),
  run_shell: ask("exécution"),
  search_files: ro,
  session_read: ro,
  session_search: ro,
  skill_hub_install: ask("réseau"),
  skill_hub_search: ro,
  skill_manage: ask("persistant"),
  spawn_subagent: free("agent", "sous-agent en lecture seule, non bloquant, borné comme `delegate_task`"),
  state_delete: free("conversation", "état de travail de la conversation (v18), plafonné 64 clés / 8 Ko, supprimé avec elle"),
  state_get: ro,
  state_list: ro,
  state_set: free("conversation", "état de travail de la conversation (v18), plafonné 64 clés / 8 Ko, supprimé avec elle"),
  subagent_cancel: free("agent", "n'arrête qu'un sous-agent de SA conversation"),
  subagent_list: ro,
  subagent_result: ro,
  // Cockpit, lot 2 : relit les actions de la conversation et leurs preuves.
  task_status: ro,
  tool_search: ro,
  user_profile: free("persistant", "bloqué en mode Plan (PERSISTENT_TOOLS), absent des sous-agents ; USER.md relu et corrigeable"),
  vault_list: ro,
  web_fetch: ask("réseau"),
  // Vague G (prompt plus3, 2026-10-20), outils du plugin integrations.
  // G5 : télécharge métadonnées, sous-titres ou audio d'une URL choisie par le modèle → réseau, accord à chaque appel (INTERNET_TOOLS).
  media_fetch: ask("réseau"),
  // D1 raccordé (2026-10-21), Windows seulement : la liste lit les titres (auditée) ; le pilotage agit sur une fenêtre (accord, sauf règle autonome).
  desktop_windows: free("lecture", "liste les fenêtres hors liste noire (gestionnaires de mots de passe, élévation, sécurité Windows) par le moteur FlaUI ; titres et processus seulement ; audité (`audited`)"),
  desktop_control: ask("machine"),
  // G15 (2026-10-21), Windows seulement, si Sandboxie-Plus est installé : un programme lancé dans le bac de Jarod (écritures dans le bac,
  // réseau coupé par défaut), la liste de ce qu'il a écrit, le vidage du bac.
  sandbox_run: ask("exécution"),
  sandbox_changes: free("lecture", "liste les fichiers que les programmes du bac Sandboxie ont écrits (dossier du bac seulement) ; audité (`audited`)"),
  sandbox_discard: ask("fichiers"),
  // G10 (2026-10-21), Windows seulement, si smolvm est présent : la machine Linux de Jarod (téléchargement d'image ; commande, réseau coupé
  // par défaut ; suppression de la machine).
  linux_prepare: ask("réseau"),
  linux_run: ask("exécution"),
  linux_reset: ask("fichiers"),
  // 2026-10-24 : espace de code (plugin-workspace, toutes plateformes) : un worktree git par tâche, des agents de code externes (Claude Code, Codex CLI)
  // dans ces worktrees, GitHub par `gh`, déploiements, simulateurs. Tout ce qui écrit ou sort de la machine exige l'accord ; les lectures n'écrivent rien.
  worktree_create: ask("fichiers"),
  worktree_diff: ro,
  worktree_merge: ask("fichiers"),
  cli_agent_run: ask("exécution"),
  team_run: ask("exécution"),
  github_list: ro,
  github_pr_view: ro,
  github_pr_create: ask("réseau"),
  deploy_run: ask("réseau"),
  simulator_list: free("exécution", "liste les appareils par `xcrun simctl list` et `adb devices` : arguments constants, sans shell, aucune écriture ; `adb devices` peut démarrer son démon local"),
  simulator_screenshot: ask("fichiers"),
  web_search: ro,
  write_file: ask("fichiers"),
  // 2026-10-11 : outils système Windows (packages/plugins/tools/src/system/). Les lectures sont `audited` (une ligne d'audit, sans accord).
  system_apps: ro,
  // G13 : osqueryi, 10 requêtes PRÉDÉFINIES (aucun SQL du modèle), droits de l'utilisateur, sans base ni journal ; ligne d'audit à chaque appel.
  system_diagnostics: free("exécution", "lance osqueryi en lecture seule : raccourci prédéfini, diagnostic paramétré (valeur validée) ou requête libre SELECT, opération RÉSERVÉE refusée sans règle de l'utilisateur (tables réseau curl refusées) ; droits de l'utilisateur, sans démon, sans base ni journal ; audité (`audited`)"),
  system_control: ask("machine"),
  system_disk_usage: ro,
  system_files: ask("fichiers"),
  system_files_plan: ro,
  system_find_files: ro,
  system_info: ro,
  system_kill_process: ask("exécution"),
  system_logs: ro,
  system_network: ro,
  system_open: ask("exécution"),
  system_processes: ro,
  system_quit_app: ask("exécution"),
  system_state: ro,
  // Pinokio (ADR-022) : enregistrés partout, offerts au modèle seulement quand Jarod-OS embarque le moteur (JAROD_PINOKIO_URL).
  pinokio_search: ro,
  pinokio_status: ro,
  pinokio_logs: ro,
  pinokio_install: ask("réseau"),
  pinokio_run: ask("exécution"),
  pinokio_stop: ask("exécution"),
  pinokio_open: free("machine", "montre une page de cet ordinateur (l'interface d'une app déjà lancée) dans une fenêtre Jarod-OS : rien n'est lancé, installé ni modifié"),
};

/** Les outils qui n'existent que sous Windows (`systemReadTools` & co. rendent une liste vide ailleurs) : attendus au registre seulement là. */
export const WINDOWS_ONLY: ReadonlySet<string> = new Set(Object.keys(TOOLS).filter((n) => n.startsWith("system_") || n.startsWith("desktop_") || n.startsWith("sandbox_") || n.startsWith("linux_")));

export interface CommandClass {
  effect: EffectClass | "interface";
  /** Ce que la commande change, quand elle change quelque chose. */
  changes?: string;
}

const view: CommandClass = { effect: "lecture" };

/** Les 31 commandes `/` (`CommandRegistry`) : au composer aucune ne passe par le garde d'outils (l'utilisateur est le principal) ; depuis une passerelle, elles passent par `executeRemoteCommand` (Q19-2). */
export const COMMANDS: Readonly<Record<string, CommandClass>> = {
  budget: { effect: "réglage", changes: "plafond de tokens/coût de la conversation ou global (`sessionBudget`)" },
  build: { effect: "réglage", changes: "mode Build : lève la lecture seule du mode Plan" },
  clear: { effect: "conversation", changes: "efface les messages de la conversation" },
  compact: { effect: "conversation", changes: "remplace l'historique ancien par un résumé (originaux gardés `compacted`)" },
  curator: { effect: "persistant", changes: "archive des skills inutilisées (`run` sans `dry-run`), épingle" },
  effort: { effect: "réglage", changes: "niveau d'effort du modèle" },
  help: view,
  hub: { effect: "réseau", changes: "installe, met à jour ou retire des skills publiques (accès réseau + écriture dans `skills/`)" },
  memory: { effect: "persistant", changes: "ajoute un souvenir (`/memory add`)" },
  model: { effect: "réglage", changes: "modèle actif du profil et de la conversation" },
  models: view,
  new: { effect: "interface", changes: "nouvelle conversation (action d'interface)" },
  pair: { effect: "persistant", changes: "appairage d'une passerelle — refusé côté passerelle (« uniquement dans l'application »)" },
  persona: { effect: "persistant", changes: "remplace la persona (SOUL.md / prompt système)" },
  plan: { effect: "réglage", changes: "mode Plan (lecture seule)" },
  plugin: { effect: "réglage", changes: "classe des outils de plugin « sans accord » (`trust`) ou rétablit l'accord (`distrust`) ; `list` seul est sans effet" },
  retry: { effect: "interface", changes: "relance la dernière réponse" },
  rewind: { effect: "fichiers", changes: "SUPPRIME/restaure des fichiers créés ou modifiés par l'agent (points de contrôle)" },
  roll: { effect: "lecture", changes: "commande d'exemple du plugin isolé (dés)" },
  search: view,
  settings: { effect: "interface", changes: "ouvre l'écran des réglages" },
  "shell-guard": view,
  skills: view,
  status: view,
  think: { effect: "réglage", changes: "raisonnement du modèle activé/coupé" },
  title: { effect: "conversation", changes: "régénère le titre (un appel modèle)" },
  tools: view,
  undo: { effect: "conversation", changes: "supprime le dernier échange" },
  usage: view,
  version: view,
  workspace: { effect: "réglage", changes: "dossier de travail : le périmètre des outils fichiers/shell de l'agent" },
};
