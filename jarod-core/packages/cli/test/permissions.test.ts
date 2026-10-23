// `jarod permissions` : lire est libre ; écrire exige l'utilisateur au clavier (terminal interactif + code retapé) et refuse le shell de l'agent.
import type { PermissionRule } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/main.js";
import { parseDuration, permissionsCommand, type PermissionsIO, type ToolsView } from "../src/permissions.js";

const NOW = 1_800_000_000_000;

function harness(o: { interactive?: boolean; agentShell?: boolean; typed?: string; rules?: PermissionRule[] } = {}) {
  let rules: PermissionRule[] = o.rules ?? [];
  const out: string[] = [];
  const err: string[] = [];
  let writes = 0;
  const io: PermissionsIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    interactive: o.interactive ?? true,
    agentShell: o.agentShell ?? false,
    prompt: async () => o.typed ?? "424242",
    now: () => NOW,
    code: () => "424242",
  };
  const tools: ToolsView = {
    declared: (n) => ["system_files", "media_fetch", "system_diagnostics"].includes(n),
    facts: (n) => ({ exists: ["system_files", "media_fetch", "system_diagnostics"].includes(n), dangerous: n !== "system_diagnostics" }),
  };
  const store = {
    read: () => rules,
    write: (r: PermissionRule[]) => {
      writes++;
      rules = r;
    },
  };
  const run = (argv: string[]) => {
    const a = parseArgs(["permissions", ...argv]);
    return permissionsCommand(a.positional, a.flags, store, tools, io);
  };
  return { run, out, err, rules: () => rules, writes: () => writes };
}

describe("jarod permissions", () => {
  it("add auto : portée affichée, code retapé, règle écrite en tête avec ses bornes", async () => {
    const h = harness({ rules: [{ tool: "*", decision: "deny" }] });
    const code = await h.run(["add", "auto", "system_files", "--cible", "D:\\demo\\*", "--duree", "2h", "--utilisations", "5", "--note", "rangement démo"]);
    expect(code).toBe(0);
    expect(h.rules()[0]).toMatchObject({ tool: "system_files", decision: "allow", autonomous: true, target: "D:\\demo\\*", uses: 5, expiresAt: NOW + 7_200_000, note: "rangement démo", by: "commande" });
    expect(h.rules()[1]).toEqual({ tool: "*", decision: "deny" });
    expect(h.out.join("\n")).toMatch(/autoriser SANS accord « system_files » sur « D:\\demo\\\* »/);
    expect(h.out.join("\n")).toMatch(/Ce changement donne plus de pouvoir à l'agent/);
    expect(h.out.join("\n")).toMatch(/actions déjà lancées ne sont pas touchées/);
  });

  it("refus : sans terminal interactif, depuis le shell de l'agent, ou avec un mauvais code — rien n'est écrit", async () => {
    for (const o of [{ interactive: false }, { agentShell: true }, { typed: "000000" }]) {
      const h = harness(o);
      const code = await h.run(["add", "auto", "system_files", "--cible", "D:\\demo\\*"]);
      expect(code).not.toBe(0);
      expect(h.writes()).toBe(0);
    }
    const agent = harness({ agentShell: true });
    await agent.run(["reset"]);
    expect(agent.err.join("\n")).toMatch(/shell de l'agent/);
  });

  it("autonomie sans borne : refusée sans --large", async () => {
    const h = harness();
    expect(await h.run(["add", "auto", "run_shell"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/sans aucune borne/);
    expect(await h.run(["add", "auto", "run_shell", "--large"])).toBe(0);
    expect(h.rules()[0]).toMatchObject({ tool: "run_shell", autonomous: true });
  });

  it("list, explain, revoke, reset", async () => {
    const h = harness({ rules: [{ tool: "media_fetch", decision: "allow", autonomous: true, operation: "subtitles", target: "*.youtube.com", id: "p-abc123" }] });
    await h.run(["list"]);
    expect(h.out.join("\n")).toMatch(/1\. p-abc123 — autoriser SANS accord « media_fetch » sur « \*\.youtube\.com », opération « subtitles »/);
    await h.run(["explain", "media_fetch", "--cible", "www.youtube.com", "--operation", "audio"]);
    expect(h.out.join("\n")).toMatch(/media_fetch sur « www\.youtube\.com », opération « audio » : accord demandé/);
    await h.run(["explain", "media_fetch", "--cible", "www.youtube.com", "--operation", "subtitles"]);
    expect(h.out.join("\n")).toMatch(/: autorisé sans accord/);
    expect(await h.run(["revoke", "p-abc123"])).toBe(0);
    expect(h.rules()).toEqual([]);
    expect(await h.run(["revoke", "p-abc123"])).toBe(2);
  });

  it("durées : 30m, 8h, 7j ; au-delà de 30 jours, refusé", async () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("7j")).toBe(7 * 86_400_000);
    expect(() => parseDuration("demain")).toThrow(/illisible/);
    const h = harness();
    expect(await h.run(["add", "auto", "system_files", "--duree", "31j"])).toBe(2);
  });
});

describe("jarod permissions edit / move (2026-10-21) : même service que Réglages", () => {
  const DEMO: PermissionRule = { tool: "system_files", decision: "allow", autonomous: true, target: "D:/demo/*", uses: 3, id: "p-demo01" };
  const STOP: PermissionRule = { tool: "run_shell", decision: "deny", id: "p-shell1" };

  it("edit : en place, « aucune » retire une borne, plus d'utilisations est annoncé ; code retapé", async () => {
    const h = harness({ rules: [STOP, DEMO] });
    expect(await h.run(["edit", "p-demo01", "--utilisations", "10", "--duree", "2h"])).toBe(0);
    expect(h.rules()[1]).toMatchObject({ id: "p-demo01", uses: 10, expiresAt: NOW + 7_200_000, by: "commande" });
    expect(h.out.join("\n")).toMatch(/3 → 10 utilisation/);
    expect(await h.run(["edit", "2", "--utilisations", "aucune", "--duree", "permanente"])).toBe(0);
    expect(h.rules()[1]).not.toHaveProperty("uses");
    expect(h.rules()[1]).not.toHaveProperty("expiresAt");
    expect(await h.run(["edit", "p-demo01", "--cible", "aucune"])).toBe(2); // autonomie sans borne : refusée sans --large
  });

  it("move : l'ordre change ; refusé depuis le shell de l'agent comme toute écriture", async () => {
    const h = harness({ rules: [STOP, { tool: "run_shell", decision: "allow", target: "D:/demo/*", id: "p-allow1" }] });
    expect(await h.run(["move", "p-allow1", "1"])).toBe(0);
    expect(h.rules().map((r) => r.id)).toEqual(["p-allow1", "p-shell1"]);
    const agent = harness({ agentShell: true, rules: [STOP, DEMO] });
    expect(await agent.run(["move", "p-demo01", "1"])).toBe(3);
    expect(agent.writes()).toBe(0);
  });
});
