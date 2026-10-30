// CANARI du plancher de sécurité dans le lanceur LENT (`*.engine.test.ts`) : si le plancher cesse d'être actif sous ce régime, ce test échoue, et le lanceur
// échoue aussi quand il est ABSENT du rapport lent. Une écriture sur un fichier existant, profil Plein + « Tout autoriser », doit demander l'accord ; refusée, elle ne change rien.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ToolCall } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore, tempDir } from "./helpers.js";

describe("canari du plancher (régime lent)", () => {
  it("le réglage est allumé par défaut sur un profil neuf", async () => {
    const core = await makeCore();
    expect(core.settings.getAll().safetyFloor).toBe(true);
  });

  it("écriture sur un fichier existant, profil Plein + Tout autoriser : l'accord est demandé, refusé, le fichier est intact", async () => {
    const workspace = join(tempDir(), "travail");
    mkdirSync(workspace, { recursive: true });
    const file = join(workspace, "existant.txt");
    writeFileSync(file, "à garder");
    const core = await makeCore(); // réglages par défaut : le plancher n'est PAS touché ici
    core.settings.patch({ workspace, autoTitle: false, accessProfile: "full", autoApproveTools: true });
    core.providers.client = () =>
      ({
        chat: async (req: ChatRequest) =>
          req.messages.some((m) => m.role === "tool")
            ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
            : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "write_file", args: { path: file, content: "écrasé" } } satisfies ToolCall], stopReason: "tool_use" },
        listModels: async () => [],
      }) as never;
    const asked: string[] = [];
    await core.runAndWait(core.sessions.create().id, "écris", { emit: () => {}, approve: async (_s: string, c: ToolCall) => (asked.push(c.name), false) });
    expect(asked).toEqual(["write_file"]);
    expect(readFileSync(file, "utf8")).toBe("à garder");
  });
});
