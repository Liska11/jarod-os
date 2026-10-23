/**
 * Le runtime des tours d'agent : ce que `JarodCore` (packages/core/src/core.ts, rév. 2e180305)
 * faisait pour une conversation — entrée du compositeur, tour d'agent suivi, arrêt, usage, tâches
 * planifiées, livraison. Les corps de méthode sont repris tels quels (fichier:lignes en commentaire) ;
 * seul le câblage change : les services viennent des plugins cordis, et ce que d'autres plugins
 * font autour d'un tour (objectifs, apprentissage — Phase 2) passe par des événements kernel.
 *
 * Les champs portent les mêmes noms que ceux de `JarodCore` : `new Agent(this)` et les tests portés
 * s'en servent tels quels.
 */
import type { Attachment, ScheduleDelivery, SessionContext } from "@jarod/contracts";
import type { CheckpointService, Db, EventStoreService, NotificationService, SettingsService } from "@jarod/plugin-storage";
import type { AttachmentService, VaultService } from "@jarod/plugin-rag";
import { TaskLedger, type TaskRecord } from "./tasks.js";
import { OutputStore } from "./outputs.js";
import { ArtifactStore } from "./artifacts.js";
import type { ProviderRouter, RoutingService } from "@jarod/plugin-llm";
import {
  type AnnotationService,
  type CuratorService,
  expandReferences,
  type MemoryService,
  type UserProfileService,
} from "@jarod/plugin-memory";
import type { ToolGate } from "@jarod/plugin-permissions";
import { DELIVERY_GATEWAYS, type Schedule } from "@jarod/plugin-scheduler";
import type { SkillRegistry, SkillsHubService } from "@jarod/plugin-skills";
import type { ToolRegistry, ToolSearchService } from "@jarod/plugin-tools";
import type { PersonaService } from "@jarod/plugin-persona";
import type { ImageDescriber } from "@jarod/plugin-vision";
import { Agent, type AgentHooks, type AuditEntry, type PluginHost } from "./agent.js";
import { type SessionUsage, usageOf } from "./budget.js";
import { type CommandResult, CommandRegistry } from "./commands.js";
import { executeGuardedCommand } from "./command-guard.js";
import type { LearningService } from "./learning.js";
import type { MessageService, SessionService } from "./sessions.js";
import { RlmChildren } from "./rlm.js";
import { SessionStateService } from "./session-state.js";
import { SubagentsService } from "./subagents.js";

export type SubmitResult = { kind: "started" } | { kind: "busy" } | { kind: "command"; result: CommandResult };

/** Ce qu'une passerelle de messagerie offre au runtime (plugin-gateways, Phase 3). */
export interface GatewaySender {
  send(chatId: string, text: string): Promise<void>;
  sendFile(chatId: string, name: string, data: Buffer, caption?: string): Promise<void>;
}

/** Un tour terminé, tel que `core.ts:1605-1617` le passait aux objectifs et à l'apprentissage. */
export interface TurnOutcome {
  aborted: boolean;
  answered: boolean;
  error?: string;
}

export interface RuntimeDeps {
  db: Db;
  settings: SettingsService;
  events: EventStoreService;
  checkpoints: CheckpointService;
  notifications: NotificationService;
  sessions: SessionService;
  messages: MessageService;
  memory: MemoryService;
  userProfile: UserProfileService;
  providers: ProviderRouter;
  routing: RoutingService;
  tools: ToolRegistry;
  toolSearch: ToolSearchService;
  skills: SkillRegistry;
  attachments: AttachmentService;
  vault: VaultService;
  vision?: ImageDescriber;
  /** SOUL.md du profil (plugin-persona, `core.ts:381`) ; absent : réglage `persona` seul. */
  persona?: PersonaService;
  plugins: PluginHost;
  gate?: ToolGate;
  appVersion: string;
  /** Événements kernel (`ctx.emit`) : `agent:submit`, `agent:turn-done`. */
  emit?: (name: string, ...args: unknown[]) => void;
}

