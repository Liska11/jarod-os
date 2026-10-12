// Portage de packages/core/src/services/persona.ts (rév. 2e180305).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The name of the file a profile's persona lives in. One file, one profile, editable by hand. */
export const PERSONA_FILE = "SOUL.md";

/**
 * The persona of one profile, as a markdown file.
 *
 * It is a file and not a setting on purpose: it is the thing a human edits, reads and moves between
 * machines, and the thing the Hermes One sync carries under `systemPrompt`. A row in a database
 * would be none of those. The portability bundle already picks up any `*.md` of a profile folder,
 * so a persona saved here travels on its own — that is the whole reason it is a file.
 */
export class PersonaService {
  constructor(private readonly dir: () => string) {}

  path(): string {
    return join(this.dir(), PERSONA_FILE);
  }

  exists(): boolean {
    return existsSync(this.path());
  }

  /** The persona as written, or an empty string — never a default invented in the code. */
  read(): string {
    try {
      return readFileSync(this.path(), "utf8");
    } catch {
      return "";
    }
  }

  /** Replace the persona. An empty string clears it rather than storing a blank file. */
  write(text: string): void {
    const content = text.trim();
    if (!content) {
      this.reset();
      return;
    }
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(this.path(), content.endsWith("\n") ? content : `${content}\n`, "utf8");
  }

  reset(): void {
    rmSync(this.path(), { force: true });
  }
}
