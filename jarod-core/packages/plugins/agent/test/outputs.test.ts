// Cockpit, lot 3 (context-mode, natif) — scénario 4 de la mission : analyser de gros journaux sans saturer le contexte, et récupérer
// les extraits sources exacts. Sur la vraie base (migration incluse), puis dans la vraie boucle d'agent.
import { describe, expect, it } from "vitest";
import { OutputStore, outputTools } from "../src/outputs.js";
import { makeCore, tempDir } from "./helpers.js";

const bigLog = (errAt = 2041) =>
  Array.from({ length: 3000 }, (_v, i) => (i === errAt ? "2026-10-20 12:00:01 ERROR disque plein sur D:\\data (code 112)" : `2026-10-20 12:00:00 INFO ligne ${i + 1} tout va bien`)).join("\n");

describe("magasin des sorties volumineuses", () => {
  it("une sortie courte passe telle quelle ; une longue devient un aperçu avec référence, provenance et mode d'emploi", async () => {
    const core = await makeCore();
    const store = new OutputStore(core.db);
    expect(store.keep("s", "run_shell", "court").content).toBe("court");
    const text = bigLog();
    const kept = store.keep("s", "run_shell", text);
    expect(kept.stored).toMatchObject({ tool: "run_shell", bytes: text.length, lines: 3000 });
    expect(kept.content.length).toBeLessThan(5000);
    expect(kept.content).toMatch(/out:[0-9a-f-]+ · outil run_shell · \d+ caractères · 3000 lignes · sha256 [0-9a-f]{16}/);
    expect(kept.content).toMatch(/output_search/);
    const stats = store.stats("s");
    expect(stats.savedChars).toBe(text.length - kept.content.length);
    await core.dispose();
  });

  it("la recherche rend l'extrait exact avec son numéro de ligne ; la relecture rend l'original à l'octet près", async () => {
    const core = await makeCore();
    const store = new OutputStore(core.db);
    const text = bigLog();
    const id = store.keep("s", "run_shell", text).stored!.id;
    const hits = store.search("s", "disque plein");
    expect(hits[0]).toMatchObject({ id, tool: "run_shell" });
    expect(hits[0]!.lines.join("\n")).toContain("2042: 2026-10-20 12:00:01 ERROR disque plein sur D:\\data (code 112)");
    expect(store.read("s", id, 2042, 2042)!.text).toBe("2042: 2026-10-20 12:00:01 ERROR disque plein sur D:\\data (code 112)");
    // Rien n'est perdu : relu par morceaux, l'original revient entier.
    let back: string[] = [];
    for (let from = 1; from <= 3000; ) {
      const r = store.read("s", id, from)!;
      back = back.concat(r.text.split("\n").map((l) => l.replace(/^\d+: /, "")));
      from = r.to + 1;
    }
    expect(back.join("\n")).toBe(text);
    await core.dispose();
  });

  it("cloisonné par conversation, oublié avec elle ; les instructions de skill ne sont jamais déplacées", async () => {
    const core = await makeCore();
    const store = new OutputStore(core.db);
    const id = store.keep("a", "run_shell", bigLog()).stored!.id;
    expect(store.read("b", id)).toBeNull();
    expect(store.search("b", "disque")).toEqual([]);
    expect(store.keep("a", "load_skill", "x".repeat(20_000)).content).toHaveLength(20_000);
    store.forget("a");
    expect(store.read("a", id)).toBeNull();
    expect(store.stats("a").outputs).toBe(0);
    await core.dispose();
  });

  it("les outils output_search / output_read lisent la conversation de l'appel", async () => {
    const core = await makeCore();
    const store = new OutputStore(core.db);
    const id = store.keep("s", "web_fetch", bigLog()).stored!.id;
    const [search, read] = outputTools(store);
    expect(await search!.run({ query: "code 112" }, { sessionId: "s" })).toMatch(new RegExp(`out:${id} \\(web_fetch\\), lignes 2041-2060`));
    expect(await read!.run({ id: `out:${id}`, from: 1, to: 2 }, { sessionId: "s" })).toMatch(/lignes 1-2 sur 3000/);
    expect(await read!.run({ id }, { sessionId: "autre" })).toMatch(/inconnue/);
    await core.dispose();
  });
});

describe("dans la vraie boucle d'agent", () => {
  it("un gros résultat d'outil entre en aperçu dans la conversation ; la tâche et le magasin gardent l'original", async () => {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.set("autoTitle", false);
    core.settings.set("workspace", ws);
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(ws, "app.log"), bigLog(300));
    core.providers.client = () =>
      ({
        chat: async (req: { messages: { role: string }[] }) =>
          req.messages.some((m) => m.role === "tool")
            ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
            : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "read_file", args: { path: "app.log" } }], stopReason: "tool_use" },
        listModels: async () => [],
      }) as never;
    const s = core.sessions.create();
    await core.runAndWait(s.id, "lis le journal", { emit: () => {}, approve: async () => true });
    const tool = core.messages.list(s.id).filter((m) => m.role === "tool").at(-1)!;
    expect(tool.content.length).toBeLessThan(5000);
    expect(tool.content).toMatch(/Sortie volumineuse gardée hors du contexte/);
    expect(core.outputs.search(s.id, "disque plein")).toHaveLength(1);
    core.sessions.delete(s.id);
    expect(core.outputs.stats(s.id).outputs).toBe(0);
    await core.dispose();
  });
});