/** Sans plugin chargé : `PluginHost.beforeSend` rend le texte tel quel (services/plugins.ts:236-257). */
export const noPlugins: PluginHost = { beforeSend: (text) => text, afterResponse: () => {}, list: () => [] };

/** Combien de lignes d'audit, depuis la fin du journal, `auditOf` parcourt pour retrouver celles d'une conversation. */
const AUDIT_SCAN = 10_000;

export class AgentRuntime {
  readonly db: Db;
  readonly settings: SettingsService;
  readonly events: EventStoreService;
  readonly checkpoints: CheckpointService;
  readonly notifications: NotificationService;
  readonly sessions: SessionService;
  readonly messages: MessageService;
  readonly memory: MemoryService;
  readonly userProfile: UserProfileService;
  readonly providers: ProviderRouter;
  readonly routing: RoutingService;
  readonly tools: ToolRegistry;
  readonly toolSearch: ToolSearchService;
  readonly skills: SkillRegistry;
  readonly attachments: AttachmentService;
  readonly vault: VaultService;
  readonly vision: ImageDescriber | undefined;
  readonly persona: PersonaService | undefined;
  /** Remplacé par plugin-workflows (`attachPlugins`) ; l'agent le relit à chaque tour. */
  plugins: PluginHost;
  readonly gate: ToolGate | undefined;
  /** Cockpit, lot 2 : les actions passées par la porte unique (étapes, preuve, annulation) ; les finies vont au flux `tasks`. */
  readonly tasks: TaskLedger;
  /** Cockpit, lot 3 : sorties d'outils volumineuses, hors du contexte, cherchables (table `tool_outputs`). */
  readonly outputs: OutputStore;
  /** Cockpit, lot 5 : les artefacts produits (diagrammes, vidéos, analyses, rapports), référencés avec leur empreinte. */
  readonly artifacts: ArtifactStore;
  readonly commands = new CommandRegistry();
  readonly subagents = new SubagentsService();
  /** Q18 : état de travail par conversation (table `session_state`, v18). */
  readonly state: SessionStateService;
  /** Q18 : sous-agents non bloquants (lecture seule), sous la borne de `subagents`. */
  readonly rlm: RlmChildren;
  readonly appVersion: string;
  readonly agent: Agent;
  /** Passerelles connectées (plugin-gateways les enregistre) — `core.ts:270-274`. */
  readonly gateways = new Map<ScheduleDelivery["gateway"], GatewaySender>();
  /** Branchés par plugin-agent (core.ts:379,565-618) : annotations, entretien des skills, hub, apprentissage. */
  annotations!: AnnotationService;
  curator!: CuratorService;
  hub!: SkillsHubService;
  learning!: LearningService;
  /**
   * Who may approve a tool call for runs nobody is watching directly. Null: refused. plugin-gateways
   * sets it to offer the request to the paired phones when the `phoneApprovals` setting is on.
   */
  backgroundApprover: AgentHooks["approve"] | null = null;
  /** Hooks for runs nobody is watching directly (schedules, Telegram). The desktop app replaces them. */
  backgroundHooks: AgentHooks = {
    emit: () => {},
    approve: (sessionId, call, description) =>
      this.backgroundApprover ? this.backgroundApprover(sessionId, call, description) : Promise.resolve(false),
  };
  private running = new Map<string, AbortController>();
  private readonly emitKernel: (name: string, ...args: unknown[]) => void;

  /** The audit log: every side-effecting tool call, who decided, and how it went. (core.ts:281-283) */
  readonly audit = (entry: AuditEntry): void => {
    this.events.append("audit", entry.ok === undefined ? "decision" : "action", entry);
  };

