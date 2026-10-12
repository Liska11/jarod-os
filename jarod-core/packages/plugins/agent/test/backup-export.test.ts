// Portage de packages/core/test/extensions.test.ts:191-203 (rév. 2e180305).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeCore, tempDir } from "./helpers.js";

describe("profiles & backup", () => {
  it("backs up the database and exports a session as markdown", async () => {
    const core = await makeCore();
    const s = core.sessions.create("Export");
    core.messages.add(s.id, { role: "user", content: "Q?" });
    core.messages.add(s.id, { role: "assistant", content: "R.", model: "m" });
    const md = core.exportSessionMarkdown(s.id);
    expect(md).toContain("# Export");
    expect(md).toContain("R.");
    const dest = join(tempDir(), "b.db");
    core.backup(dest, "mot de passe");
    // Encrypted backups: no SQLite header in clear.
    expect(readFileSync(dest).subarray(0, 15).toString()).not.toBe("SQLite format 3");
  });
});
