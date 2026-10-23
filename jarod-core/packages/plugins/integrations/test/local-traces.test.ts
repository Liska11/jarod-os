// G2 — exporteur JSONL local sur le SDK OpenTelemetry réel (@opentelemetry/sdk-trace-base 2.11.0) : épuration, rotation, rétention,
// désactivation, noms inconnus écartés, fichiers étrangers jamais supprimés.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLocalTraces, DEFAULT_LOCAL_TRACES, type LocalTracesConfig, normalizeTracesConfig } from "../src/otel/local-traces.js";

const root = mkdtempSync(join(tmpdir(), "jarod-traces-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `t${++n}`);
const lines = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l))
    : [];

describe("G2 — exporteur local", () => {
  it("écrit une trace parentée, avec durée et statut ; l'épurateur retire chemins, URL, clés et attributs inconnus", () => {
    const dir = fresh();
    const t = createLocalTraces({ dir, config: () => ({ ...DEFAULT_LOCAL_TRACES, enabled: true }) });
    const turn = t.sink.start("conversation.turn", { "session.id": "sess_1234" });
    const call = t.sink.start("tool.call", { "tool.name": "read_file", "tool.args": "C:\\Users\\moi\\.ssh\\id", "model.provider": "https://x.example" }, turn);
    call.end("denied");
    turn.end("ok");
    const recs = lines(dir);
    const c = recs.find((r) => r.name === "tool.call");
    const tr = recs.find((r) => r.name === "conversation.turn");
    expect(c).toMatchObject({ status: "denied", parentSpanId: tr.spanId, traceId: tr.traceId, attributes: { "tool.name": "read_file" } });
    expect(c.attributes).not.toHaveProperty("tool.args");
    expect(c.attributes).not.toHaveProperty("model.provider");
    expect(JSON.stringify(recs)).not.toMatch(/ssh|example/);
    expect(typeof c.durationMs).toBe("number");
  });

  it("réglage éteint : aucun fichier ; un nom de trace inconnu n'est jamais écrit", () => {
    const off = fresh();
    createLocalTraces({ dir: off, config: () => DEFAULT_LOCAL_TRACES }).sink.start("tool.call", { "tool.name": "x" }).end("ok");
    expect(existsSync(off)).toBe(false);
    const on = fresh();
    createLocalTraces({ dir: on, config: () => ({ ...DEFAULT_LOCAL_TRACES, enabled: true }) }).sink.start("prompt.dump", {}).end("ok");
    expect(lines(on)).toEqual([]);
  });

  it("rotation par taille : au-delà de maxFileBytes, un nouveau fichier du jour", () => {
    const dir = fresh();
    const cfg: LocalTracesConfig = { enabled: true, retentionDays: 7, maxFileBytes: 64 * 1024, maxFiles: 50 };
    const t = createLocalTraces({ dir, config: () => cfg });
    // Chaque ligne fait ~250 octets : 600 traces dépassent largement 64 Ko.
    for (let i = 0; i < 600; i++) t.sink.start("tool.call", { "tool.name": "read_file", "session.id": `sess_${i}xx` }).end("ok");
    const files = readdirSync(dir).sort();
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(f).toMatch(/^spans-\d{8}-\d+\.jsonl$/);
    expect(lines(dir)).toHaveLength(600);
  });

  it("rétention : les fichiers trop anciens et l'excédent partent ; un fichier étranger reste", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spans-20200101-1.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes-personnelles.jsonl"), "à garder\n");
    writeFileSync(join(dir, "spans-20991231-1.jsonl.bak"), "à garder\n");
    const now = Date.UTC(2026, 9, 20);
    const t = createLocalTraces({ dir, config: () => ({ enabled: true, retentionDays: 7, maxFileBytes: 64 * 1024, maxFiles: 2 }), now: () => now });
    // Deux fichiers récents existants, puis l'écriture du jour : maxFiles = 2 garde les deux derniers.
    writeFileSync(join(dir, "spans-20261018-1.jsonl"), "{}\n");
    writeFileSync(join(dir, "spans-20261019-1.jsonl"), "{}\n");
    t.sink.start("tool.call", { "tool.name": "x" }).end("ok");
    expect(readdirSync(dir).sort()).toEqual(["notes-personnelles.jsonl", "spans-20261019-1.jsonl", "spans-20261020-1.jsonl", "spans-20991231-1.jsonl.bak"]);
  });

  it("une configuration absurde est bornée", () => {
    expect(normalizeTracesConfig({ enabled: "yes", retentionDays: -3, maxFileBytes: 1, maxFiles: 1e9 })).toEqual({ enabled: false, retentionDays: 1, maxFileBytes: 64 * 1024, maxFiles: 200 });
    expect(normalizeTracesConfig(undefined)).toEqual(DEFAULT_LOCAL_TRACES);
  });

  it("une fin appelée deux fois n'écrit qu'une ligne ; après arrêt, plus rien n'est écrit", async () => {
    const dir = fresh();
    const t = createLocalTraces({ dir, config: () => ({ ...DEFAULT_LOCAL_TRACES, enabled: true }) });
    const h = t.sink.start("tool.execute", { "tool.name": "x" });
    h.end("ok");
    h.end("error");
    await t.shutdown();
    t.sink.start("tool.execute", { "tool.name": "y" }).end("ok");
    expect(lines(dir).map((r) => [r.name, r.status, r.attributes["tool.name"]])).toEqual([["tool.execute", "ok", "x"]]);
  });
});
