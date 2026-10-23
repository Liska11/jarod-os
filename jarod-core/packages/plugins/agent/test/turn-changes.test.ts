// V-08 — ce qu'un tour a changé dans les fichiers : le diff borné (pur), puis les changements d'un tour sur la boucle RÉELLE (kernel, porte,
// points de reprise), et la preuve détaillée dans la ligne d'audit.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { diffLines, fileChange, hunksOf } from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

describe("V-08 — diff de lignes borné", () => {
  it("ajouts, retraits et lignes communes, dans l'ordre", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(diffLines([], ["un"])).toEqual([{ kind: "add", text: "un" }]);
  });

  it("le contexte se limite à trois lignes autour de chaque changement, en morceaux séparés", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const after = [...before];
    after[2] = "changé";
    after[25] = "aussi";
    const hunks = hunksOf(diffLines(before, after)!);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.filter((l) => l.kind === "same")).toHaveLength(5);
  });

  it("créé, supprimé, inchangé, binaire et fins de ligne Windows", () => {
    expect(fileChange("C:/w/a.txt", null, Buffer.from("x\ny\n"), "C:/w")).toMatchObject({ path: "a.txt", status: "created", added: 2, removed: 0 });
    expect(fileChange("C:/w/a.txt", Buffer.from("x\n"), null, "C:/w")).toMatchObject({ status: "deleted", removed: 1 });
    expect(fileChange("C:/w/a.txt", Buffer.from("x\r\ny\r\n"), Buffer.from("x\ny\n"), "C:/w")).toMatchObject({ status: "modified", added: 0, removed: 0 });
    expect(fileChange("C:/w/a.txt", Buffer.from("x"), Buffer.from("x"), "C:/w").status).toBe("unchanged");
    expect(fileChange("C:/w/a.bin", Buffer.from([0, 1]), Buffer.from([0, 2]), "C:/w")).toMatchObject({ status: "modified", note: expect.stringMatching(/binaire/) });
    expect(fileChange("D:/ailleurs/a.txt", null, Buffer.from("x"), "C:/w").path).toBe("D:/ailleurs/a.txt");
  });
});

describe("V-08 — les changements d'un tour, boucle réelle", () => {
  it("chaque tour rend SES changements (avant = son point de reprise, après = celui du tour suivant), et la preuve est dans l'audit", async () => {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
    plugins.scheduler = { autoStart: false };
    const core = (await bootApp(plugins)).agent;
    const workspace = tempDir();
    core.settings.set("autoTitle", false);
    core.settings.set("workspace", workspace);
    core.settings.set("accessProfile", "full");
    let next: { id: string; name: string; args: Record<string, unknown> } | null = null;
    core.providers.client = () =>
      ({
        chat: async (req: ChatRequest) =>
          req.messages.at(-1)?.role === "tool" || !next
            ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
            : { text: "", thinking: "", toolCalls: [next], stopReason: "tool_use" },
        listModels: async () => [],
      }) as never;
    const s = core.sessions.create().id;
    const turn = async (id: string, name: string, args: Record<string, unknown>) => {
      next = { id, name, args };
      await core.runAndWait(s, "fais-le", { emit: () => {}, approve: async () => true });
    };
    const file = join(workspace, "notes.txt");

    await turn("c1", "write_file", { path: file, content: "un\ndeux\ntrois\n" });
    await turn("c2", "write_file", { path: file, content: "un\nDEUX\ntrois\nquatre\n" });

    expect(core.turnChanges(s, "c1").files).toEqual([expect.objectContaining({ path: "notes.txt", status: "created", added: 3, removed: 0 })]);
    const second = core.turnChanges(s, "c2").files[0]!;
    expect(second).toMatchObject({ path: "notes.txt", status: "modified", added: 2, removed: 1 });
    expect(second.hunks!.flat().filter((l) => l.kind !== "same").map((l) => `${l.kind}:${l.text}`)).toEqual(["del:deux", "add:DEUX", "add:quatre"]);
    expect(readFileSync(file, "utf8")).toContain("DEUX");

    expect(core.turnChanges(s, "inconnu")).toEqual({ turn: null, files: [] });
    const line = core.auditOf(s).find((l) => l.callId === "c2")!;
    expect(line.evidence).toMatch(/notes\.txt relu : \d+ octets, contenu identique/);
    expect(existsSync(file)).toBe(true);
  });
});
