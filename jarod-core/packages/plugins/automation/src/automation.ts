/**
 * @jarod/plugin-automation — `ctx.automation` : règles « quand X alors Y » (schedule + manual),
 * exécution séquentielle via jobs durable, idempotence par tick.
 * Portage de la V2 (services/automation.ts, bundled-plugins.ts) avec gardes Cordis.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Db, SqlValue } from "@jarod/plugin-storage";
import type { JobsService } from "@jarod/plugin-scheduler";
import { nextCronRun } from "@jarod/plugin-scheduler";
import { normalizeAutomationTickMs } from "./normalize.js";

export { normalizeAutomationTickMs };

export interface AutomationTrigger {
  kind: "schedule" | "manual" | "webhook";
  cron?: string;           // schedule only
  hookId?: string;         // webhook only
}

export interface AutomationAction {
  type: "agent" | "notify" | "webhook";
  // agent action
  prompt?: string;
  sessionId?: string;
  mode?: "plan" | "build";
  // notify action
  title?: string;
  body?: string;
  // webhook action
  url?: string;
  payload?: unknown;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  createdAt: number;
  updatedAt: number;
}

export interface AutomationConfig {
  tickMs: number;
}

const DEFAULT_TICK_MS = 30_000;
const MIN_TICK_MS = 1_000;
const MAX_TICK_MS = 3_600_000;

interface Row {
  id: string;
  name: string;
  enabled: number;
  trigger: string;
  actions: string;
  created_at: number;
  updated_at: number;
}

export class AutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly d: {
      db: Db;
      jobs: JobsService;
      /** Pour les tests : fonction now personnalisée. */
      now?: () => number;
      /** Exécute une action agent (délègue à l'agent via schedule/run). */
      runAgent: (prompt: string, sessionId: string | undefined, mode: "plan" | "build") => Promise<{ sessionId: string; ok: boolean; summary: string }>;
      /** Ajoute une notification. */
      notify: (kind: "success" | "error", title: string, body: string) => void;
      /** Log pour les annonces. */
      log?: (line: string) => void;
    },
  ) {}

  private at(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Démarre le tick périodique. */
  start(tickMs = DEFAULT_TICK_MS): void {
    if (this.timer) return;
    const normalized = normalizeAutomationTickMs(tickMs);
    this.d.log?.(`Automation : tickMs=${normalized}`);
    this.timer = setInterval(() => void this.tick().catch(() => {}), normalized);
    this.timer.unref?.();
  }

  /** Arrête le tick. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Une passe : exécute les règles enabled dont le cron est dû — LE DERNIER créneau dû, et lui seul. */
  async tick(): Promise<number> {
    const rules = this.list({ enabled: true });
    let executed = 0;
    const now = this.at();

    for (const rule of rules) {
      if (rule.trigger.kind === "schedule" && rule.trigger.cron) {
        try {
          const lastRun = this.getLastRunTime(rule.id, rule.createdAt);
          const { slot, skipped } = lastDueSlot(rule.trigger.cron, lastRun, now);
          if (slot === null) continue; // rien de dû
          // H5 : on ne rattrape PAS les créneaux manqués un par un — on les journalise et on exécute le
          // dernier. `nextCronRun` avance d'un créneau à la fois : boucler dessus (ou laisser
          // `executeRuleAt` créer un job par créneau) rejouait chaque créneau manqué, un par tick — une
          // règle horaire après une semaine d'arrêt enchaînait 168 tours d'agent.
          if (skipped > 0)
            this.d.log?.(
              `Automation : ${rule.id} — ${skipped} créneau(x) manqué(s) sauté(s), exécution du dernier (${new Date(slot).toISOString()})`,
            );
          const r = await this.executeRuleAt(rule, slot);
          if (r.created > 0) executed++;
        } catch (e) {
          this.d.log?.(`Automation : cron invalide pour règle ${rule.id} : ${(e as Error).message}`);
        }
      }
      // manual : exécuté seulement via run()
    }
    return executed;
  }

  /**
   * H6 — l'horodatage du dernier créneau TRAITÉ (réussi OU définitivement échoué).
   *
   * Ne compter que `done` bloquait la règle pour toujours après un échec : `nextRun` restait le créneau
   * échoué, dont la clé d'idempotence existait déjà, donc plus rien ne tournait jamais. Le lien est
   * désormais la colonne `ref` (indexée), plus un `LIKE` sur le JSON du payload.
   */
  private getLastRunTime(ruleId: string, fallback: number): number {
    const row = this.d.db.get<{ due_at: number | null }>(
      "SELECT MAX(due_at) AS due_at FROM jobs WHERE kind = 'automation' AND ref = ? AND status IN ('done','failed')",
      ruleId,
    );
    return row?.due_at ?? fallback;
  }

  /**
   * Exécute une règle à une heure planifiée précise (pour l'idempotence persistante).
   *
   * Rend ce qui s'est réellement passé : combien d'actions ont été ENFILÉES (`created`) et les échecs —
   * `run()` s'en sert pour ne plus annoncer « ok » sur un échec (H7), et `tick()` pour ne compter que ce
   * qu'il a vraiment lancé (H6).
   */
  async executeRuleAt(rule: AutomationRule, scheduledAt: number): Promise<{ created: number; failed: string[] }> {
    let created = 0;
    const failed: string[] = [];
    for (let i = 0; i < rule.actions.length; i++) {
      const action = rule.actions[i]!;
      // Idempotence persistante : clé = ruleId:actionIndex:scheduledAt
      const idempotencyKey = createHash("sha256")
        .update(`${rule.id}:${i}:${scheduledAt}`)
        .digest("hex");

      const { job, created: isNew } = this.d.jobs.enqueue({
        kind: "automation",
        ref: rule.id,
        payload: { ruleId: rule.id, actionIndex: i, action },
        idempotencyKey,
        dueAt: scheduledAt,
        // H6 : UNE tentative. `jobs.fail` remettait sinon l'exécution en attente… que PERSONNE ne reprend
        // (aucun exécutant de `kind = 'automation'`) : la règle semblait vivante et ne tournait plus jamais.
        // Le rejeu d'une automation, c'est le créneau suivant — pas la file.
        maxAttempts: 1,
      });

      if (!isNew) continue; // Déjà enfilé pour cette exécution planifiée

      // On PREND l'exécution avant de la lancer : c'est ce qui compte la tentative (donc ce qui rend un
      // échec définitif avec `maxAttempts: 1`) et ce qui horodate la prise — une exécution d'automation
      // bloquée est ainsi visible de `JobsService.requalifyStalled` comme n'importe quelle autre (M7).
      const claimed = this.d.jobs.claim(job.id);
      if (!claimed) continue; // une autre passe l'a prise

      created++;
      try {
        if (action.type === "agent") {
          // Mode Plan par défaut (SPECS-P5-AUTOMATION § 2.3, Q2) ; « build » seulement s'il est écrit dans l'action.
          const r = await this.d.runAgent(action.prompt ?? "", action.sessionId, action.mode ?? "plan");
          if (!r.ok) throw new Error(r.summary || "L'action agent a échoué");
        } else if (action.type === "notify") {
          this.d.notify("success", action.title ?? "Automation", action.body ?? "");
        } else if (action.type === "webhook") {
          // Pas d'envoi sortant dans ce chantier (décision en attente) : un échec FRANC, jamais un « ok » trompeur.
          throw new Error("action webhook non implémentée");
        }
        this.d.jobs.complete(claimed.id, "ok");
      } catch (e) {
        const message = (e as Error).message;
        this.d.log?.(`Automation : ${rule.id}:${i} échec : ${message}`);
        this.d.jobs.fail(claimed.id, message);
        failed.push(message);
      }
    }
    return { created, failed };
  }

  /** Exécute une règle (appelée par run manuel). */
  async executeRule(rule: AutomationRule): Promise<{ created: number; failed: string[] }> {
    // Pour run manuel, on utilise l'heure actuelle comme scheduledAt
    return this.executeRuleAt(rule, this.at());
  }

  /** Déclenche une règle manuellement (maintenant, hors tick). */
  async run(ruleId: string): Promise<{ ok: boolean; summary: string }> {
    const rule = this.get(ruleId);
    if (!rule) return { ok: false, summary: "Règle introuvable" };
    if (!rule.enabled) return { ok: false, summary: "Règle désactivée" };

    const { created, failed } = await this.executeRule(rule);
    // H7 : répondre « ok » alors que l'action a échoué faisait croire à l'outil agent `automation_run` et
    // au canal `automation-run` que tout s'était bien passé (l'erreur n'était que journalisée).
    if (failed.length)
      return { ok: false, summary: `Règle « ${rule.name} » : ${failed.length} action(s) en échec — ${failed[0]}` };
    if (created === 0) return { ok: false, summary: `Règle « ${rule.name} » : rien à exécuter (déjà traité)` };
    return { ok: true, summary: `Règle « ${rule.name} » exécutée (${created} action(s))` };
  }

  // ── CRUD ──

  list(filter?: { enabled?: boolean }): AutomationRule[] {
    let sql = "SELECT * FROM automation_rules ORDER BY created_at";
    const params: SqlValue[] = [];
    if (filter?.enabled !== undefined) {
      sql = "SELECT * FROM automation_rules WHERE enabled = ? ORDER BY created_at";
      params.push(filter.enabled ? 1 : 0);
    }
    return this.d.db.all<Row>(sql, ...params).map(toRule);
  }

  get(id: string): AutomationRule | undefined {
    const row = this.d.db.get<Row>("SELECT * FROM automation_rules WHERE id = ?", id);
    return row ? toRule(row) : undefined;
  }

  create(input: { name: string; trigger: AutomationTrigger; actions: AutomationAction[]; enabled?: boolean }): AutomationRule {
    const now = this.at();
    const id = randomUUID();
    this.d.db.run(
      `INSERT INTO automation_rules (id, name, enabled, trigger, actions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.trigger),
      JSON.stringify(input.actions),
      now,
      now,
    );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Pick<AutomationRule, "name" | "enabled" | "trigger" | "actions">>): AutomationRule | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const now = this.at();
    const fields: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) { fields.push("name = ?"); params.push(patch.name); }
    if (patch.enabled !== undefined) { fields.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
    if (patch.trigger !== undefined) { fields.push("trigger = ?"); params.push(JSON.stringify(patch.trigger)); }
    if (patch.actions !== undefined) { fields.push("actions = ?"); params.push(JSON.stringify(patch.actions)); }
    if (!fields.length) return existing;
    fields.push("updated_at = ?"); params.push(now);
    params.push(id);
    this.d.db.run(`UPDATE automation_rules SET ${fields.join(", ")} WHERE id = ?`, ...params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.d.db.run("DELETE FROM automation_rules WHERE id = ?", id);
    return true;
  }
}

/**
 * H5 — le DERNIER créneau dû (<= `now`) après `from`, et combien de créneaux ont été sautés.
 *
 * `nextCronRun` avance d'un créneau à la fois : le laisser guider la boucle faisait rejouer chaque créneau
 * manqué, un par tick. On rend donc le plus récent, et le nombre de ceux qu'on a volontairement sautés —
 * pour pouvoir le journaliser au lieu de le taire.
 *
 * `maxSteps` borne le calcul (un cron à la seconde sur un an) : on rend alors le dernier créneau atteint,
 * qui est bien le plus récent <= `now`.
 */
export function lastDueSlot(
  cron: string,
  from: number,
  now: number,
  maxSteps = 1000,
): { slot: number | null; skipped: number } {
  let slot = nextCronRun(cron, from);
  if (slot > now) return { slot: null, skipped: 0 };
  let skipped = 0;
  for (let i = 0; i < maxSteps; i++) {
    const next = nextCronRun(cron, slot);
    if (next > now) break;
    slot = next;
    skipped++;
  }
  return { slot, skipped };
}

function toRule(row: Row): AutomationRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    trigger: JSON.parse(row.trigger),
    actions: JSON.parse(row.actions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}