  constructor(d: RuntimeDeps) {
    this.db = d.db;
    this.state = new SessionStateService(d.db);
    this.settings = d.settings;
    this.events = d.events;
    this.outputs = new OutputStore(d.db);
    this.artifacts = new ArtifactStore(d.db);
    this.tasks = new TaskLedger({
      store: {
        save: (t) => void this.events.append("tasks", t.status, t),
        load: () => this.events.list({ stream: "tasks", limit: 10_000 }).slice(-200).map((e) => e.data as TaskRecord),
      },
    });
    this.checkpoints = d.checkpoints;
    this.notifications = d.notifications;
    this.sessions = d.sessions;
    this.messages = d.messages;
    this.memory = d.memory;
    this.userProfile = d.userProfile;
    this.providers = d.providers;
    this.routing = d.routing;
    this.tools = d.tools;
    this.toolSearch = d.toolSearch;
    this.skills = d.skills;
    this.attachments = d.attachments;
    this.vault = d.vault;
    this.vision = d.vision;
    this.persona = d.persona;
    this.plugins = d.plugins;
    this.gate = d.gate;
    this.appVersion = d.appVersion;
    this.emitKernel = d.emit ?? (() => {});
    // core.ts:370-376
    // Deleting messages or conversations also deletes the files nothing refers to any more.
    this.sessions.onAttachmentsRemoved = this.messages.onAttachmentsRemoved = (ids) => {
      this.attachments.deleteUnreferenced(ids);
    };
    // A deleted conversation must not live on in the journal: its prompts, answers and tool outputs
    // are exactly what the user asked to delete.
    this.sessions.onDeleted = (id) => {
      this.events.forget(`session:${id}`);
      this.outputs.forget(id);
      // Q18 : les sous-agents de cette conversation s'arrêtent avec elle.
      for (const c of this.rlm.of(id)) if (c.status === "running") this.subagents.cancel(c.id);
      // G4 : le plafond relevé pour cette conversation part avec elle.
      const b = this.settings.get("sessionBudget");
      if (b.perSession?.[id]) {
        const { [id]: _gone, ...rest } = b.perSession;
        this.settings.set("sessionBudget", { ...b, perSession: rest });
      }
    };
    this.agent = new Agent(this);
    this.rlm = new RlmChildren(this.subagents, (task, signal, sessionId) => this.agent.runSubAgent(task, signal, sessionId));
  }

  /** Branche l'hôte des plugins (plugin-workflows) ; rend le retour à l'hôte précédent. */
  attachPlugins(host: PluginHost): () => void {
    const previous = this.plugins;
    this.plugins = host;
    return () => {
      if (this.plugins === host) this.plugins = previous;
    };
  }

  /** The most recent audit lines, newest first. (core.ts:310-316) */
  auditLog(limit = 50): (AuditEntry & { at: number })[] {
    // Lu depuis la FIN du journal : les `limit` lignes les plus récentes (avant, les 10 000 premières, qui ne sont plus les dernières dès que le journal grossit).
    return this.events
      .list({ stream: "audit", limit, newest: true })
      .reverse()
      .map((e) => ({ ...(e.data as AuditEntry), at: e.at }));
  }

  /**
   * V-02 — la timeline d'une conversation : ses lignes d'audit, dans l'ordre où elles ont été écrites. Cherchées dans les `AUDIT_SCAN`
   * dernières lignes du journal (toutes conversations confondues) : une conversation très ancienne peut n'y avoir plus rien.
   */
  auditOf(sessionId: string, limit = 500): (AuditEntry & { at: number })[] {
    return this.events
      .list({ stream: "audit", limit: AUDIT_SCAN, newest: true })
      .filter((e) => (e.data as AuditEntry | null)?.sessionId === sessionId)
      .slice(-limit)
      .map((e) => ({ ...(e.data as AuditEntry), at: e.at }));
  }

