// Portage de packages/core/src/services/learning.ts (rév. 2e180305).
import { transcript } from "./agent.js";
import type { MemoryType } from "@jarod/contracts";
import type { EventStoreService } from "@jarod/plugin-storage";
import type { MemoryService } from "@jarod/plugin-memory";
import type { NotificationService } from "@jarod/plugin-storage";
import type { MessageService } from "./sessions.js";
import type { SettingsService } from "@jarod/plugin-storage";
import { PROFILE_SECTIONS, type UserProfileService } from "@jarod/plugin-memory";

/**
 * The learning review (Hermes Agent's periodic memory nudges): every `reviewEvery` user messages in
 * a conversation, once the agent is idle, a background call rereads the recent exchange and keeps
 * what will still be useful later — memories, lines of the user's profile, and the idea of a skill
 * when a reusable method was worked out. Nothing about secrets or sensitive data is kept, the review
 * never writes a skill itself (it only suggests one), and what it kept is logged and notified.
 */

const REVIEW_SYSTEM = `Tu relis un extrait de conversation entre un utilisateur et son assistant pour retenir ce qui servira dans de FUTURES conversations.
Réponds UNIQUEMENT par un objet JSON :
{"memories":[{"type":"fact|preference|context","content":"..."}],"profile":[{"section":"...","line":"..."}],"skill":null}
ou, si une méthode réutilisable a été mise au point, "skill":{"name":"...","description":"quand l'utiliser","why":"..."}.
Règles :
- Seulement des informations durables, dites par l'utilisateur ou clairement établies ; rien de ponctuel ni de déjà connu.
- JAMAIS de secret (mot de passe, clé, jeton, numéro de carte ou de compte), ni de donnée de santé, d'opinion politique ou religieuse.
- "profile" : sections ${PROFILE_SECTIONS.join(", ")} ; une phrase courte par ligne.
- Au plus 5 souvenirs et 3 lignes de profil. Listes vides s'il n'y a rien : c'est souvent le cas.`;

const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "context"];
/** A line that looks like a credential is dropped even if the model kept it anyway. */
const SECRET_RE = /(api[_-]?key|token|password|mot de passe|secret|sk-[a-z0-9]{8,}|\b\d{13,19}\b)/i;

export interface LearningConfig {
  enabled: boolean;
  /** A review after this many new user messages in a conversation. */
  reviewEvery: number;
}

export interface ReviewResult {
  memories: string[];
  profile: string[];
  skill: string | null;
}

export interface LearningDeps {
  messages: MessageService;
  memory: MemoryService;
  profile: UserProfileService;
  settings: SettingsService;
  notifications: NotificationService;
  events?: EventStoreService | null;
  complete(prompt: string, signal: AbortSignal, opts?: { system?: string }): Promise<string>;
  /** True while a turn of that conversation runs: the review waits for a quiet moment. */
  busy(sessionId: string): boolean;
}

export function parseReview(text: string): { memories: unknown[]; profile: unknown[]; skill: unknown } | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return {
      memories: Array.isArray(o.memories) ? o.memories : [],
      profile: Array.isArray(o.profile) ? o.profile : [],
      skill: o.skill ?? null,
    };
  } catch {
    return null;
  }
}

export class LearningService {
  private lastReviewed = new Map<string, number>();
  private reviewing = new Set<string>();

  constructor(private readonly d: LearningDeps) {}

  private config(): LearningConfig {
    return this.d.settings.get("learning");
  }

  private userCount(sessionId: string): number {
    return this.d.messages.list(sessionId).filter((m) => m.role === "user" && !m.kind).length;
  }

  /** Called after each finished turn: reviews when enough new user messages accumulated. */
  async afterTurn(sessionId: string): Promise<ReviewResult | null> {
    const cfg = this.config();
    if (!cfg.enabled || this.reviewing.has(sessionId)) return null;
    const count = this.userCount(sessionId);
    const last = this.lastReviewed.get(sessionId) ?? 0;
    if (count - last < Math.max(2, cfg.reviewEvery)) return null;
    // A goal may have started its next turn already: come back after it.
    await new Promise((r) => setImmediate(r));
    if (this.d.busy(sessionId)) return null;
    this.lastReviewed.set(sessionId, count);
    return this.review(sessionId);
  }

  async review(sessionId: string, signal = new AbortController().signal): Promise<ReviewResult> {
    this.reviewing.add(sessionId);
    try {
      const cfg = this.config();
      const recent = this.d.messages.list(sessionId).slice(-Math.max(6, cfg.reviewEvery * 3));
      const known = this.d.memory
        .list()
        .slice(0, 40)
        .map((m) => `- ${m.content}`)
        .join("\n");
      const prompt = [
        `Profil actuel :\n${this.d.profile.read() || "(vide)"}`,
        `Souvenirs déjà enregistrés :\n${known || "(aucun)"}`,
        `Extrait de conversation :\n${transcript(recent, 12_000)}`,
      ].join("\n\n");
      const parsed = parseReview(await this.d.complete(prompt, signal, { system: REVIEW_SYSTEM }));
      const result: ReviewResult = { memories: [], profile: [], skill: null };
      if (!parsed) return result;

      for (const raw of parsed.memories.slice(0, 5)) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const content = typeof o.content === "string" ? o.content.trim().slice(0, 500) : "";
        if (!content || SECRET_RE.test(content)) continue;
        const type = MEMORY_TYPES.includes(o.type as MemoryType) ? (o.type as MemoryType) : "fact";
        const before = this.d.memory.list().length;
        this.d.memory.add(content, type);
        if (this.d.memory.list().length > before) result.memories.push(content);
      }
      for (const raw of parsed.profile.slice(0, 3)) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const line = typeof o.line === "string" ? o.line.trim() : "";
        const section = typeof o.section === "string" && o.section.trim() ? o.section.trim() : "Préférences";
        if (!line || SECRET_RE.test(line)) continue;
        try {
          if (this.d.profile.add(section, line)) result.profile.push(`${section} : ${line}`);
        } catch {
          // The profile is full: the agent condenses it (user_profile set_section), the review does not.
        }
      }
      const skill = parsed.skill as { name?: unknown; description?: unknown } | null;
      if (skill && typeof skill.name === "string" && skill.name.trim()) {
        result.skill = `${skill.name.trim()}${typeof skill.description === "string" ? ` — ${skill.description.trim()}` : ""}`;
      }

      this.d.events?.append(`session:${sessionId}`, "learning-review", result);
      const kept = [...result.memories.map((m) => `souvenir : ${m}`), ...result.profile.map((p) => `profil : ${p}`)];
      if (kept.length) this.d.notifications.add("info", "Jarod a appris", kept.join("\n").slice(0, 600));
      if (result.skill) {
        this.d.notifications.add(
          "info",
          "Idée de skill",
          `${result.skill}\nDemandez à Jarod de l'enregistrer (skill_manage) si elle vous sert.`,
        );
      }
      return result;
    } finally {
      this.reviewing.delete(sessionId);
    }
  }
}
