// Plancher de sécurité : l'accord vaut « pour ce fichier, pour cette conversation » (30/10). Une boucle d'agent qui réécrit le même fichier ne demande qu'UN accord ;
// la copie avant écrasement est faite à chaque réécriture ; un autre fichier, un refus, ou un contenu extérieur lu entre-temps redemandent.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ToolCall } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore, tempDir } from "./helpers.js";

type Step = { name: string; args: Record<string, unknown> };
const write = (path: string, content: string): Step => ({ name: "write_file", args: { path, content } });

async function loop(opts: { profile: "plein" | "défaut"; steps: Step[]; files?: Record<string, string>; answers?: boolean[]; floor?: boolean }) {
  const workspace = join(tempDir(), "travail");
  mkdirSync(workspace, { recursive: true });
  for (const [name, content] of Object.entries(opts.files ?? {})) writeFileSync(join(workspace, name), content);
  const core = await makeCore();
  core.settings.patch({
    workspace,
    autoTitle: false,
    safetyFloor: opts.floor !== false,
    ...(opts.profile === "plein" ? { accessProfile: "full" as const, autoApproveTools: true } : { accessProfile: "custom" as const, autoApproveTools: false }),
  });
  core.tools.register({ name: "mcp_page", description: "Lit une page (MCP de test).", parameters: { type: "object", properties: {} }, source: "mcp", dangerous: false, run: async () => "page" });
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) => {
        const n = req.messages.filter((m) => m.role === "tool").length;
        return n < opts.steps.length ? { text: "", thinking: "", toolCalls: [{ id: `t${n}`, ...opts.steps[n]! } satisfies ToolCall], stopReason: "tool_use" } : { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" };
      },
      listModels: async () => [],
    }) as never;
  const asked: string[] = [];
  let i = 0;
  await core.runAndWait(core.sessions.create().id, "réécris le fichier", {
    emit: () => {},
    approve: async (_s: string, c: ToolCall) => {
      asked.push(`${c.name}:${String((c.args as { path?: string }).path ?? "")}`);
      return opts.answers ? (opts.answers[i++] ?? false) : true;
    },
  });
  const copies = join(core.options.dataDir, "overwritten");
  const backups = existsSync(copies) ? readdirSync(copies).sort().flatMap((d) => readdirSync(join(copies, d)).sort().map((f) => readFileSync(join(copies, d, f), "utf8"))) : [];
  const read = (name: string) => (existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : null);
  return { asked, backups, read };
}

describe.each(["plein", "défaut"] as const)("boucle qui réécrit le MÊME fichier — profil %s", (profile) => {
  it("un seul accord pour trois réécritures ; chaque version écrasée est copiée", async () => {
    const r = await loop({ profile, files: { "a.txt": "original" }, steps: [write("a.txt", "v1"), write("a.txt", "v2"), write("a.txt", "v3")] });
    expect(r.asked).toEqual(["write_file:a.txt"]);
    expect(r.read("a.txt")).toBe("v3");
    expect(r.backups.sort()).toEqual(["original", "v1", "v2"]);
  });
});

describe("l'accord ne déborde pas", () => {
  it("un AUTRE fichier existant redemande ; le premier reste accordé", async () => {
    const r = await loop({ profile: "plein", files: { "a.txt": "A", "b.txt": "B" }, steps: [write("a.txt", "a1"), write("b.txt", "b1"), write("a.txt", "a2"), write("b.txt", "b2")] });
    expect(r.asked).toEqual(["write_file:a.txt", "write_file:b.txt"]);
    expect(r.read("a.txt")).toBe("a2");
    expect(r.read("b.txt")).toBe("b2");
  });

  it("un REFUS n'accorde rien : le fichier est intact et la tentative suivante redemande", async () => {
    const r = await loop({ profile: "plein", files: { "a.txt": "original" }, answers: [false, false], steps: [write("a.txt", "v1"), write("a.txt", "v2")] });
    expect(r.asked).toEqual(["write_file:a.txt", "write_file:a.txt"]);
    expect(r.read("a.txt")).toBe("original");
    expect(r.backups).toEqual([]);
  });

  it("un fichier que l'agent CRÉE lui-même (profil Plein : aucune question pour un fichier neuf) se réécrit sans question, copie à chaque fois", async () => {
    const r = await loop({ profile: "plein", steps: [write("neuf.txt", "v1"), write("neuf.txt", "v2"), write("neuf.txt", "v3")] });
    expect(r.asked).toEqual([]);
    expect(r.read("neuf.txt")).toBe("v3");
    expect(r.backups.sort()).toEqual(["v1", "v2"]);
  });

  it("après la lecture d'un contenu EXTÉRIEUR dans le tour, le même fichier redemande, même accordé avant", async () => {
    const r = await loop({ profile: "plein", files: { "a.txt": "original" }, steps: [write("a.txt", "v1"), { name: "mcp_page", args: {} }, write("a.txt", "v2")] });
    expect(r.asked).toEqual(["write_file:a.txt", "write_file:a.txt"]);
  });

  it("plancher ÉTEINT : aucun accord mémorisé, le comportement d'avant (Plein : aucune question)", async () => {
    const r = await loop({ profile: "plein", floor: false, files: { "a.txt": "original" }, steps: [write("a.txt", "v1"), write("a.txt", "v2")] });
    expect(r.asked).toEqual([]);
    expect(r.backups).toEqual([]);
  });
});

describe("rétention des copies avant écrasement : les 20 dernières, ou moins de 7 jours", () => {
  it("retire ce qui est à la fois plus vieux que 7 jours ET au-delà des 20 plus récentes ; garde le reste", async () => {
    const { pruneBackups } = await import("../src/safety-floor.js");
    const { utimesSync } = await import("node:fs");
    const dir = tempDir();
    const now = new Date("2026-10-30T12:00:00Z");
    const day = 86_400_000;
    const make = (name: string, ageDays: number) => {
      const folder = join(dir, `d${name}`);
      mkdirSync(folder, { recursive: true });
      const f = join(folder, `${name}.txt`);
      writeFileSync(f, name);
      const t = new Date(now.getTime() - ageDays * day);
      utimesSync(f, t, t);
      return f;
    };
    const vieux = Array.from({ length: 30 }, (_, i) => make(`vieux${i}`, 10 + i)); // 30 copies de plus de 7 jours
    const recent = make("recent", 2); // moins de 7 jours : gardée même hors des 20 dernières
    const removed = pruneBackups(dir, 20, 7, now);
    // 31 copies : les 20 plus récentes = « recent » + les 19 moins vieilles ; les 11 plus vieilles (> 7 jours) partent
    expect(removed).toHaveLength(11);
    expect(existsSync(recent)).toBe(true);
    expect(vieux.filter((f) => existsSync(f))).toHaveLength(19);
    expect(existsSync(vieux[29]!)).toBe(false);
    expect(existsSync(vieux[0]!)).toBe(true);
  });

  it("une boucle de 25 réécritures garde 25 copies (toutes récentes) : la rétention ne mord que sur l'âge", async () => {
    const r = await loop({ profile: "plein", files: { "a.txt": "o" }, steps: Array.from({ length: 25 }, (_, i) => write("a.txt", `v${i}`)) });
    expect(r.backups).toHaveLength(25);
  });
});