  // core.ts:1141-1147
  editAndResend(sessionId: string, messageId: string, text: string, hooks: AgentHooks): SubmitResult {
    if (this.isRunning(sessionId)) return { kind: "busy" };
    const old = this.messages.deleteFrom(sessionId, messageId);
    if (old?.role !== "user") throw new Error("Seuls vos messages peuvent être modifiés.");
    hooks.emit({ type: "history", sessionId });
    return this.start(sessionId, text, hooks, old.attachments ?? []);
  }

  /** New conversation containing this one up to (and including) the given message. (core.ts:1150-1156) */
  forkSession(sessionId: string, messageId: string): string {
    const source = this.sessions.get(sessionId);
    if (!source) throw new Error("Conversation introuvable");
    const fork = this.sessions.create(`${source.title} (bifurcation)`.slice(0, 80));
    this.messages.copyTo(sessionId, fork.id, messageId);
    return fork.id;
  }

  // core.ts:1464-1486
  async runSchedule(sch: Schedule): Promise<{ sessionId: string; ok: boolean; summary: string }> {
    const sessionId =
      sch.sessionId && this.sessions.get(sch.sessionId)
        ? sch.sessionId
        : this.sessions.create(`\u{23F0} ${sch.name}`).id;
    // H4/M5 : `previousMode` peut être ABSENT — une conversation jamais servie n'a pas encore de contexte
    // (celui-ci est épinglé paresseusement par `settingsFor`). Le mode à rétablir est alors celui des
    // réglages, exactement ce que ce premier tour aurait épinglé ; sans ça, la conversation gardait pour
    // toujours le mode IMPOSÉ par la tâche planifiée (« build » écrit par une automation).
    const previousMode = this.sessions.get(sessionId)?.context?.agentMode ?? this.settings.getAll().agentMode;
    if (sch.mode) this.updateSessionContext(sessionId, { agentMode: sch.mode });
    let r: { text: string; error?: string };
    try {
      r = await this.runAndWait(sessionId, sch.prompt, this.backgroundHooks);
    } finally {
      if (sch.mode) this.updateSessionContext(sessionId, { agentMode: previousMode });
    }
    let ok = !r.error;
    let summary = r.error ?? r.text;
    if (sch.deliver) {
      let sent = true;
      try {
        await this.deliver(
          sch.deliver,
          `\u{23F0} ${sch.name}\n\n${r.error ? `Erreur : ${r.error}` : r.text || "(pas de réponse)"}`,
        );
      } catch (e) {
        ok = false;
        sent = false;
        summary = `livraison ${sch.deliver.gateway} impossible : ${(e as Error).message}${r.error ? ` · ${r.error}` : ""}`;
      }
      // Q19-3 (b) : un envoi automatique laisse sa ligne d'audit — la cible (jamais le texte envoyé), le résultat. La décision
      // a été prise à la création (« automatique » : personne ne décide à l'envoi) ; l'audit dit OÙ ça part, à chaque fois.
      this.audit({
        sessionId,
        tool: "schedule/deliver",
        args: JSON.stringify({ schedule: sch.id, name: sch.name, gateway: sch.deliver.gateway, chatId: sch.deliver.chatId }).slice(0, 500),
        decision: "automatique",
        ok: sent,
      });
    }
    this.notifications.add(ok ? "success" : "error", `Tâche planifiée « ${sch.name} »`, summary.slice(0, 400));
    return { sessionId, ok, summary };
  }

  /**
   * core.ts:1497-1517 — même contrat : une passerelle absente est une erreur dite, jamais un envoi
   * silencieusement perdu. Les passerelles s'enregistrent dans `gateways` (Phase 3).
   */
  async deliver(target: ScheduleDelivery, text: string): Promise<void> {
    const gateway = this.gateways.get(target.gateway);
    if (!gateway) throw new Error(`la passerelle ${target.gateway} n'est pas connectée`);
    await gateway.send(target.chatId, text);
  }

