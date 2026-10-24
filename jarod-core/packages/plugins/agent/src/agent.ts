// Portage de packages/core/src/agent.ts (rév. 2e180305).
import { existsSync, readFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import type { ProviderRouter } from "@jarod/plugin-llm";
import { type ChatTurn, failoverKind, type ProviderClient, type ToolSpec } from "@jarod/contracts";
import type { AttachmentService } from "@jarod/plugin-rag";
import type { MemoryService } from "@jarod/plugin-memory";
import { supportsVision } from "@jarod/plugin-vision";
import { CAPABILITY_LABEL, chooseCapability, withRoute } from "./capability-routing.js";
/**
 * Port structurel de `PluginHost` (services/plugins.ts:236,251) : seules les deux coutures lues ici.
 * plugin-workflows (U2) le fournit, plugins isolés par processus : `beforeSend` peut donc être
 * asynchrone (un appel inter-processus l'est) ; sans plugin chargé, il rend le texte tel quel.
 */
export interface PluginHost {
  beforeSend(text: string): string | Promise<string>;
  afterResponse(text: string, sessionId: string): void;
  /** Lu par `/status` (core.ts:2168). */
  list(): { state: string }[];
}
import type { RoutingService } from "@jarod/plugin-llm";
import type { MessageService, SessionService } from "./sessions.js";
import type { Settings, SettingsService } from "@jarod/plugin-storage";
import type { SkillRegistry } from "@jarod/plugin-skills";
import { type Proof, type ToolContext, type ToolDef, type ToolRegistry, validateArgs } from "@jarod/plugin-tools";
import type { TaskLedger } from "./tasks.js";
import type { OutputStore } from "./outputs.js";
import type { Attachment, Message, ToolCall } from "@jarod/contracts";
import { auditArgs, redactCommandText } from "@jarod/kernel/redact";
import { detect as detectInjection, type InjectionCategory } from "@jarod/kernel/injection";
import { activePolicy, toolVerdict } from "@jarod/kernel/network";
import { newId, truncate } from "@jarod/kernel/util";
import { explainResolution, type Resolution, reservedReason, type ToolGate } from "@jarod/plugin-permissions";

export type AgentEvent =
  | { type: "message"; sessionId: string; message: Message; streamId?: string }
  | { type: "stream-start"; sessionId: string; streamId: string }
  | { type: "delta"; sessionId: string; streamId: string; text?: string; thinking?: string }
  | { type: "stream-reset"; sessionId: string; streamId: string }
  | { type: "tool-start"; sessionId: string; call: ToolCall }
  | { type: "history"; sessionId: string }
  | { type: "status"; sessionId: string; status: string }
  | { type: "session-updated"; sessionId: string }
  | { type: "error"; sessionId: string; error: string }
  | { type: "done"; sessionId: string };

export interface AgentHooks {
  emit(event: AgentEvent): void;
  /** Asks the user to approve a side-effecting tool call. */
  approve(sessionId: string, call: ToolCall, toolDescription: string): Promise<boolean>;
}

/**
 * La chaîne à essayer : le fournisseur actif d'abord, puis ceux que l'utilisateur a nommés.
 *
 * Un seul candidat n'était jamais un choix — c'était une absence de choix. Cet ordre est déclaré,
 * pas deviné : rien ne part chez un fournisseur dont l'utilisateur n'a pas écrit le nom, et une
 * chaîne vide rend exactement ce qu'on avait avant.
 */
export function candidateChain(
  s: { activeProvider: string; activeModel: string; fallbacks: { provider: string; model?: string }[] },
  routing: RoutingService,
): { provider: string; model: string }[] {
  const declared = [
    { provider: s.activeProvider, model: s.activeModel },
    ...(s.fallbacks ?? [])
      .filter((f) => f.provider)
      .map((f) => ({ provider: f.provider, model: f.model ?? s.activeModel })),
  ];
  // Les écartés passent derrière : le disjoncteur informe l'ordre, il ne supprime personne.
  return routing.order(declared);
}

/**
 * Where a turn goes when a call fails half-way: the next key of the same provider when the key
 * itself is refused (quota, rate limit), else the next provider of the declared chain. Each
 * (provider, model, key) is tried at most once per turn, so a turn always ends.
 */
export class FailoverPlan {
  private pos = 0;
  private keyPos = 0;
  private keys: number[];

  constructor(
    private readonly chain: { provider: string; model: string }[],
    private readonly keyOrder: (provider: string) => number[],
  ) {
    this.keys = chain.length ? keyOrder(chain[0]!.provider) : [0];
  }

  get current(): { provider: string; model: string; keyIndex: number } {
    return { ...this.chain[this.pos]!, keyIndex: this.keys[this.keyPos] ?? 0 };
  }

  /** True while another attempt remains after the current one. */
  hasNext(): boolean {
    return this.keyPos + 1 < this.keys.length || this.pos + 1 < this.chain.length;
  }

  /** Moves to the next attempt for this kind of failure; false when there is none left. */
  next(kind: "key" | "provider"): boolean {
    if (kind === "key" && this.keyPos + 1 < this.keys.length) {
      this.keyPos++;
      return true;
    }
    if (this.pos + 1 >= this.chain.length) return false;
    this.pos++;
    this.keys = this.keyOrder(this.chain[this.pos]!.provider);
    this.keyPos = 0;
    return true;
  }
}

/**
 * Message écrit quand le modèle termine un tour SANS aucun texte (ni appel d'outil) : il dit la vérité (le modèle n'a rien rédigé) et rend ce
 * qui est connu (dernier outil et son résultat, une ligne). Aucun appel de modèle de plus, aucun effet sur le titre ni sur la mémoire.
 */
export function emptyAnswerFallback(last: { name: string; content: string; isError: boolean } | null): string {
  const base = "(Le modèle n'a pas rédigé de réponse.)";
  if (!last) return base;
  const line = last.content.replace(/\s+/g, " ").trim().slice(0, 300);
  return `${base} ${last.isError ? `L'outil ${last.name} a échoué` : `Dernier outil : ${last.name}`}${line ? ` — ${line}` : ""}`;
}

export interface AgentDeps {
  sessions: SessionService;
  messages: MessageService;
  settings: SettingsService;
  memory: MemoryService;
  providers: ProviderRouter;
  /** La politique de repli : elle ordonne la chaîne et retient ce qui casse. */
  routing: RoutingService;
  tools: ToolRegistry;
  skills: SkillRegistry;
  plugins: PluginHost;
  /** Q18 : état de travail par conversation (optionnel : sans lui, aucun bloc dans le prompt). */
  state?: SessionStateService;
  attachments: AttachmentService;
  toolSearch: ToolSearchService;
  userProfile: UserProfileService;
  /** Images described for the models that cannot see them (absent: images are sent as they are). */
  vision?: ImageDescriber;
  vault?: VaultService;
  /** Where the audit log goes (the event store's `audit` stream). */
  audit?: (entry: AuditEntry) => void;
  /** Cockpit, lot 2 : le registre des tâches (étapes, preuve, annulation) de chaque action passée par la porte unique. */
  tasks?: TaskLedger;
  /** Cockpit, lot 3 : les sorties volumineuses gardées hors du contexte. */
  outputs?: OutputStore;
  /** Garde unifié fail-closed (plugin-permissions) consulté avant chaque appel d'outil. Jarod-cordis. */
  gate?: ToolGate;
  /** SOUL.md du profil (plugin-persona). Q4 = A : non vide, il remplace le réglage `persona`. Jarod-cordis. */
  persona?: { read(): string };
  /** G2 : traces locales (plugin-integrations les branche) ; absent = rien de mesuré. */
  spans?: SpanSink;
}

const MAX_HISTORY_CHARS = 600_000;
/** Estimation grossière de caractères par jeton (~4), la borne usuelle des fournisseurs. */
export const CHARS_PER_TOKEN = 4;

/**
 * Budget de caractères de l'historique envoyé au modèle. La fenêtre du modèle (`settings.contextWindow`,
 * en jetons) le resserre quand elle est connue : le dépassement est alors traité ici, avant l'envoi, au
 * lieu d'être découvert par l'erreur du fournisseur. Inconnue (0) : le plafond d'historique, qui reste la
 * borne haute dans tous les cas.
 */
export function historyBudget(windowTokens: number): number {
  if (!(windowTokens > 0)) return MAX_HISTORY_CHARS;
  return Math.min(MAX_HISTORY_CHARS, Math.floor(windowTokens * CHARS_PER_TOKEN));
}

/**
 * Fenêtre du modèle actif, en jetons, quand le noyau la connaît DÉJÀ : `contextWindow` (posé par
 * l'interface, prioritaire), sinon ce que la machine charge réellement — la longueur de contexte
 * demandée à LM Studio pour ce modèle, ou le `ctxSize` du préréglage llama.cpp actif. 0 : inconnue,
 * et on retombe sur le plafond d'historique. Aucune fenêtre n'est inventée pour un fournisseur distant.
 */
export function contextWindowFor(
  s: Pick<Settings, "contextWindow" | "localModels" | "localEngine">,
  provider: string,
  model: string,
): number {
  if (s.contextWindow > 0) return s.contextWindow;
  if (provider === "lmstudio") {
    const n = s.localModels?.lmstudioContext?.[model];
    return typeof n === "number" && n > 0 ? n : 0;
  }
  if (provider === "llamacpp") {
    const preset = s.localEngine?.presets.find((p) => p.id === s.localEngine?.activePreset);
    return preset && preset.ctxSize > 0 ? preset.ctxSize : 0;
  }
  return 0;
}

/** Project instruction files read from the workspace root, first found wins. */
export const PROJECT_FILES = ["JAROD.md", "AGENTS.md", "CLAUDE.md"];
const MAX_PROJECT_CHARS = 20_000;
/** Unanswered approvals are refused after this delay (a background run must not wait forever). */
export const APPROVAL_TIMEOUT_MS = 15 * 60_000;

/** Instructions for the agent kept in the workspace (AGENTS.md convention), or null. */
export function projectInstructions(workspace: string | null): { file: string; text: string } | null {
  if (!workspace) return null;
  for (const file of PROJECT_FILES) {
    const path = join(workspace, file);
    if (!existsSync(path)) continue;
    try {
      return { file, text: truncate(readFileSync(path, "utf8").trim(), MAX_PROJECT_CHARS) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolves with the user's decision, or false if the run is stopped or nobody answers in time. */
export function awaitApproval(
  decision: Promise<boolean>,
  signal?: AbortSignal,
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  // R3.5 — `signal` est facultatif : un appelant sans signal (commande distante) n'a plus à fabriquer
  // un contrôleur que personne ne détient ; l'échéance reste la borne.
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    decision.then(done, () => done(false));
  });
}
export const DEFAULT_TITLE = "Nouvelle conversation";
/** Tools a sub-agent may never use (no recursion, no durable side effects). */
// Q18 : l'état de travail du parent se LIT (state_get/list), il ne s'écrit pas depuis un enfant.
// Q18 : pas de sous-agent qui en lance (ou en arrête) d'autres.
const SUBAGENT_EXCLUDED = new Set([
  "delegate_task",
  "memory_save",
  "user_profile",
  "state_set",
  "state_delete",
  "spawn_subagent",
  "subagent_cancel",
]);
/** Tools that write what the agent will know in later conversations: not in plan mode. */
const PERSISTENT_TOOLS = new Set(["memory_save", "user_profile", "refine", "refine_rollback"]);
/**
 * What a sub-agent allowed to write still never gets: spawning more agents, touching the worktrees it
 * runs in, or writing things that outlive the task (skills, schedules, memory, installs).
 */
const WRITER_EXCLUDED = new Set([
  "delegate_task",
  "delegate_tasks",
  "spawn_subagent",
  "subagent_cancel",
  "memory_save",
  "user_profile",
  "refine",
  "refine_rollback",
  "skill_manage",
  "skill_hub_install",
  "cronjob",
  "worktree_create",
  "worktree_remove",
  "worktree_run",
  "ask_user",
]);

/** Suivi des appels d'outils d'un sous-agent : mêmes crochets que ceux d'un tour d'agent. */
export interface SubAgentToolHooks {
  /** Avant l'exécution, avec l'appel produit par le modèle. */
  onTool?(call: ToolCall): void;
  /** Après l'exécution : le nom, le résultat (déjà tronqué) et s'il s'agit d'une erreur. */
  onToolResult?(name: string, content: string, isError: boolean): void;
}

/**
 * Ce qu'un appelant peut préciser d'un sous-agent, sans changer le comportement par défaut :
 * sans option, `runSubAgent` fait exactement ce qu'il faisait (consignes du cœur, tous les outils
 * en lecture seule).
 */
export interface SubAgentOptions {
  /** Consignes ajoutées au prompt système — le rôle déclaré par un appelant (workflow, par ex.). */
  system?: string;
  /** Liste blanche de noms d'outils : le sous-agent n'est offert QU'À ceux-là (vide = aucun). */
  tools?: string[];
  /** Suivi des appels d'outils, pour un appelant qui affiche la progression. */
  hooks?: SubAgentToolHooks;
  /** Dossier de travail du sous-agent (un worktree, par ex.) au lieu de celui de la conversation. */
  workspace?: string;
  /**
   * Un sous-agent qui peut écrire : il reçoit aussi les outils sensibles (sauf WRITER_EXCLUDED), et
   * chacun passe par `approve` sauf ceux de `autoApproved` (les écritures de fichiers confinées à son
   * dossier, typiquement).
   */
  write?: {
    approve(call: ToolCall, toolDescription: string): Promise<boolean>;
    autoApproved: ReadonlySet<string>;
  };
}

export function toTurn(m: Message): ChatTurn {
  const t: ChatTurn = { role: m.role, content: m.content };
  if (m.toolCalls) t.toolCalls = m.toolCalls;
  if (m.toolCallId) t.toolCallId = m.toolCallId;
  if (m.toolName) t.toolName = m.toolName;
  if (m.isError) t.isError = true;
  if (m.provider) t.provider = m.provider;
  if (m.model) t.model = m.model;
  if (m.raw !== undefined) t.raw = m.raw;
  if (m.kind === "summary") t.content = `[Résumé de la conversation jusqu'ici]\n${m.content}`;
  return t;
}

const turnSize = (t: ChatTurn) =>
  t.content.length +
  JSON.stringify(t.toolCalls ?? []).length +
  (t.attachments ?? []).reduce((n, a) => n + (a.text?.length ?? 0), 0);

/**
 * Drops the oldest turns once history gets too large. It always cuts at a user message so a
 * tool call is never separated from its result. Last-resort safety net behind compaction.
 */
export function trimHistory(turns: ChatTurn[], maxChars = MAX_HISTORY_CHARS): ChatTurn[] {
  let total = turns.reduce((n, t) => n + turnSize(t), 0);
  let start = 0;
  while (total > maxChars && start < turns.length - 1) {
    total -= turnSize(turns[start]!);
    start++;
    while (start < turns.length - 1 && turns[start]!.role !== "user") {
      total -= turnSize(turns[start]!);
      start++;
    }
  }
  return turns.slice(start);
}

/**
 * The learning loop's standing instructions: turn a worked-out method into a skill, fix a skill
 * that proved wrong, and look up past conversations. Static text (prompt cache), and only the
 * lines whose tool is actually offered.
 */
export function learningSection(s: Pick<Settings, "agentMode" | "disabledTools">): string {
  const off = new Set(s.disabledTools);
  const lines: string[] = [];
  if (s.agentMode === "build" && !off.has("skill_manage")) {
    lines.push(
      "- Après une tâche en plusieurs étapes réussie dont la méthode resservira, propose de l'enregistrer avec skill_manage (create). Si une skill que tu as suivie s'est révélée incomplète ou fausse, corrige-la (patch).",
    );
  }
  if (!off.has("session_search")) {
    lines.push(
      "- Quand l'utilisateur évoque un échange passé, retrouve-le avec session_search puis session_read avant de répondre.",
    );
  }
  return lines.length ? `## Apprentissage\n${lines.join("\n")}` : "";
}

/** Renders messages as plain text for summarization. */
export function transcript(
  messages: Message[],
  maxChars = 200_000,
  keep: (text: string) => string = (text) => truncate(text, 6000),
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user")
      lines.push(`${m.kind === "summary" ? "RÉSUMÉ PRÉCÉDENT" : "UTILISATEUR"} : ${keep(m.content)}`);
    else if (m.role === "assistant") {
      if (m.content) lines.push(`ASSISTANT : ${keep(m.content)}`);
      for (const c of m.toolCalls ?? [])
        lines.push(`ASSISTANT → outil ${c.name} ${auditArgs(c.args, 500)}`);
    } else lines.push(`RÉSULTAT ${m.toolName ?? ""}${m.isError ? " (erreur)" : ""} : ${keep(m.content)}`);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  // Ce qui doit tomber en premier, ce sont les échanges les plus anciens — le milieu de
  // l'historique —, pas la tête : le début porte l'instruction de départ et le « RÉSUMÉ PRÉCÉDENT »
  // que `history()` place en tête. L'ancienne coupe (`text.slice(-maxChars)`) gardait la fin et
  // perdait ce début sans le dire. On garde donc la tête ET la fin, et on ne retire que le milieu.
  const head = Math.min(4_000, Math.floor(maxChars / 4));
  // Place réservée au marqueur de coupe, retours à la ligne compris : le libellé fait une
  // cinquantaine de caractères, le reste couvre un nombre omis de soixante-huit chiffres.
  const markerRoom = 120;
  const tail = Math.max(0, maxChars - head - markerRoom);
  if (tail === 0) return text.slice(0, maxChars);
  const kept = text.slice(text.length - tail);
  const omitted = text.length - head - kept.length;
  const marker = `… [${omitted} caractères omis : les échanges les plus anciens] …`;
  return `${text.slice(0, head)}\n${marker}\n${kept}`;
}

import { budgetRatio, budgetStopMessage, budgetWarnMessage, crossedWarning, limitsFor, usageOf } from "./budget.js";
import { LoopGuardService } from "./loop-guards.js";
import { type AccessProfile, autonomyHonoured, isAccessProfile, needsApproval } from "./access-profile.js";
import { NEVER_ALWAYS, NEVER_ALWAYS_REASONS } from "./never-always.js";
import { COCKPIT_PREROGATIVE } from "./prerogative.js";
import type { SessionStateService } from "./session-state.js";
import { SpillService } from "./spill.js";
import { RAG_TOOLS, type ToolSearchService } from "@jarod/plugin-tools";
import type { UserProfileService } from "@jarod/plugin-memory";
import type { VaultService } from "@jarod/plugin-rag";
import type { ImageDescriber } from "@jarod/plugin-vision";

export class Agent {
  /**
   * Appelle un fournisseur et inscrit ce qui s'est RÉELLEMENT passé.
   *
   * Le disjoncteur ne peut apprendre que d'issues observées : sans cet enregistrement, un
   * fournisseur peut échouer toute la journée sans que sa politique s'en aperçoive. Le temps est
   * mesuré ici pour la même raison — une latence annoncée par une fiche technique n'est pas une
   * mesure, et classer sur une promesse revient à classer au hasard.
   */
  /**
   * Le fournisseur ET le modèle à appeler : le premier candidat disponible de la chaîne déclarée. Les
   * deux voyagent ensemble — un repli vers un autre fournisseur avec le modèle du premier (un modèle
   * Claude envoyé à OpenAI) échouerait à coup sûr, c'est-à-dire exactement quand le repli sert.
   */
  private target(s: Settings): { provider: string; model: string } {
    const [candidat] = candidateChain(s, this.d.routing);
    return candidat ?? { provider: s.activeProvider, model: s.activeModel };
  }

  private async trace<T>(candidat: { provider: string; model: string }, run: () => Promise<T>, sessionId?: string): Promise<T> {
    const started = Date.now();
    // G2 : l'appel au modèle, rattaché au tour en cours de la conversation quand il y en a un. Le fournisseur seulement, jamais le modèle ni le texte.
    const span = this.d.spans?.start("llm.request", { "model.provider": candidat.provider }, sessionId ? this.turnSpans.get(sessionId) : undefined);
    try {
      const out = await run();
      this.d.routing.record(candidat, { ok: true, ms: Date.now() - started });
      span?.end("ok");
      return out;
    } catch (error) {
      this.d.routing.record(candidat, { ok: false });
      span?.end((error as Error)?.name === "AbortError" ? "cancelled" : "error");
      throw error;
    }
  }

  /** G2 : la trace du tour en cours, par conversation (parente des appels au modèle et aux outils). */
  private readonly turnSpans = new Map<string, SpanHandle>();

  constructor(private readonly d: AgentDeps) {}

  /**
   * Settings for a run in this conversation: the global ones, except the workspace, model and
   * mode, which are pinned to the conversation at its first run (a schedule or a Telegram chat
   * keeps working where it started even when the app switches folder).
   */
  /**
   * SPECS-P5-UI-PARITE.md § 13.3 : les PERMISSIONS sont lues à CHAQUE appel d'outil, pas une fois par tour. Une restriction (outil retiré de « toujours », accord automatique
   * éteint, mode Plan, garde du shell resserré, outil désactivé) vaut pour l'appel SUIVANT, y compris dans le tour en cours ; un octroi fait par la fenêtre d'accord (« toujours »)
   * vaut pour les appels suivants du même tour. Un appel déjà lancé n'est jamais interrompu. Le reste (dossier de travail, modèle…) garde l'instantané du début du tour.
   */
  private permissionsNow(sessionId: string, snapshot: Settings): Settings {
    const live = this.settingsFor(sessionId);
    return {
      ...snapshot,
      alwaysAllowTools: live.alwaysAllowTools,
      autoApproveTools: live.autoApproveTools,
      accessProfile: live.accessProfile,
      agentMode: live.agentMode,
      shellGuard: live.shellGuard,
      disabledTools: live.disabledTools,
    };
  }

  settingsFor(sessionId: string): Settings {
    const g = this.d.settings.getAll();
    const ctx = this.d.sessions.get(sessionId)?.context;
    if (!ctx) {
      if (this.d.sessions.get(sessionId)) {
        this.d.sessions.setContext(sessionId, {
          workspace: g.workspace,
          provider: g.activeProvider,
          model: g.activeModel,
          agentMode: g.agentMode,
        });
      }
      return g;
    }
    return {
      ...g,
      workspace: ctx.workspace,
      activeProvider: ctx.provider,
      activeModel: ctx.model || g.activeModel,
      agentMode: ctx.agentMode,
    };
  }

  /**
   * The system prompt stays identical from one request to the next (day-level date, memories
   * chosen from the conversation's first message) so the provider's prompt cache keeps working.
   */
  /** La persona effective : SOUL.md du profil s'il est non vide, sinon le réglage `persona` (Q4 = A). */
  personaOf(s: Settings): string {
    return this.d.persona?.read().trim() || s.persona;
  }

  buildSystemPrompt(query: string, s: Settings = this.d.settings.getAll()): string {
    // La persona dit le ton ; la prérogative dit le but, et aucune persona ne la remplace.
    const parts = [this.personaOf(s).trim(), COCKPIT_PREROGATIVE];
    const date = new Date().toLocaleDateString(s.language === "fr" ? "fr-FR" : "en-US", { dateStyle: "full" });
    parts.push(
      `## Contexte\n- Date : ${date}\n- Système : ${platform()} ${release()}\n- Dossier de travail : ${s.workspace ?? "aucun (les outils de fichiers et de shell sont indisponibles)"}`,
    );
    const project = projectInstructions(s.workspace);
    if (project)
      parts.push(`## Instructions du projet (${project.file})
${project.text}`);
    if (s.agentMode === "plan") {
      parts.push(
        "## Mode Plan (lecture seule)\nTu ne peux rien modifier : pas d'écriture de fichier ni de commande shell. Explore, lis, recherche, puis propose un plan d'action clair et numéroté que l'utilisateur pourra exécuter en passant en mode Build.",
      );
    }
    if (s.memoryInject) {
      const profile = this.d.userProfile.read();
      if (profile) parts.push(`## Profil de l'utilisateur (USER.md)\n${profile.replace(/^# .*\n?/, "").trim()}`);
      const mems = this.d.memory.relevant(query);
      if (mems.length) {
        parts.push(`## Ce que tu sais de l'utilisateur\n${mems.map((m) => `- (${m.type}) ${m.content}`).join("\n")}`);
      }
      if (s.agentMode === "build") {
        parts.push(
          "Quand l'utilisateur partage une information durable (préférence, fait personnel, contexte de projet), enregistre-la avec memory_save ; si elle change ton portrait de lui (qui il est, comment il travaille, ses projets), mets aussi à jour user_profile.",
        );
      }
    }
    const skills = this.d.skills.promptSection();
    if (skills) parts.push(skills);
    const learning = learningSection(s);
    if (learning) parts.push(learning);
    return parts.join("\n\n");
  }

  /** Every tool the model may use here: plan mode hides everything that has side effects. */
  private allSpecs(s: Settings): ToolSpec[] {
    const specs = this.d.tools.specs(s.disabledTools);
    if (s.agentMode !== "plan") return specs;
    return specs.filter((t) => !this.d.tools.get(t.name)?.dangerous && !PERSISTENT_TOOLS.has(t.name));
  }

  /**
   * Tools offered to the model. With `lean` (tool search), only the core set and what the
   * conversation activated; otherwise all of them, without `tool_search`, which has nothing to find.
   */
  toolSpecs(s: Settings, lean?: { sessionId: string }): ToolSpec[] {
    const all = this.allSpecs(s);
    return lean ? this.d.toolSearch.lean(lean.sessionId, all, this.extraCoreTools()) : all.filter((t) => t.name !== "tool_search");
  }

  /** The RAG tools join the core set while the RAG is on (see RAG_TOOLS). A settings read that fails changes nothing. */
  private extraCoreTools(): ReadonlySet<string> {
    try {
      return this.d.settings.get("rag").enabled === true ? RAG_TOOLS : new Set();
    } catch {
      return new Set();
    }
  }

  /** Tool search is on when asked for, or by default for a local model (small context, slow prefill). */
  useToolSearch(s: Settings, provider: string): boolean {
    if (s.toolSearch === "on") return true;
    if (s.toolSearch === "off") return false;
    try {
      return this.d.providers.def(provider).local === true;
    } catch {
      return false;
    }
  }

  /** First user message of the conversation: a stable key for choosing memories. */
  private memoryQuery(sessionId: string, fallback: string): string {
    const first = this.d.messages.history(sessionId).find((m) => m.role === "user" && m.kind !== "summary");
    return first?.content || fallback;
  }

  private turns(sessionId: string): ChatTurn[] {
    return this.d.messages.history(sessionId).map((m) => {
      const t = toTurn(m);
      if (m.attachments?.length) t.attachments = m.attachments.map((a) => this.d.attachments.load(a));
      return t;
    });
  }

  /**
   * Runs one agent turn: streams the model, executes requested tools (asking for approval
   * when needed) and loops until the model answers without tool calls.
   * Pass `text: null` to regenerate the answer to the last user message.
   */
  async run(
    sessionId: string,
    text: string | null,
    signal: AbortSignal,
    hooks: AgentHooks,
    attachments: Attachment[] = [],
  ): Promise<void> {
    const { messages, providers, plugins } = this.d;
    const emit = hooks.emit;
    let finalText = "";
    /** Dernier outil exécuté dans ce tour : sert au message de repli d'une réponse finale blanche. */
    let lastTool: { name: string; content: string; isError: boolean } | null = null;

    // H4 : le PRÉAMBULE est couvert. `plugins.beforeSend`, `messages.add`, `settingsFor` et
    // `buildSystemPrompt` peuvent lever ; comme ils s'exécutaient AVANT le `try` du tour, `done` n'était
    // alors jamais émis : `runAndWait` ne rendait jamais la main (tâche planifiée, automation ou webhook
    // bloqués pour toujours, écran figé en « génération ») et le rejet partait en « unhandled » (processus
    // arrêté sous Node, `jarod serve`). Ici, toute panne du préambule ferme le tour proprement.
    let prepared: { query: string; firstExchange: boolean; s: Settings; system: string } | null = null;
    try {
      prepared = await this.prepareTurn(sessionId, text, attachments, emit);
    } catch (err) {
      emit({ type: "error", sessionId, error: (err as Error).message });
      emit({ type: "done", sessionId });
      return;
    }
    // `null` = « Rien à régénérer » : `prepareTurn` a déjà annoncé l'erreur et fermé le tour.
    if (!prepared) return;
    const { query, firstExchange, s, system } = prepared;

    // M6 : la garde anti-boucle est PAR TOUR. Une instance partagée gardait le compteur d'un tour à l'autre
    // ET d'une conversation à l'autre : trois conversations faisant chacune UN appel identique finissaient
    // par recevoir « tu tournes en rond », et deux conversations simultanées s'effaçaient mutuellement le
    // compteur. Le tour d'aujourd'hui ne doit rien savoir de celui d'hier (c'est ce que dit `reset()`).
    const loopGuard = new LoopGuardService();
    const turnSpan = this.d.spans?.start("conversation.turn", { "session.id": sessionId });
    if (turnSpan) this.turnSpans.set(sessionId, turnSpan);
    let turnFailed = false;

    try {
      // V-19 : ce que CE tour demande (une image que le modèle actif ne voit pas, un long historique, du code) choisit la route
      // déclarée pour cette capacité ; elle passe en tête, les replis restent derrière. Modèle épinglé : jamais re-routé.
      const declaredChain = candidateChain(s, this.d.routing);
      const routed = chooseCapability(
        {
          text: query,
          hasImage: attachments.some((a) => a.mime.startsWith("image/")),
          activeSeesImages: supportsVision(s.activeProvider, s.activeModel),
          historyTokens: Math.ceil((system.length + messages.list(sessionId).reduce((n, m) => n + m.content.length, 0)) / CHARS_PER_TOKEN),
          activeWindow: contextWindowFor(s, s.activeProvider, s.activeModel),
        },
        s.capabilityRouting,
        this.d.sessions.get(sessionId)?.context?.modelPinned === true,
      );
      const chain = routed ? withRoute(declaredChain, routed.route) : declaredChain;
      if (routed) {
        emit({ type: "status", sessionId, status: `Modèle pour ${CAPABILITY_LABEL[routed.capability]} : ${routed.route.provider} · ${routed.route.model} (${routed.reason}).` });
        turnSpan?.set({ "jarod.capability": routed.capability });
      }
      const plan = new FailoverPlan(
        chain.length ? chain : [{ provider: s.activeProvider, model: s.activeModel }],
        (p) => providers.keyOrder(p),
      );
      let cible = plan.current;
      let client: ProviderClient;
      // A candidate without a key is skipped like a candidate that does not answer.
      for (;;) {
        try {
          client = providers.client(cible.provider, cible.keyIndex);
          break;
        } catch (err) {
          if (!plan.next("provider")) throw err;
          cible = plan.current;
        }
      }
      let lean = this.useToolSearch(s, cible.provider) ? { sessionId } : undefined;
      const label = (c: { provider: string; model: string }) => {
        try {
          return `${providers.def(c.provider).name} · ${c.model}`;
        } catch {
          return `${c.provider} · ${c.model}`;
        }
      };

      // Cockpit, lot 4 : quand billion-context compresse l'historique de ce fournisseur, Jarod ne compacte pas en plus (une seule autorité).
      const proxied = s.contextProxy?.enabled === true && (s.contextProxy.providers ?? []).includes(cible.provider);
      if (s.compactThreshold > 0 && !proxied) {
        const size = this.turns(sessionId).reduce((n, t) => n + turnSize(t), 0);
        if (size > s.compactThreshold) {
          emit({ type: "status", sessionId, status: "Compaction du contexte…" });
          const done = await this.compact(sessionId, signal, s).catch(() => null);
          if (done) emit({ type: "history", sessionId });
        }
      }

      // G4 : plafond relu à chaque étape (un `/budget` d'une autre fenêtre compte tout de suite).
      const budget = () => {
        const limits = limitsFor(this.d.settings.get("sessionBudget"), sessionId);
        // Aucun plafond actif (défaut) : rien à relire.
        if (limits.maxTokens <= 0 && limits.maxCostUsd <= 0) return { limits, list: [], usage: usageOf([]), ratio: null };
        const list = messages.list(sessionId);
        const usage = usageOf(list);
        return { limits, list, usage, ratio: budgetRatio(usage, limits) };
      };
      let overBudget = false;
      // L'avis de troncature est PAR TOUR : le contexte est réévalué à chaque étape, mais l'utilisateur
      // n'a pas à relire la même phrase à chaque outil appelé.
      let truncationWarned = false;
      for (let step = 0; step < s.maxAgentSteps; step++) {
        if (signal.aborted) break;
        {
          const b = budget();
          if (b.ratio !== null && b.ratio >= 1) {
            emit({ type: "error", sessionId, error: budgetStopMessage(b.usage, b.limits) });
            break;
          }
        }
        const streamId = newId();
        emit({ type: "stream-start", sessionId, streamId });
        let partialText = "";
        let partialThinking = "";

        const window = contextWindowFor(s, cible.provider, cible.model);
        const tools = this.toolSpecs(s, lean);
        const full = this.turns(sessionId);
        // Recomputed each step: a tool_search call activates tools for the next one.
        const systemText = lean
          ? [system, this.d.toolSearch.indexSection(sessionId, this.allSpecs(s), this.extraCoreTools())].filter(Boolean).join("\n\n")
          : system;
        // La fenêtre borne TOUT ce qui part : prompt système, outils, historique et réponse. L'historique
        // n'a donc droit qu'à ce qui reste une fois le prompt et les outils décomptés (marge ≈ 1 000 jetons).
        const reserve = systemText.length + JSON.stringify(tools).length + 4_000;
        const budgetChars = window > 0 ? Math.max(2_000, historyBudget(window) - reserve) : historyBudget(0);
        let history = trimHistory(full, budgetChars);
        if (history.length < full.length && !truncationWarned) {
          truncationWarned = true;
          const reason =
            window > 0 ? `la fenêtre du modèle (${window} jetons)` : "la taille maximale de l'historique";
          emit({
            type: "status",
            sessionId,
            status: `Contexte trop large pour ${reason} : ${full.length - history.length} message(s) ancien(s) écarté(s).`,
          });
        }
        let result: Awaited<ReturnType<typeof client.chat>>;
        try {
          if (this.d.vision?.needed(cible)) {
            history = await this.d.vision.prepare(history, signal, (name) =>
              emit({ type: "status", sessionId, status: `Description de l'image « ${name} »…` }),
            );
          }
          result = await this.trace(cible, () =>
            client.chat(
              {
                model: cible.model,
                system: systemText,
                messages: history,
                tools,
                signal,
                thinking: s.thinking,
                effort: s.effort,
                anthropicFallbacks: s.anthropicFallbacks,
                // A fallback is ready: one quick retry, then hand over instead of waiting.
                ...(plan.hasNext() ? { maxAttempts: 2 } : {}),
              },
              {
                onText: (d) => {
                  partialText += d;
                  emit({ type: "delta", sessionId, streamId, text: d });
                },
                onThinking: (d) => {
                  partialThinking += d;
                  emit({ type: "delta", sessionId, streamId, thinking: d });
                },
                onReset: () => {
                  partialText = "";
                  partialThinking = "";
                  emit({ type: "stream-reset", sessionId, streamId });
                },
              },
            ),
            sessionId,
          );
        } catch (err) {
          if (signal.aborted) {
            // Keep whatever was streamed before the user pressed stop.
            if (partialText || partialThinking) {
              const msg = messages.add(sessionId, {
                role: "assistant",
                content: `${partialText}\n\n*[interrompu]*`,
                ...(partialThinking ? { thinking: partialThinking } : {}),
                provider: cible.provider,
                model: cible.model,
              });
              emit({ type: "message", sessionId, message: msg, streamId });
            }
            break;
          }
          const kind = failoverKind(err);
          const from = cible;
          let switched = false;
          while (kind && plan.next(kind)) {
            try {
              client = providers.client(plan.current.provider, plan.current.keyIndex);
              cible = plan.current;
              switched = true;
              break;
            } catch {
              // No key for this one either: keep going down the chain.
            }
          }
          if (!switched) throw err;
          lean = this.useToolSearch(s, cible.provider) ? { sessionId } : undefined;
          const why = (err as Error).message.split("\n")[0]!.slice(0, 120);
          const target =
            cible.provider === from.provider && cible.model === from.model
              ? `${label(cible)}, autre clé API`
              : label(cible);
          emit({ type: "stream-reset", sessionId, streamId });
          emit({ type: "status", sessionId, status: `${label(from)} indisponible (${why}) — bascule sur ${target}` });
          // Same step again, on the new target: a failover is not a step of the agent.
          step--;
          continue;
        }
        providers.keyWorked(cible.provider, cible.keyIndex);

        // Réponse finale BLANCHE (constatée avec le vrai modèle local après un outil réussi) : un message de repli honnête plutôt qu'une bulle vide.
        let shown = result.text;
        if (result.toolCalls.length === 0 && !shown.trim() && !signal.aborted) {
          shown = emptyAnswerFallback(lastTool);
          emit({ type: "delta", sessionId, streamId, text: shown });
        }
        const assistant = messages.add(sessionId, {
          role: "assistant",
          content: shown,
          ...(result.thinking ? { thinking: result.thinking } : {}),
          ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
          provider: cible.provider,
          model: result.servedModel ?? cible.model,
          ...(result.raw !== undefined ? { raw: result.raw } : {}),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          ...(result.cacheReadTokens ? { cacheReadTokens: result.cacheReadTokens } : {}),
          ...(result.cacheWriteTokens ? { cacheWriteTokens: result.cacheWriteTokens } : {}),
        });
        emit({ type: "message", sessionId, message: assistant, streamId });
        finalText = result.text;
        {
          const b = budget();
          if (b.ratio !== null && b.ratio >= 1) overBudget = true;
          else if (crossedWarning(b.list, b.limits)) {
            emit({ type: "status", sessionId, status: budgetWarnMessage(b.usage, b.limits) });
          }
        }

        if (result.toolCalls.length === 0) break;

        for (const call of result.toolCalls) {
          // Every tool call must get a result, even when stopped, or the next request is invalid.
          emit({ type: "tool-start", sessionId, call });
          const { content, isError } = signal.aborted
            ? { content: "Interrompu par l'utilisateur.", isError: true }
            : overBudget
              ? { content: "Non exécuté : plafond de la conversation atteint.", isError: true }
              : await loopGuard.guard(call.name, () => this.executeTool(sessionId, call, signal, hooks, this.permissionsNow(sessionId, s)));
          // Le rappel voyage DANS le résultat de l'outil : le modèle le lit, et aucun nouveau type
          // de message n'entre dans la requête suivante.
          const repeat = loopGuard.observe(call.name, call.args);
          const toolMsg = messages.add(sessionId, {
            role: "tool",
            content: repeat.reminder ? `${content}\n\n${repeat.reminder}` : content,
            toolCallId: call.id,
            toolName: call.name,
            ...(isError ? { isError: true } : {}),
          });
          emit({ type: "message", sessionId, message: toolMsg });
          lastTool = { name: call.name, content, isError: isError === true };
          // Q18 : l'outil `compact` a remplacé l'historique ancien par un résumé — l'écran se recharge.
          if (call.name === "compact" && !isError && content.startsWith("Contexte compacté")) {
            emit({ type: "history", sessionId });
          }
        }

        if (overBudget) {
          const b = budget();
          emit({ type: "error", sessionId, error: budgetStopMessage(b.usage, b.limits) });
          break;
        }
        if (step === s.maxAgentSteps - 1) {
          emit({
            type: "error",
            sessionId,
            error: `Limite de ${s.maxAgentSteps} étapes atteinte. Écrivez « continue » pour poursuivre.`,
          });
        }
      }
      if (finalText) plugins.afterResponse(finalText, sessionId);
    } catch (err) {
      turnFailed = true;
      emit({ type: "error", sessionId, error: (err as Error).message });
    } finally {
      if (turnSpan) {
        turnSpan.end(signal.aborted ? "cancelled" : turnFailed ? "error" : "ok");
        if (this.turnSpans.get(sessionId) === turnSpan) this.turnSpans.delete(sessionId);
      }
      emit({ type: "done", sessionId });
    }

    if (firstExchange && finalText && s.autoTitle && !signal.aborted) {
      void this.generateTitle(sessionId, query, finalText, s).then(
        (ok) => ok && emit({ type: "session-updated", sessionId }),
      );
    }
  }

  /**
   * H4 — le préambule d'un tour, sorti de `run()` pour que son échec puisse être rattrapé.
   *
   * Il envoie le message de l'utilisateur (titre de la première échange compris), prépare les réglages du tour
   * et le prompt système. Rend `null` quand il n'y a « Rien à régénérer » — le tour est alors déjà clos (erreur
   * + `done` émis). Toute autre panne remonte à `run()`, qui ferme le tour au lieu de laisser l'appelant sans
   * réponse (tâche planifiée, automation, webhook) et sans laisser fuiter un rejet non géré.
   */
  private async prepareTurn(
    sessionId: string,
    text: string | null,
    attachments: Attachment[],
    emit: AgentHooks["emit"],
  ): Promise<{ query: string; firstExchange: boolean; s: Settings; system: string } | null> {
    const { messages, sessions, plugins } = this.d;
    let query = text ?? "";
    let firstExchange = false;

    if (text !== null) {
      const content = await plugins.beforeSend(text);
      query = content;
      const userMsg = messages.add(sessionId, {
        role: "user",
        content,
        ...(attachments.length ? { attachments } : {}),
      });
      emit({ type: "message", sessionId, message: userMsg });
      const session = sessions.get(sessionId);
      if (session && session.title === DEFAULT_TITLE) {
        firstExchange = true;
        const title = (content || attachments[0]?.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (title) sessions.rename(sessionId, title);
      }
    } else {
      const last = messages.truncateAfterLastUser(sessionId);
      if (!last) {
        emit({ type: "error", sessionId, error: "Rien à régénérer." });
        emit({ type: "done", sessionId });
        return null;
      }
      query = last.content;
      emit({ type: "history", sessionId });
    }

    const s = this.settingsFor(sessionId);
    const base = this.buildSystemPrompt(this.memoryQuery(sessionId, query), s);
    // Q18 : l'état de travail de la conversation, en fin de prompt système — il survit donc à la compaction.
    const working = this.d.state?.summary(sessionId) ?? "";
    return { query, firstExchange, s, system: working ? `${base}\n\n${working}` : base };
  }

  /** Là où l'agent déplace ce qui ne rentre plus : un fichier relisible, pas une donnée jetée. */
  private spillFor(workspace: string): SpillService {
    return new SpillService({ root: workspace });
  }

  private executeTool(
    sessionId: string,
    call: ToolCall,
    signal: AbortSignal,
    hooks: AgentHooks,
    s: Settings,
  ): Promise<{ content: string; isError: boolean }> {
    return executeGuardedTool(this.d.tools, sessionId, call, signal, hooks, s, {
      ...(this.d.vault ? { vault: this.d.vault } : {}),
      ...(this.d.audit ? { audit: this.d.audit } : {}),
      ...(this.d.gate ? { gate: this.d.gate } : {}),
      ...(this.d.tasks ? { tasks: this.d.tasks } : {}),
      ...(this.d.outputs ? { outputs: this.d.outputs } : {}),
      ...(this.d.spans ? { spans: this.d.spans } : {}),
      ...(this.turnSpans.has(sessionId) ? { parentSpan: this.turnSpans.get(sessionId)! } : {}),
    });
  }

  /** One-shot completion without tools (workflows, titles, summaries). */
  async complete(
    prompt: string,
    signal: AbortSignal,
    opts: { system?: string; thinking?: boolean; settings?: Settings; maxTokens?: number } = {},
  ): Promise<string> {
    const s = opts.settings ?? this.d.settings.getAll();
    // Le premier candidat disponible, pas le fournisseur actif aveuglément : une chaîne vide
    // rend exactement l'ancien comportement, donc personne n'est basculé sans l'avoir écrit.
    const cible = this.target(s);
    const client = this.d.providers.client(cible.provider);
    const r = await this.trace(cible, () =>
      client.chat(
        {
          model: cible.model,
          system: opts.system ?? this.personaOf(s),
          messages: [{ role: "user", content: prompt }],
          tools: [],
          signal,
          thinking: opts.thinking ?? s.thinking,
          effort: s.effort,
          anthropicFallbacks: s.anthropicFallbacks,
          ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        },
        {},
      ),
    );
    return r.text;
  }

  async generateTitle(
    sessionId: string,
    question: string,
    answer: string,
    s: Settings = this.settingsFor(sessionId),
  ): Promise<boolean> {
    try {
      const raw = await this.complete(
        `Donne un titre très court (3 à 6 mots, sans guillemets ni point final) à cette conversation, dans sa langue.\n\nQuestion : ${truncate(question, 1500)}\n\nRéponse : ${truncate(answer, 1500)}`,
        AbortSignal.timeout(30_000),
        {
          system: "Tu génères des titres de conversation. Réponds uniquement par le titre.",
          thinking: false,
          settings: s,
        },
      );
      const title = raw
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean)
        ?.replace(/^["'«#*\s]+|["'»*.\s]+$/g, "")
        .slice(0, 60);
      if (!title) return false;
      this.d.sessions.rename(sessionId, title);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Summarizes everything before the last two user turns into a single summary message.
   * Returns false when the conversation is too short to be worth compacting.
   */
  async compact(
    sessionId: string,
    signal: AbortSignal,
    s: Settings = this.settingsFor(sessionId),
    // Jarod-cordis (Q18, consigne de préservation de SANK-AI `context-compaction`) : ce qui doit survivre au résumé.
    preserve = "",
  ): Promise<boolean> {
    const history = this.d.messages.history(sessionId);
    const userIdx = history.map((m, i) => (m.role === "user" && m.kind !== "summary" ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length < 3) return false;
    const cut = userIdx[userIdx.length - 2]!;
    const older = history.slice(0, cut);
    const summary = await this.complete(
      `Résume la conversation ci-dessous pour qu'un assistant puisse la poursuivre sans la relire. Conserve : objectifs de l'utilisateur, décisions prises, faits et chiffres importants, fichiers et commandes concernés, état d'avancement, questions en suspens. Sois dense et factuel (listes à puces).${preserve.trim() ? `\nConsigne de l'utilisateur, à respecter en priorité : ${preserve.trim()}` : ""}\n\n${transcript(
        older,
        200_000,
        (text) =>
          s.workspace ? this.spillFor(s.workspace).preview(sessionId, "contexte", text) : SpillService.fallback(text),
      )}`,
      signal,
      { system: "Tu résumes des conversations de travail avec précision.", thinking: false, settings: s },
    );
    if (!summary.trim()) return false;
    this.d.messages.compact(sessionId, history[cut]!.id, summary.trim());
    return true;
  }

  /**
   * Runs an isolated sub-agent on a self-contained task with read-only tools, in memory,
   * and returns its final answer. Keeps exploratory work out of the main conversation.
   *
   * `opts` (facultatif) précise les consignes supplémentaires, la liste d'outils autorisée et le
   * suivi des appels — les coutures d'un appelant comme `workflow-files`. Sans lui, rien ne change :
   * l'appelant qui ne passe pas d'options retrouve exactement le comportement d'avant.
   */
  async runSubAgent(
    task: string,
    signal: AbortSignal | undefined,
    sessionId: string,
    maxSteps = 12,
    opts: SubAgentOptions = {},
  ): Promise<string> {
    const s = this.settingsFor(sessionId);
    // Le premier candidat disponible, pas le fournisseur actif aveuglément.
    const cible = this.target(s);
    const client = this.d.providers.client(cible.provider);
    // Une liste blanche fournie s'applique EN PLUS des exclusions : elle ne peut pas réintroduire un
    // outil interdit à un sous-agent, mais elle peut en retirer.
    const allowed = opts.tools ? new Set(opts.tools) : null;
    const workspace = opts.workspace ?? s.workspace;
    const tools = this.d.tools
      .specs(s.disabledTools)
      .filter((t) =>
        opts.write
          ? !WRITER_EXCLUDED.has(t.name)
          : !SUBAGENT_EXCLUDED.has(t.name) && !this.d.tools.get(t.name)?.dangerous,
      )
      .filter((t) => !allowed || allowed.has(t.name));
    const turns: ChatTurn[] = [{ role: "user", content: task }];
    const role = opts.system ? `\n\n${opts.system}` : "";
    const how = opts.write
      ? "avec tes outils, y compris l'écriture de fichiers dans ton dossier de travail"
      : "avec tes outils en lecture seule";
    const system = `${this.buildSystemPrompt(task, { ...s, workspace, agentMode: opts.write ? "build" : "plan", memoryInject: false })}\n\n## Sous-agent\nTu es un sous-agent chargé d'une tâche précise. Travaille de façon autonome ${how}, puis rends un compte rendu final complet et autonome : c'est la seule chose que l'agent principal verra.${role}`;
    // Le contrôleur local est celui qu'on annule : il relaie le signal de l'appelant quand il y en a
    // un, et il reste annulable même sans signal. Sinon le contrôleur fabriqué ici était jeté
    // aussitôt, et plus rien en aval ne pouvait être interrompu.
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (let step = 0; step < maxSteps; step++) {
        const r = await this.trace(cible, () =>
          client.chat(
            {
              model: cible.model,
              system,
              messages: turns,
              tools,
              signal: ctrl.signal,
              thinking: s.thinking,
              effort: s.effort,
              anthropicFallbacks: s.anthropicFallbacks,
            },
            {},
          ),
        );
        turns.push({
          role: "assistant",
          content: r.text,
          ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}),
          provider: cible.provider,
          model: r.servedModel ?? cible.model,
          ...(r.raw !== undefined ? { raw: r.raw } : {}),
        });
        if (r.toolCalls.length === 0) return r.text || "(le sous-agent n'a rien renvoyé)";
        for (const call of r.toolCalls) {
          opts.hooks?.onTool?.(call);
          const tool = this.d.tools.get(call.name);
          let content: string;
          let isError = false;
          if (!tool || !tools.some((t) => t.name === call.name)) {
            content = `Outil indisponible pour un sous-agent : ${call.name}`;
            isError = true;
          } else {
            // Q19-1 : le même garde que le tour principal (règles de configuration, mode Plan, validation
            // des arguments, accord, audit). Le filtre ci-dessus reste : il décide de ce qui est OFFERT ;
            // le garde décide de ce qui s'EXÉCUTE. Un sous-agent en lecture seule n'a aucun accord à
            // demander (refus) ; celui qui écrit passe par `opts.write` et ses outils déjà autorisés.
            const write = opts.write;
            const out = await this.executeTool(
              sessionId,
              call,
              ctrl.signal,
              {
                emit: () => {},
                approve: (_sid, c, description) => (write ? write.approve(c, description) : Promise.resolve(false)),
              },
              { ...s, workspace, autoApproveTools: s.autoApproveTools || Boolean(write?.autoApproved.has(call.name)) },
            );
            content = truncate(out.content, 30_000);
            isError = out.isError;
          }
          // Le crochet reçoit ce que le résumé reçoit : le nom, le contenu déjà tronqué, l'erreur.
          opts.hooks?.onToolResult?.(call.name, content, isError);
          turns.push({
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
            ...(isError ? { isError: true } : {}),
          });
        }
      }
      const last = [...turns].reverse().find((t) => t.role === "assistant" && t.content);
      return `${last?.content ?? ""}\n\n[Sous-agent arrêté après ${maxSteps} étapes]`;
    } finally {
      // Sortie normale ou exception : on détache l'écouteur et on annule le contrôleur, pour que ce
      // qui aurait survécu en aval soit interrompu.
      signal?.removeEventListener("abort", onAbort);
      ctrl.abort();
    }
  }
}

/**
 * The single gate a model-produced tool call has to pass: a known and enabled tool, read-only in plan
 * mode, arguments matching the declared schema, and the user's approval before any side effect. Chat
 * runs and coding runs both come through here — a second entry point that forgot the approval would
 * be the hole, so there is no second entry point.
 */
/**
 * One line of the audit log. V-02 (2026-10-23) : CHAQUE appel qui atteint la porte unique en laisse une, lecture comprise — avant, seuls les
 * outils sensibles, audités ou refusés étaient inscrits. `sans accord` = un outil ordinaire qui a tourné sans rien demander ; `annulé` = arrêté
 * par l'utilisateur (tour ou tâche) ; `refusé (invalide)` = outil inconnu, désactivé, ou arguments hors schéma.
 */
export interface AuditEntry {
  sessionId: string;
  tool: string;
  /** The arguments, cut short: enough to know what was asked. */
  args: string;
  decision:
    | "accordé"
    | "refusé"
    | "automatique"
    | "bloqué (mode Plan)"
    | "refusé (règle)"
    | "autorisé (règle)"
    | "sans accord"
    | "annulé"
    | "refusé (invalide)";
  /** Set once the tool ran: whether it succeeded. */
  ok?: boolean;
  /** V-02 : l'identifiant de l'appel du modèle, celui que la conversation affiche, pour rattacher la ligne à son tour. */
  callId?: string;
  /** V-02 : le palier que l'outil déclare. Absent pour un outil inconnu. */
  tier?: AuditTier;
  /** V-02 : la cible que l'outil déclare (chemin, commande, adresse…), masquée comme les arguments et tronquée. */
  target?: string;
  /** V-02 : de l'arrivée de l'appel à la porte jusqu'à cette ligne, attente de l'accord comprise. */
  durationMs?: number;
  /** V-02 : le verdict de la vérification de l'effet, quand l'outil en a une (ou qu'il est sensible). */
  proof?: Proof["status"];
  /**
   * V-04 : les catégories d'injection repérées dans la SORTIE de l'outil (mode observation : la sortie passe inchangée au modèle). Jamais
   * l'extrait. Absent quand rien n'est repéré ou que l'outil n'a pas rendu de sortie.
   */
  injection?: InjectionCategory[];
  /**
   * V-08 : ce que la vérification a constaté (`Proof.evidence` : « notes.txt relu : 12 octets, contenu identique »), masqué puis coupé à
   * 200 caractères, comme la cible. Absent quand l'outil n'a pas de vérification.
   */
  evidence?: string;
}

/** Les noms sous lesquels l'assistant est connu : un document qui l'interpelle par son nom est un signal d'injection (V-04). */
const ASSISTANT_NAMES = ["Jarod", "Jarod-OS"] as const;
/** Au-delà, seul le début de la sortie est examiné : le détecteur reste borné sur une sortie énorme (la sortie elle-même n'est pas coupée). */
const INJECTION_SCAN_CHARS = 200_000;

/** V-04, mode observation : les catégories d'injection d'une sortie d'outil, ou rien. Un détecteur qui lève ne casse jamais l'appel. */
function injectionIn(out: string): InjectionCategory[] | undefined {
  try {
    const found = detectInjection(out.length > INJECTION_SCAN_CHARS ? out.slice(0, INJECTION_SCAN_CHARS) : out, { assistantNames: ASSISTANT_NAMES });
    return found.length ? [...new Set(found.map((f) => f.category))] : undefined;
  } catch {
    return undefined;
  }
}

/** `sensible` : outil `dangerous` ; `audité` : lecture sans accord qui doit laisser sa trace (`audited`) ; `ordinaire` : le reste. */
export type AuditTier = "sensible" | "audité" | "ordinaire";

const tierOf = (tool: Pick<ToolDef, "dangerous" | "audited">): AuditTier => (tool.dangerous ? "sensible" : tool.audited ? "audité" : "ordinaire");

/**
 * G2 — traces locales (OpenTelemetry, branché par plugin-integrations). L'agent ne dépend d'aucun paquet de télémétrie : il parle à cette
 * interface minimale, et n'y met que des identifiants opaques, des noms d'outils, des fournisseurs et des statuts — jamais un argument,
 * un prompt ni une réponse. Sans récepteur branché (ou réglage éteint), rien n'est mesuré.
 */
export type SpanStatus = "ok" | "error" | "denied" | "cancelled";
export interface SpanHandle {
  set(attributes: Record<string, string | number>): void;
  end(status: SpanStatus): void;
}
export interface SpanSink {
  start(name: string, attributes: Record<string, string | number>, parent?: SpanHandle): SpanHandle;
}

type GuardedExtra = {
  vault?: VaultService;
  audit?: (entry: AuditEntry) => void;
  gate?: ToolGate;
  tasks?: TaskLedger;
  outputs?: OutputStore;
  /** G2 : récepteur de traces et trace parente (le tour de conversation). */
  spans?: SpanSink;
  parentSpan?: SpanHandle;
};

export async function executeGuardedTool(
  tools: ToolRegistry,
  sessionId: string,
  call: ToolCall,
  signal: AbortSignal,
  hooks: { approve(sessionId: string, call: ToolCall, toolDescription: string): Promise<boolean> },
  s: Settings,
  extra: GuardedExtra = {},
): Promise<{ content: string; isError: boolean }> {
  // G2 : une trace par appel ; `mark` dit POURQUOI l'appel a échoué (refus, annulation), que le contenu rendu ne dit pas de façon fiable.
  const span = extra.spans?.start("tool.call", { "session.id": sessionId, "tool.name": call.name }, extra.parentSpan);
  const mark: { status: SpanStatus } = { status: "ok" };
  try {
    const out = await runGuardedTool(tools, sessionId, call, signal, hooks, s, extra, span, mark);
    span?.end(out.isError ? (mark.status === "ok" ? "error" : mark.status) : "ok");
    return out;
  } catch (e) {
    span?.end("error");
    throw e;
  }
}

async function runGuardedTool(
  tools: ToolRegistry,
  sessionId: string,
  call: ToolCall,
  signal: AbortSignal,
  hooks: { approve(sessionId: string, call: ToolCall, toolDescription: string): Promise<boolean> },
  s: Settings,
  extra: GuardedExtra,
  span: SpanHandle | undefined,
  mark: { status: SpanStatus },
): Promise<{ content: string; isError: boolean }> {
  const child = (name: string) => (span ? extra.spans?.start(name, { "tool.name": call.name }, span) : undefined);
  const started = Date.now();
  const tool = tools.get(call.name);
  // Cockpit, lot 2 : la CIBLE de l'appel, pour les règles par cible. Un outil qui ne la dit pas, ou qui lève, donne une cible
  // inconnue (null) : un deny ou ask ciblé s'applique alors tel quel (fail-closed). Déclarée ici pour que l'audit la porte dès qu'elle est connue.
  let target: string | null = null;
  // V-02 : chaque appel laisse une ligne — qui a demandé, quoi, sur quoi, qui a décidé, combien de temps, avec quelle preuve.
  const audit = (decision: AuditEntry["decision"], ok?: boolean, proof?: Proof["status"], injection?: InjectionCategory[], evidence?: string) =>
    extra.audit?.({
      sessionId,
      tool: call.name,
      // Masquer AVANT de tronquer : une coupe au milieu d'une clé en laisserait un morceau lisible (AV2-009).
      args: auditArgs(call.args, 500),
      decision,
      ...(ok === undefined ? {} : { ok }),
      ...(call.id ? { callId: call.id } : {}),
      ...(tool ? { tier: tierOf(tool) } : {}),
      ...(target !== null ? { target: truncate(redactCommandText(target), 200) } : {}),
      durationMs: Date.now() - started,
      ...(proof ? { proof } : {}),
      ...(injection ? { injection } : {}),
      ...(evidence ? { evidence: truncate(redactCommandText(evidence), 200) } : {}),
    });
  if (!tool || s.disabledTools.includes(call.name)) {
    audit("refusé (invalide)");
    return { content: `Outil inconnu ou désactivé : ${call.name}`, isError: true };
  }
  // L'interrupteur Internet (fichier du shell, relu à chaque appel) : avant la politique de permissions et avant toute demande d'accord.
  const offline = toolVerdict(activePolicy(), call.name, tool.source);
  if (!offline.ok) {
    mark.status = "denied";
    audit("refusé (règle)");
    return { content: offline.reason, isError: true };
  }
  if (s.agentMode === "plan" && (tool.dangerous || PERSISTENT_TOOLS.has(call.name))) {
    mark.status = "denied";
    audit("bloqué (mode Plan)");
    return { content: "Mode Plan : cet outil est désactivé (lecture seule).", isError: true };
  }
  try {
    const t = tool.targetOf?.(call.args ?? {});
    if (typeof t === "string" && t.trim()) target = t;
  } catch {
    target = null;
  }
  // Autonomie configurable : toutes les cibles d'un lot (`targetsOf`) et l'opération (`operationOf`), pour les règles à périmètre. Même
  // convention : un outil qui ne sait pas les dire, ou qui lève, donne « inconnu » (un allow à périmètre ne joue pas).
  let targets: string[] | null = target !== null ? [target] : null;
  if (tool.targetsOf) {
    try {
      const l = tool.targetsOf(call.args ?? {});
      targets = Array.isArray(l) && l.length > 0 && l.every((x) => typeof x === "string" && x.trim() !== "") ? l : null;
    } catch {
      targets = null;
    }
    if (target === null && targets) target = targets.length === 1 ? targets[0]! : `${targets[0]} (+${targets.length - 1})`;
  }
  let operation: string | null = null;
  try {
    const o = tool.operationOf?.(call.args ?? {});
    if (typeof o === "string" && o.trim()) operation = o;
  } catch {
    operation = null;
  }
  // Jarod-cordis — garde unifié (PLAN §2 plugin-permissions) : `deny` bloque, `ask` exige l'accord
  // même pour un outil non sensible et même en approbation automatique ; défaut `deny` (fail-closed).
  const scope = { targets, operation, session: sessionId };
  const res: Resolution = extra.gate?.resolve
    ? extra.gate.resolve(call.name, scope)
    : { decision: extra.gate?.decide(call.name, target) ?? "deny", autonomous: false, source: "défaut" };
  const verdict = res.decision;
  // V-09 : le profil d'accès (lu à chaque appel, comme les autres permissions). Valeur inconnue ou absente = Personnalisé, le comportement d'avant.
  const profile: AccessProfile = isAccessProfile(s.accessProfile) ? s.accessProfile : "custom";
  // Une opération que l'outil réserve à une permission EXPLICITE : sans règle de l'utilisateur qui la couvre (le joker « * » seul ne compte
  // pas), refusée — la capacité existe, la permission manque, et le message le dit.
  const facts = { exists: true, dangerous: Boolean(tool.dangerous), restricted: reservedReason(res, operation, tool.restrictedOperations), neverAlways: NEVER_ALWAYS_REASONS[call.name] ?? null };
  // Cockpit, lot 2 : une action à effet, une lecture auditée ou un appel soumis à accord devient une TÂCHE (étapes, preuve, annulation).
  const tasks = extra.tasks && (tool.dangerous || tool.audited || verdict === "ask" || profile === "ask") ? extra.tasks : undefined;
  const refusedTask = (summary: string, why: string) => {
    if (!tasks) return;
    const h = tasks.begin({ sessionId, tool: call.name, summary, ...(target !== null ? { target } : {}) });
    tasks.finish(h.id, "refused", { error: why });
  };
  if (verdict === "deny" || facts.restricted) {
    mark.status = "denied";
    audit("refusé (règle)");
    refusedTask(tool.description, "refusé par la politique de permissions");
    const why = explainResolution(call.name, scope, res, facts);
    return { content: `Refusé par la politique de permissions : ${call.name}. ${why.why}${why.howTo ? ` ${why.howTo}` : ""}`, isError: true };
  }
  const invalid = validateArgs(tool.parameters, call.args);
  if (invalid) {
    audit("refusé (invalide)");
    return { content: invalid, isError: true };
  }
  // Garde propre à l'outil, AVANT toute demande d'accord : ce que la politique interdit (un chemin protégé, un processus critique) n'est pas
  // soumis à l'utilisateur. Le texte rendu, s'il y en a un, remplace la description de l'outil dans la demande (« Arrêter chrome, pid 123 »).
  let approvalText = tool.description;
  if (tool.precheck) {
    try {
      const note = await tool.precheck(call.args, { sessionId, workspace: s.workspace, signal });
      if (typeof note === "string" && note.trim()) approvalText = note;
    } catch (e) {
      mark.status = "denied";
      audit("refusé (règle)");
      refusedTask(tool.description, (e as Error).message);
      return { content: `Refusé : ${(e as Error).message}`, isError: true };
    }
  }
  const task = tasks?.begin({ sessionId, tool: call.name, summary: approvalText, ...(target !== null ? { target } : {}) }, signal);
  // Le signal de la tâche suit celui du tour ET l'annulation de la tâche seule (écran Tâches).
  const runSignal = task?.signal ?? signal;
  const cancelled = () => {
    mark.status = "cancelled";
    audit("annulé");
    if (task) tasks!.finish(task.id, "cancelled");
    return { content: "Interrompu par l'utilisateur.", isError: true };
  };
  let decision: AuditEntry["decision"] | null = null;
  // « Toujours autoriser » dispense l'accord de l'outil, jamais celui qu'impose une règle « demander » du garde, ni pour un outil de NEVER_ALWAYS (§ 23.2) : une entrée
  // déjà enregistrée pour lui est IGNORÉE (la demande est posée), non supprimée.
  const alwaysAllowed = (s.alwaysAllowTools ?? []).includes(call.name) && !NEVER_ALWAYS.has(call.name);
  if (res.autonomous && autonomyHonoured(profile)) {
    // Autonomie configurable : une règle de l'utilisateur (allow + autonomous) couvre CET appel — outil, cibles, opération, conversation,
    // échéance, utilisations. L'accord n'est pas demandé ; tout le reste a joué (Internet, mode Plan, refus placés avant, garde de l'outil).
    // Une utilisation est retirée AVANT l'exécution : deux appels simultanés ne passent pas sur la même dernière.
    try {
      extra.gate?.consume?.(res.rule!);
    } catch {
      // Un compteur qu'on ne peut pas décrémenter refuse : l'autonomie bornée en nombre ne doit pas devenir illimitée sur une erreur.
      mark.status = "denied";
      audit("refusé (règle)");
      refusedTask(approvalText, "compteur d'utilisations illisible");
      return { content: "Refusé : le compteur d'utilisations de la permission n'a pas pu être mis à jour.", isError: true };
    }
    if (task) tasks!.step(task.id, "accordée", `sans accord, par la règle ${res.rule?.id ?? `n° ${(res.index ?? 0) + 1}`}`, "running");
    decision = "autorisé (règle)";
  } else if (
    needsApproval({ profile, tool: call.name, dangerous: Boolean(tool.dangerous), verdict: verdict === "ask" ? "ask" : "allow", autoApproveTools: s.autoApproveTools, alwaysAllowed })
  ) {
    if (task) tasks!.step(task.id, "accord demandé", undefined, "awaiting-approval");
    // Un service d'approbation en erreur (rejet OU levée synchrone) REFUSE : l'outil ne tourne jamais sur une erreur (SPECS-P5-UI-PARITE.md § 13, FC4).
    let answer: Promise<boolean>;
    try {
      answer = Promise.resolve(hooks.approve(sessionId, call, approvalText));
    } catch {
      answer = Promise.resolve(false);
    }
    // G2 : l'ATTENTE de l'accord est mesurée à part de l'exécution.
    const wait = child("tool.permission.wait");
    const ok = await awaitApproval(answer, runSignal);
    wait?.end(runSignal.aborted ? "cancelled" : ok ? "ok" : "denied");
    if (runSignal.aborted) return cancelled();
    if (!ok) {
      mark.status = "denied";
      audit("refusé");
      if (task) tasks!.finish(task.id, "refused", { error: "refusé par l'utilisateur" });
      return { content: "L'utilisateur a refusé cette action.", isError: true };
    }
    if (task) tasks!.step(task.id, "accordée", undefined, "running");
    decision = "accordé";
  } else if (tool.dangerous || tool.audited) {
    // `audited` : une lecture sans accord (outils système) qui laisse tout de même sa ligne dans le journal.
    decision = "automatique";
  }
  // Une autorisation (sans autonomie) bornée en nombre : l'utilisation est retirée à l'exécution accordée, comme pour une règle autonome
  // (retirée plus haut, avant l'accord qu'elle dispense). Même refus si le compteur ne peut pas être mis à jour.
  if (!res.autonomous && res.source === "règle" && res.decision === "allow" && res.rule?.uses !== undefined) {
    try {
      extra.gate?.consume?.(res.rule);
    } catch {
      mark.status = "denied";
      audit("refusé (règle)");
      if (task) tasks!.finish(task.id, "refused", { error: "compteur d'utilisations illisible" });
      return { content: "Refusé : le compteur d'utilisations de la permission n'a pas pu être mis à jour.", isError: true };
    }
  }
  try {
    if (task) tasks!.step(task.id, "exécution", undefined, "running");
    // Le contexte porte la porte d'approbation du cœur et le réglage du garde du shell : un outil
    // qui doit demander un accord nommé traverse la même porte au lieu d'en ouvrir une seconde.
    const ctx: ToolContext = {
      sessionId,
      workspace: s.workspace,
      signal: runSignal,
      approve: hooks.approve,
      ...(s.shellGuard ? { shellGuard: s.shellGuard } : {}),
      ...(extra.vault ? { vault: extra.vault } : {}),
    };
    const exec = child("tool.execute");
    let out: string;
    try {
      out = await tool.run(call.args, ctx);
    } catch (e) {
      exec?.end(runSignal.aborted ? "cancelled" : "error");
      throw e;
    }
    exec?.end(runSignal.aborted || (task && tasks!.get(task.id)?.status === "cancelled") ? "cancelled" : "ok");
    if (task && tasks!.get(task.id)?.status === "cancelled") return cancelled();
    // Cockpit, lot 2 : la preuve de l'effet, constatée APRÈS l'exécution. Un code de retour positif ne suffit pas.
    let proof: Proof | undefined;
    if (tool.verify) {
      if (task) tasks!.step(task.id, "vérification", undefined, "verifying");
      proof = await verifyEffect(tool.verify.bind(tool), call.args, out, ctx);
    } else if (tool.dangerous) {
      proof = { status: "unverifiable", evidence: "aucune vérification prévue pour cet outil" };
    }
    const failed = proof?.status === "failed";
    // V-04 : la sortie est examinée (observation seulement : elle passe inchangée au modèle) ; les catégories vont dans la ligne d'audit.
    audit(decision ?? "sans accord", !failed, proof?.status, injectionIn(out), tool.verify ? proof?.evidence : undefined);
    if (task) tasks!.finish(task.id, failed ? "failed" : "done", proof ? { proof } : {});
    const note = tool.verify && proof ? `\n\n[Vérification : ${PROOF_LABEL[proof.status]}] ${proof.evidence}` : "";
    // Cockpit, lot 3 : une sortie volumineuse reste hors du contexte (aperçu + référence), entière et cherchable ; la preuve reste visible.
    let kept: string;
    try {
      kept = extra.outputs ? extra.outputs.keep(sessionId, call.name, out).content : truncate(out, 50_000);
    } catch {
      kept = truncate(out, 50_000);
    }
    return { content: kept + note, isError: failed };
  } catch (e) {
    if (task && tasks!.get(task.id)?.status === "cancelled") return cancelled();
    audit(decision ?? "sans accord", false);
    if (task) tasks!.finish(task.id, "failed", { error: (e as Error).message });
    return { content: `Erreur : ${(e as Error).message}`, isError: true };
  }
}

const PROOF_LABEL: Record<Proof["status"], string> = { verified: "constatée", failed: "ÉCHEC", unverifiable: "impossible" };

/** La vérification d'un outil, bornée (15 s) ; une vérification qui lève ou dépasse le délai est dite impossible, jamais constatée. */
async function verifyEffect(
  verify: NonNullable<ToolDef["verify"]>,
  args: Record<string, unknown>,
  out: string,
  ctx: ToolContext,
): Promise<Proof> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<Proof>((resolve) => {
      timer = setTimeout(() => resolve({ status: "unverifiable", evidence: "vérification sans réponse en 15 s" }), 15_000);
    });
    const p = await Promise.race([verify(args, out, ctx), timeout]);
    return p && (p.status === "verified" || p.status === "failed" || p.status === "unverifiable") ? p : { status: "unverifiable", evidence: "vérification sans résultat" };
  } catch (e) {
    return { status: "unverifiable", evidence: `vérification impossible : ${(e as Error).message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
