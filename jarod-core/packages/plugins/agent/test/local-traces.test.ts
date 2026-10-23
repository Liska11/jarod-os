// G2 — traces locales : la boucle réelle (kernel démarré avec TOUS les plugins, dont integrations et son SDK OpenTelemetry) écrit des traces
// corrélées dans <profil>/traces/ ; refus et annulation y sont distingués ; réglage éteint = rien n'est écrit ; aucun texte de l'utilisateur.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { executeGuardedTool, type SpanHandle, type SpanSink, type SpanStatus } from "../src/agent.js";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

const SECRET_TEXT = "phrase-utilisateur-a-ne-jamais-tracer";

async function boot(rules: { tool: string; decision: "allow" | "ask" | "deny" }[], traces: boolean) {
  const dataDir = tempDir();
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  plugins.permissions = { rules };
  const app = await bootApp(plugins);
  const core = app.agent;
  core.settings.set("autoTitle", false);
  core.settings.set("localTraces", { enabled: traces, retentionDays: 7, maxFileBytes: 5 * 1024 * 1024, maxFiles: 20 });
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "memory_save", args: { content: SECRET_TEXT } }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  return { core, dir: join(dataDir, "traces") };
}

interface Rec {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  status: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}
const read = (dir: string): { recs: Rec[]; raw: string } => {
  if (!existsSync(dir)) return { recs: [], raw: "" };
  const raw = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
  return { recs: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec), raw };
};

describe("G2 — traces locales branchées à la boucle réelle", () => {
  it("accord demandé puis donné : tour → modèle → outil (attente, exécution), une seule trace, sans texte de l'utilisateur", async () => {
    const { core, dir } = await boot([{ tool: "memory_save", decision: "ask" }], true);
    const s = core.sessions.create();
    await core.runAndWait(s.id, `retiens ${SECRET_TEXT}`, { emit: () => {}, approve: async () => true });
    const { recs, raw } = read(dir);
    const by = (n: string) => recs.filter((r) => r.name === n);
    const [turn] = by("conversation.turn");
    const [tool] = by("tool.call");
    expect(turn).toMatchObject({ status: "ok", attributes: { "session.id": s.id } });
    expect(by("llm.request").length).toBeGreaterThanOrEqual(2);
    for (const r of by("llm.request")) expect(r.parentSpanId).toBe(turn!.spanId);
    expect(tool).toMatchObject({ status: "ok", parentSpanId: turn!.spanId, attributes: { "tool.name": "memory_save" } });
    expect(by("tool.permission.wait")[0]).toMatchObject({ status: "ok", parentSpanId: tool!.spanId });
    expect(by("tool.execute")[0]).toMatchObject({ status: "ok", parentSpanId: tool!.spanId });
    expect(new Set(recs.map((r) => r.traceId)).size).toBe(1);
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).not.toContain("retiens");
  });

  it("règle deny : l'appel est tracé « denied », sans exécution", async () => {
    const { core, dir } = await boot([{ tool: "memory_save", decision: "deny" }], true);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", { emit: () => {}, approve: async () => true });
    const { recs } = read(dir);
    expect(recs.find((r) => r.name === "tool.call")).toMatchObject({ status: "denied" });
    expect(recs.some((r) => r.name === "tool.execute")).toBe(false);
  });

  it("accord refusé par l'utilisateur : attente « denied », appel « denied »", async () => {
    const { core, dir } = await boot([{ tool: "memory_save", decision: "ask" }], true);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", { emit: () => {}, approve: async () => false });
    const { recs } = read(dir);
    expect(recs.find((r) => r.name === "tool.permission.wait")).toMatchObject({ status: "denied" });
    expect(recs.find((r) => r.name === "tool.call")).toMatchObject({ status: "denied" });
  });

  it("réglage éteint (défaut) : aucun fichier n'est écrit", async () => {
    const { core, dir } = await boot([{ tool: "memory_save", decision: "allow" }], false);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", { emit: () => {}, approve: async () => true });
    expect(read(dir).recs).toEqual([]);
  });
});

describe("G2 — annulation pendant l'attente d'accord (contrat de la porte)", () => {
  it("l'attente et l'appel finissent « cancelled », l'outil ne s'exécute pas", async () => {
    const { core } = await boot([{ tool: "memory_save", decision: "ask" }], false);
    const ended: { name: string; status: SpanStatus; parent?: string }[] = [];
    const sink: SpanSink = {
      start(name, _a, parent?: SpanHandle) {
        const h: SpanHandle & { name: string } = { name, set: () => {}, end: (status) => ended.push({ name, status, ...(parent ? { parent: (parent as SpanHandle & { name: string }).name } : {}) }) };
        return h;
      },
    };
    const ctrl = new AbortController();
    const r = await executeGuardedTool(
      core.tools,
      "s1",
      { id: "t1", name: "memory_save", args: { content: "x" } },
      ctrl.signal,
      {
        approve: () => {
          setTimeout(() => ctrl.abort(), 20);
          return new Promise<boolean>(() => {});
        },
      },
      core.settings.getAll(),
      { gate: core.gate!, spans: sink },
    );
    expect(r.isError).toBe(true);
    expect(ended).toContainEqual({ name: "tool.permission.wait", status: "cancelled", parent: "tool.call" });
    expect(ended).toContainEqual({ name: "tool.call", status: "cancelled" });
    expect(ended.some((e) => e.name === "tool.execute")).toBe(false);
  });
});