  /** Sends a file to a chat of one of the messaging gateways, as a document or attachment. (core.ts:1520-1540) */
  async deliverFile(target: ScheduleDelivery, name: string, data: Buffer, caption?: string): Promise<void> {
    const gateway = this.gateways.get(target.gateway);
    if (!gateway) throw new Error(`la passerelle ${target.gateway} n'est pas connectée`);
    await gateway.sendFile(target.chatId, name, data, caption);
  }

  /** The gateway chat a conversation belongs to, when it came from Telegram, Discord or Slack. (core.ts:1543-1551) */
  gatewayChatOf(sessionId: string): ScheduleDelivery | null {
    const row = this.db.get<{ gateway: string; chat_id: string }>(
      "SELECT gateway, chat_id FROM gateway_chats WHERE session_id = ?",
      sessionId,
    );
    return row && DELIVERY_GATEWAYS.includes(row.gateway as ScheduleDelivery["gateway"])
      ? { gateway: row.gateway as ScheduleDelivery["gateway"], chatId: row.chat_id }
      : null;
  }

  /** Au moins une conversation génère (`core.ts:570,643` : `this.running.size > 0`). */
  anyRunning(): boolean {
    return this.running.size > 0;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /**
   * Une commande `/` reçue d'un canal DISTANT (passerelle) : même chaîne que les outils — règle,
   * accord si la commande a un effet (refusé d'office en arrière-plan), audit. Le composer, lui,
   * appelle `commands.execute` : l'utilisateur y est le principal. (Q19-2)
   */
  executeRemoteCommand(input: string, sessionId: string | null, hooks: AgentHooks): Promise<CommandResult | null> {
    return executeGuardedCommand(this.commands, input, { sessionId }, hooks, {
      audit: this.audit,
      ...(this.gate ? { gate: this.gate } : {}),
    });
  }

  /** Entry point for the composer: runs a slash command or starts an agent turn. (core.ts:1558-1583) */
  async submit(
    sessionId: string,
    text: string,
    hooks: AgentHooks,
    attachments: Attachment[] = [],
  ): Promise<SubmitResult> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return { kind: "command", result: {} };
    if (trimmed.startsWith("/") && attachments.length === 0) {
      const result = (await this.commands.execute(trimmed, { sessionId })) ?? {};
      if (result.action === "retry") {
        return this.start(sessionId, null, hooks);
      }
      if (result.action === "send" && result.payload) {
        return this.start(sessionId, result.payload, hooks);
      }
      return { kind: "command", result };
    }
    // `this.goals.resumeIfAwaitingUser(sessionId)` : les objectifs (Phase 2) écoutent `agent:submit`.
    this.emitKernel("agent:submit", sessionId);
    // `@fichier`, `@dossier/`, `@diff` : joints comme des pièces jointes, le texte reste tel quel.
    const refs = await expandReferences(trimmed, this.agent.settingsFor(sessionId).workspace, (name, mime, data) =>
      this.attachments.save(name, mime, data),
    );
    const prompt = refs.notes.length ? `${trimmed}\n\n${refs.notes.join("\n")}` : trimmed;
    return this.start(sessionId, prompt, hooks, [...attachments, ...refs.attachments]);
  }

