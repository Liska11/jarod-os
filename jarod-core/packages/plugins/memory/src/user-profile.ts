// Portage de packages/core/src/services/user-profile.ts (rév. 2e180305).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file the user's profile lives in, next to SOUL.md: one per profile, readable and editable by hand. */
export const USER_PROFILE_FILE = "USER.md";
/** It goes into every system prompt: bounded, so that it is condensed instead of growing for ever. */
export const MAX_PROFILE_CHARS = 4000;
export const PROFILE_SECTIONS = ["Identité", "Préférences", "Projets en cours", "Façon de travailler"] as const;

const HEADER = "# Profil de l'utilisateur";

/**
 * The agent's model of the user (Hermes Agent's USER.md): who they are, what they prefer, what they
 * are working on, how they like to work. Individual facts stay in the memory service; this is the
 * short portrait read at the start of every conversation. Organised in `## sections` of `- lines`.
 */
export class UserProfileService {
  constructor(private readonly dir: () => string) {}

  path(): string {
    return join(this.dir(), USER_PROFILE_FILE);
  }

  read(): string {
    try {
      return readFileSync(this.path(), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Replaces the whole profile (the settings screen, or a condensed rewrite). */
  write(text: string): void {
    const content = text.trim();
    if (content.length > MAX_PROFILE_CHARS) {
      throw new Error(`Profil trop long (${content.length} caractères, max ${MAX_PROFILE_CHARS}) : condense-le.`);
    }
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(this.path(), content ? `${content}\n` : "", "utf8");
  }

  private sections(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    let current: string | null = null;
    for (const raw of this.read().split(/\r?\n/)) {
      const h = /^##\s+(.+?)\s*$/.exec(raw);
      if (h) {
        current = h[1]!;
        if (!map.has(current)) map.set(current, []);
        continue;
      }
      const line = raw.trim();
      if (current && line) map.get(current)!.push(line.replace(/^[-*]\s*/, ""));
    }
    return map;
  }

  private render(map: Map<string, string[]>): string {
    const parts = [HEADER];
    for (const [name, lines] of map) {
      if (!lines.length) continue;
      parts.push(`\n## ${name}\n${lines.map((l) => `- ${l}`).join("\n")}`);
    }
    return parts.length > 1 ? parts.join("\n") : "";
  }

  private section(name: string): string {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!clean) throw new Error("Section vide.");
    return clean;
  }

  /** Adds one line to a section (created if needed); an identical line is not added twice. */
  add(sectionName: string, line: string): boolean {
    const section = this.section(sectionName);
    const text = line.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) throw new Error("Ligne vide.");
    const map = this.sections();
    const lines = map.get(section) ?? [];
    if (lines.some((l) => l.toLowerCase() === text.toLowerCase())) return false;
    map.set(section, [...lines, text]);
    this.write(this.render(map));
    return true;
  }

  /** Replaces a section's lines (empty: removes the section). */
  setSection(sectionName: string, lines: string[]): void {
    const map = this.sections();
    const clean = lines
      .map((l) =>
        l
          .replace(/^[-*]\s*/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean);
    const section = this.section(sectionName);
    if (clean.length) map.set(section, clean);
    else map.delete(section);
    this.write(this.render(map));
  }

  /** Removes every line containing `text` (case-insensitive); returns how many went. */
  remove(text: string): number {
    const needle = text.trim().toLowerCase();
    if (!needle) return 0;
    const map = this.sections();
    let removed = 0;
    for (const [name, lines] of map) {
      const kept = lines.filter((l) => !l.toLowerCase().includes(needle));
      removed += lines.length - kept.length;
      map.set(name, kept);
    }
    if (removed) this.write(this.render(map));
    return removed;
  }

  exists(): boolean {
    return existsSync(this.path()) && this.read().length > 0;
  }
}
