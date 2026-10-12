// Portage de packages/core/src/services/curator.ts (rév. 2e180305).
import type { Db } from "@jarod/plugin-storage";
import { now } from "@jarod/kernel/util";
import type { NotificationService } from "@jarod/plugin-storage";
import type { CuratorConfig, SettingsService } from "@jarod/plugin-storage";
import type { SkillRegistry } from "@jarod/plugin-skills";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type SkillState = "active" | "stale";

export interface SkillUsage {
  id: string;
  uses: number;
  patches: number;
  firstSeenAt: number;
  lastUsedAt: number | null;
  state: SkillState;
  pinned: boolean;
}

interface UsageRow {
  id: string;
  uses: number;
  patches: number;
  first_seen_at: number;
  last_used_at: number | null;
  state: string;
  pinned: number;
}

const toUsage = (r: UsageRow): SkillUsage => ({
  id: r.id,
  uses: r.uses,
  patches: r.patches,
  firstSeenAt: r.first_seen_at,
  lastUsedAt: r.last_used_at,
  state: r.state === "stale" ? "stale" : "active",
  pinned: r.pinned === 1,
});

export interface CuratorReport {
  dryRun: boolean;
  /** Skills that became stale during this pass. */
  stale: string[];
  /** Skills moved to `.archive/` (or that would be, in a dry run). */
  archived: string[];
  /** Skills left alone because they are pinned or used by a scheduled task. */
  protected: string[];
}

export interface CuratorDeps {
  db: Db;
  skills: SkillRegistry;
  settings: SettingsService;
  notifications: NotificationService;
  /** Prompts of the scheduled tasks: a skill one of them names is never retired under it. */
  schedulePrompts: () => string[];
  /** True while any conversation is generating. */
  busy: () => boolean;
}

/**
 * Keeps the skills the agent writes itself (`author: agent`) from piling up. It counts how often
 * each one is loaded and patched; a skill unused for `staleAfterDays` is marked stale, one unused
 * for `archiveAfterDays` moves to `.archive/` — never deleted. Skills the user wrote, pinned skills
 * and skills a scheduled task names are left alone. A pass runs at most every `intervalHours`, only
 * after `minIdleHours` without activity, and the very first observation only starts the clock.
 */
export class CuratorService {
  constructor(private readonly d: CuratorDeps) {}

  private config(): CuratorConfig {
    return this.d.settings.get("curator");
  }

  private ensure(id: string, at = now()): void {
    this.d.db.run("INSERT OR IGNORE INTO skill_usage (id, first_seen_at) VALUES (?, ?)", id, at);
  }

  /** A skill was loaded (or rewritten, which is a use too): it is active again. */
  recordUse(id: string, at = now()): void {
    this.ensure(id, at);
    this.d.db.run("UPDATE skill_usage SET uses = uses + 1, last_used_at = ?, state = 'active' WHERE id = ?", at, id);
  }

  recordPatch(id: string, at = now()): void {
    this.ensure(id, at);
    this.d.db.run(
      "UPDATE skill_usage SET patches = patches + 1, last_used_at = ?, state = 'active' WHERE id = ?",
      at,
      id,
    );
  }

  setPinned(id: string, pinned: boolean): void {
    if (!this.d.skills.get(id)) throw new Error(`Skill introuvable : ${id}`);
    this.ensure(id);
    this.d.db.run("UPDATE skill_usage SET pinned = ? WHERE id = ?", pinned ? 1 : 0, id);
  }

  usage(id: string): SkillUsage | undefined {
    const row = this.d.db.get<UsageRow>("SELECT * FROM skill_usage WHERE id = ?", id);
    return row && toUsage(row);
  }

  /** Usage of every skill currently on disk (rows are created for skills seen for the first time). */
  list(at = now()): (SkillUsage & { name: string; author?: string })[] {
    return this.d.skills.list().map((s) => {
      this.ensure(s.id, at);
      return { ...this.usage(s.id)!, name: s.name, ...(s.author ? { author: s.author } : {}) };
    });
  }

  /** One pass: deterministic transitions, no model call. `dryRun` reports without touching anything. */
  async run(opts: { dryRun?: boolean; at?: number } = {}): Promise<CuratorReport> {
    const at = opts.at ?? now();
    const dryRun = Boolean(opts.dryRun);
    const cfg = this.config();
    const scheduled = this.d.schedulePrompts().join("\n");
    const report: CuratorReport = { dryRun, stale: [], archived: [], protected: [] };
    for (const u of this.list(at)) {
      if (u.author !== "agent") continue;
      if (u.pinned || scheduled.includes(u.id)) {
        report.protected.push(u.id);
        continue;
      }
      // Never used: the creation date counts as the last use, which gives new skills a grace period.
      const idle = at - (u.lastUsedAt ?? u.firstSeenAt);
      if (idle >= cfg.archiveAfterDays * DAY) {
        report.archived.push(u.id);
        if (!dryRun) {
          await this.d.skills.archive(u.id);
          this.d.db.run("DELETE FROM skill_usage WHERE id = ?", u.id);
        }
      } else if (idle >= cfg.staleAfterDays * DAY && u.state !== "stale") {
        report.stale.push(u.id);
        if (!dryRun) this.d.db.run("UPDATE skill_usage SET state = 'stale' WHERE id = ?", u.id);
      }
    }
    if (!dryRun) {
      this.d.settings.set("curator", { ...this.config(), lastRunAt: at });
      if (report.archived.length || report.stale.length) {
        this.d.notifications.add("info", "Entretien des skills", describeCuratorReport(report));
      }
    }
    return report;
  }

  /**
   * Called by a timer: runs a pass when it is due and the app is idle. Returns the report, or null
   * when nothing ran. The first call on a fresh install only records the time.
   */
  async maybeRun(at = now()): Promise<CuratorReport | null> {
    const cfg = this.config();
    if (!cfg.enabled) return null;
    if (!cfg.lastRunAt) {
      this.d.settings.set("curator", { ...cfg, lastRunAt: at });
      return null;
    }
    if (at - cfg.lastRunAt < cfg.intervalHours * HOUR) return null;
    if (this.d.busy()) return null;
    const last = this.d.db.get<{ t: number | null }>("SELECT MAX(updated_at) AS t FROM sessions")?.t ?? 0;
    if (at - last < cfg.minIdleHours * HOUR) return null;
    return this.run({ at });
  }
}

export function describeCuratorReport(r: CuratorReport): string {
  const parts: string[] = [];
  if (r.stale.length) parts.push(`périmées : ${r.stale.join(", ")}`);
  if (r.archived.length) parts.push(`${r.dryRun ? "à archiver" : "archivées"} : ${r.archived.join(", ")}`);
  if (r.protected.length) parts.push(`protégées : ${r.protected.join(", ")}`);
  return parts.join(" · ") || "Rien à faire.";
}