  // core.ts:1585-1623
  start(sessionId: string, text: string | null, hooks: AgentHooks, attachments: Attachment[] = []): SubmitResult {
    if (this.running.has(sessionId)) return { kind: "busy" };
    if (text) this.events.append(`session:${sessionId}`, "user-message", { text, attachments: attachments.length });
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const release = () => {
      // Only this turn's own entry: the goal loop may already have started the next turn.
      if (this.running.get(sessionId) === controller) this.running.delete(sessionId);
    };
    let turnError: string | undefined;
    let answered = false;
    /** H4 : le tour a-t-il déjà annoncé sa fin ? Sert à ne pas émettre `done` deux fois depuis le `catch`. */
    let sawDone = false;
    const tracked: AgentHooks = {
      ...hooks,
      emit: (e) => {
        // Shadow log of the turn: every agent event, whichever entry point started it (composer,
        // schedule, bot, remote). Never awaited and never throwing, see EventStoreService.append.
        this.events.append(`session:${sessionId}`, e.type, e);
        if (e.type === "error") turnError = e.error;
        if (e.type === "message" && e.message.role === "assistant") answered = true;
        if (e.type === "done") sawDone = true;
        // Free the session before announcing "done" so listeners can start the next turn.
        if (e.type === "done") release();
        hooks.emit(e);
        if (e.type === "done") {
          const turn: TurnOutcome = {
            aborted: controller.signal.aborted,
            answered,
            ...(turnError ? { error: turnError } : {}),
          };
          // `goals.afterTurn` et `learning.afterTurn` (Phase 2) écoutent `agent:turn-done`.
          this.emitKernel("agent:turn-done", sessionId, hooks, turn);
        }
      },
    };
    void this.agent
      .run(sessionId, text, controller.signal, tracked, attachments)
      // H4 : sans `catch`, une exception du tour devenait un REJET NON GÉRÉ — le processus s'arrête sous
      // Node (`jarod serve`), et l'écran n'apprend jamais pourquoi. On journalise, on prévient l'appelant,
      // et on ferme le tour s'il ne l'a pas déjà été (sinon `runAndWait` attendrait un `done` jamais émis).
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.events.append(`session:${sessionId}`, "error", { message });
        if (sawDone) return;
        hooks.emit({ type: "error", sessionId, error: message });
        hooks.emit({ type: "done", sessionId });
      })
      .finally(release);
    return { kind: "started" };
  }

  // core.ts:1379-1408 (runAndWait)
  runAndWait(
    sessionId: string,
    text: string,
    hooks: AgentHooks,
    attachments: Attachment[] = [],
  ): Promise<{ text: string; error?: string }> {
    return new Promise((resolve) => {
      let error: string | undefined;
      const r = this.start(
        sessionId,
        text,
        {
          approve: hooks.approve,
          emit: (e) => {
            hooks.emit(e);
            if (e.type === "error") error = e.error;
            if (e.type === "done") {
              const last = [...this.messages.list(sessionId)].reverse().find((m) => m.role === "assistant");
              resolve({ text: last?.content ?? "", ...(error ? { error } : {}) });
            }
          },
        },
        attachments,
      );
      if (r.kind === "busy") resolve({ text: "", error: "Une réponse est déjà en cours dans cette conversation." });
    });
  }

  stop(sessionId: string): void {
    this.running.get(sessionId)?.abort();
  }

  /** Arrête tous les tours en cours (core.ts:1770, `dispose`). */
  stopAll(): void {
    for (const c of this.running.values()) c.abort();
    // Q18 : les sous-agents lancés en arrière-plan ne survivent pas à l'arrêt.
    this.subagents.cancelAll();
    // R3.5 : une revue d'apprentissage en vol tient un appel LLM — elle s'arrête avec le reste.
    this.learning?.cancelAll();
  }

  // core.ts:1629-1654 — corps déplacé dans `budget.ts` (`usageOf`), partagé avec le plafond G4.
  sessionUsage(sessionId: string): SessionUsage {
    return usageOf(this.messages.list(sessionId));
  }

  /** Changes the workspace, model or mode of one conversation (the others keep theirs). (core.ts:1657-1670) */
  updateSessionContext(sessionId: string | null, patch: Partial<SessionContext>): void {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return;
    const s = this.settings.getAll();
    const base: SessionContext = session.context ?? {
      workspace: s.workspace,
      provider: s.activeProvider,
      model: s.activeModel,
      agentMode: s.agentMode,
    };
    this.sessions.setContext(session.id, { ...base, ...patch });
  }

  /**
   * Loads a conversation's pinned workspace, model and mode into the global settings, so the
   * interface shows (and edits) what that conversation uses. Returns true when something changed.
   * (core.ts:1674-1692)
   */
  activateSession(sessionId: string): boolean {
    const ctx = this.sessions.get(sessionId)?.context;
    if (!ctx) return false;
    const s = this.settings.getAll();
    if (
      s.workspace === ctx.workspace &&
      s.activeProvider === ctx.provider &&
      s.activeModel === ctx.model &&
      s.agentMode === ctx.agentMode
    )
      return false;
    this.settings.patch({
      workspace: ctx.workspace,
      activeProvider: ctx.provider,
      activeModel: ctx.model || s.activeModel,
      agentMode: ctx.agentMode,
    });
    return true;
  }

  /**
   * SPECS-P5-WEBHOOKS § 2.2 — exécute une tâche `webhook` due.
   * Crée une conversation par déclencheur (titre « 🔗 Déclencheur « <id> » »), réutilisée ensuite.
   * Mode Plan FORCÉ (même avec autoApproveTools) : aucun outil sensible n'est exécutable.
   * Le champ `prompt` (ou `text`) du corps signé est la requête ; le reste du corps entre
   * comme donnée dans un bloc délimité tronqué à 20 000 caractères.
   */
  async runWebhook(hookId: string, payload: unknown): Promise<{ sessionId: string; ok: boolean; summary: string }> {
    const title = `🔗 Déclencheur « ${hookId} »`;
    // Réutilise la conversation du déclencheur si elle existe déjà
    const existing = this.sessions.list().find((s) => s.title === title);
    const sessionId = existing ? existing.id : this.sessions.create(title).id;

    // Construit la requête : prompt/text du corps = requête, reste = donnée
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    let promptText = "";
    let dataBlock = "";
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const { prompt, text, ...rest } = parsed as Record<string, unknown>;
        promptText = typeof prompt === "string" ? prompt : typeof text === "string" ? text : "";
        if (Object.keys(rest).length > 0) {
          dataBlock = JSON.stringify(rest, null, 2).slice(0, 20_000);
        }
      } else {
        promptText = raw;
      }
    } catch {
      promptText = raw;
    }

    const prompt = dataBlock
      ? `${promptText}\n\nDonnées de la requête :\n\`\`\`json\n${dataBlock}\n\`\`\``
      : promptText || "(charge utile sans champ prompt/text — traitée comme donnée)";

    // Mode Plan FORCÉ : met à jour le contexte de la session
    this.updateSessionContext(sessionId, { agentMode: "plan" });

    const r = await this.runAndWait(sessionId, prompt, this.backgroundHooks);
    const ok = !r.error;
    const summary = r.error ?? r.text;
    this.notifications.add(ok ? "success" : "error", `Déclencheur « ${hookId} »`, summary.slice(0, 400));
    return { sessionId, ok, summary };
  }

  // core.ts:1694-1712
  exportSessionMarkdown(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Conversation introuvable");
    const lines = [`# ${session.title}`, "", `_Exporté depuis Jarod-One le ${new Date().toLocaleString("fr-FR")}_`, ""];
    for (const m of this.messages.list(sessionId)) {
      if (m.role === "user") lines.push("## 🧑 Vous", "", m.content, "");
      else if (m.role === "assistant") {
        lines.push(`## 🤖 Jarod${m.model ? ` (${m.model})` : ""}`, "");
        if (m.content) lines.push(m.content, "");
        for (const c of m.toolCalls ?? []) lines.push(`> 🔧 \`${c.name}\` ${JSON.stringify(c.args)}`, "");
      } else {
        lines.push(
          `<details><summary>Résultat de ${m.toolName}</summary>\n\n\`\`\`\n${m.content.slice(0, 4000)}\n\`\`\`\n</details>`,
          "",
        );
      }
    }
    return lines.join("\n");
  }

  /** Snapshot of the database, protected by a password (required when the database is encrypted). */
  backup(destPath: string, password?: string): void {
    this.db.backupTo(destPath, password);
  }
}
