// Contrats gelés (contracts/v1) vus du noyau : NEVER_ALWAYS (C4) et l'enveloppe d'appel d'outil (C7, provisoire).
// Même répertoire de fixtures que la suite shell (apps/desktop/electron/shell/contracts.test.ts) et que la suite
// Python du bridge : un schéma et un code qui divergent font échouer les trois.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeGuardedTool, type AuditEntry } from "../src/agent.js";
import { NEVER_ALWAYS, NEVER_ALWAYS_REASONS } from "../src/never-always.js";
import { makeCore } from "./helpers.js";

// ajv vient de la racine du dépôt (dépendance remontée, non déclarée par ce paquet).
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../contracts/v1");
const read = (...parts: string[]): unknown => JSON.parse(readFileSync(path.join(ROOT, ...parts), "utf8"));
const index = read("index.json") as { contracts: { id: string; schema: string; fixtures: string }[] };
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, strictRequired: false, allErrors: true });
const validators = new Map<string, (doc: unknown) => boolean>();
for (const c of index.contracts) validators.set(c.id, ajv.compile(read(c.schema) as object));
const validator = (id: string) => {
  const v = validators.get(id);
  if (!v) throw new Error(`no contract ${id}`);
  return v;
};
const fixtures = (id: string) =>
  readdirSync(path.join(ROOT, "fixtures", id))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f, valid: f.startsWith("valid-"), doc: read("fixtures", id, f) }));

describe("contrats gelés : les fixtures du noyau", () => {
  for (const id of ["c4-never-always", "c7-tool-call", "c7-guarded-tool-result", "c7-tool-audit-entry"]) {
    for (const f of fixtures(id)) {
      it(`${id} / ${f.name} est ${f.valid ? "accepté" : "rejeté"}`, () => {
        expect(validator(id)(f.doc)).toBe(f.valid);
      });
    }
  }
});

describe("C4 NEVER_ALWAYS : le code est le fichier d'or, nom pour nom", () => {
  it("contient exactement les outils du contrat, chacun avec sa raison", () => {
    const golden = read("fixtures", "c4-never-always", "valid-current.json") as string[];
    expect([...NEVER_ALWAYS].sort()).toEqual([...golden].sort());
    for (const name of golden) expect(NEVER_ALWAYS_REASONS[name]?.length, name).toBeGreaterThan(10);
  });
});

describe("C7 appel d'outil gardé (provisoire) : ce que le code produit est conforme", () => {
  const upstream = { id: "c1", args: {} };

  async function harness() {
    const core = await makeCore();
    core.tools.register({
      name: "probe_read",
      description: "lit",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      source: "builtin",
      audited: true,
      run: async () => "contenu",
    });
    core.tools.register({
      name: "probe_write",
      description: "écrit",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      source: "builtin",
      dangerous: true,
      run: async () => "écrit",
    });
    core.tools.register({
      name: "probe_boom",
      description: "échoue",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      dangerous: true,
      run: async () => {
        throw new Error("boom");
      },
    });
    const audit: AuditEntry[] = [];
    const calls: unknown[] = [];
    const run = async (
      name: string,
      args: Record<string, unknown>,
      opts: { approve?: boolean; mode?: "plan" | "act"; gate?: "allow" | "ask" | "deny" } = {},
    ) => {
      const call = { ...upstream, name, args };
      calls.push(call);
      const settings = { ...core.settings.getAll(), workspace: null, autoApproveTools: false, ...(opts.mode ? { agentMode: opts.mode } : {}) };
      return executeGuardedTool(
        core.tools,
        "s1",
        call,
        new AbortController().signal,
        { approve: async () => opts.approve ?? true },
        settings as never,
        { audit: (e) => audit.push(e), gate: { decide: () => opts.gate ?? "allow" } },
      );
    };
    return { run, audit, calls };
  }

  it("rend toujours {content, isError}, et chaque ligne d'audit est conforme et fermée", async () => {
    const { run, audit, calls } = await harness();
    const results = [
      await run("nope", {}), // outil inconnu
      await run("probe_read", { path: "a" }), // lecture, journalisée
      await run("probe_read", {}), // argument requis manquant
      await run("probe_read", { __invalid_json__: "{" }), // appel tronqué
      await run("probe_write", { path: "a" }), // accordé
      await run("probe_write", { path: "a" }, { approve: false }), // refusé par la personne
      await run("probe_write", { path: "a" }, { mode: "plan" }), // bloqué en mode Plan
      await run("probe_write", { path: "a" }, { gate: "deny" }), // refusé par la règle
      await run("probe_write", { path: "a" }, { gate: "ask" }), // « demander » même hors outil sensible
      await run("probe_boom", {}), // l'outil lève
      await run("probe_write", { path: "x".repeat(5000) }), // arguments très longs : coupés
    ];

    const result = validator("c7-guarded-tool-result");
    for (const r of results) expect(result(r), JSON.stringify(r)).toBe(true);
    expect(results.map((r) => r.isError)).toEqual([true, false, true, true, false, true, true, true, false, true, false]);

    const call = validator("c7-tool-call");
    for (const c of calls) expect(call(c), JSON.stringify(c)).toBe(true);

    const entry = validator("c7-tool-audit-entry");
    expect(audit.length).toBeGreaterThanOrEqual(8);
    for (const e of audit) expect(entry(e), JSON.stringify(e)).toBe(true);
    expect(new Set(audit.map((e) => e.decision))).toEqual(new Set(["accordé", "refusé", "automatique", "bloqué (mode Plan)", "refusé (règle)"]));
  });

  it("n'écrit jamais d'argument long en entier ni de champ hors contrat", async () => {
    const { run, audit } = await harness();
    await run("probe_write", { path: "x".repeat(5000) });
    const [e] = audit;
    expect(e).toBeDefined();
    expect(e!.args.length).toBeLessThanOrEqual(600);
    expect(Object.keys(e!).sort()).toEqual(["args", "decision", "ok", "sessionId", "tool"]);
  });
});
