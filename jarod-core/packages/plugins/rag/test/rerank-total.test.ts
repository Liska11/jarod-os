// SPECS-P5-RERANKER-ACTIVE.md Q4 (barre B) : chaque entrée du rapport de reclassement porte `totalMs`, la durée de la recherche TELLE QUE
// L'APPELANT LA VIT (dense + attente éventuelle du reclassement). Fantôme : le reclassement n'est pas attendu, donc `totalMs` < `ms` ;
// actif : il est attendu, donc `totalMs` ≥ `ms`. Un rejeu différé (fin de dictée) n'a pas de recherche à mesurer : pas de `totalMs`.
// Faux reranker, aucun OpenVINO ; un nombre seulement, aucun texte.
import type { EngineInfo, RerankHit, RerankRequest, RerankShadowEntry, RerankerProvider, VoicePriority } from "@jarod/contracts";
import { RerankShadowEntry as EntrySchema } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 16;
const vec = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? k * 0.1 : 0));
const QUERY = vec(0);

class FakeReranker implements RerankerProvider {
  available = true;
  readonly maxCandidates = 32;
  delayMs = 0;
  failWith: string | null = null;
  paused = false;
  info(): EngineInfo {
    return { name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" };
  }
  async rerank(req: RerankRequest): Promise<RerankHit[]> {
    if (this.paused) throw Object.assign(new Error("RERANKER_PAUSED"), { code: "RERANKER_PAUSED" });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    const n = req.candidates.length;
    return Array.from({ length: n }, (_, i) => n - 1 - i).slice(0, req.topN).map((i, rank) => ({ id: req.candidates[i]!.id, score: 1 - rank / 100 }));
  }
}

function fakeVoice() {
  let active = false;
  const waiters: (() => void)[] = [];
  const api: VoicePriority = {
    get active() {
      return active;
    },
    whenIdle: () => (active ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
  };
  return { api, busy: () => void (active = true), free: () => { active = false; for (const w of waiters.splice(0)) w(); } };
}

async function setup(mode: "shadow" | "active") {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 4, maxChunksPerDoc: 2 });
  settings.set("ecosystem", { ...settings.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 8, rerankDeadlineMs: 2000, rerankMode: mode });
  for (let k = 0; k < 12; k++) {
    db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", `doc${k}`, 0, `SECRET-TEXTE-${k}`, DIM, floatsToBlob(vec(k)), `h${k}`, `doc${k}`, "test", 1);
  }
  const fake = new FakeReranker();
  const voice = fakeVoice();
  const entries: RerankShadowEntry[] = [];
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never }, reranker: () => fake, rerankReport: (e) => entries.push(e), profile: "default", voice: () => voice.api });
  svc.setEmbedder(async () => [QUERY]);
  return { svc, fake, voice, entries };
}

describe("totalMs — mode fantôme", () => {
  it("le reclassement n'est pas attendu : totalMs est la durée SERVIE (courte), ms celle du calcul (longue)", async () => {
    const { svc, fake, entries } = await setup("shadow");
    fake.delayMs = 400;
    const t0 = Date.now();
    await svc.search("x");
    const served = Date.now() - t0;
    await svc.rerankIdle();
    expect(entries).toHaveLength(1);
    const e = EntrySchema.parse(entries[0]);
    expect(typeof e.totalMs).toBe("number");
    expect(e.ms).toBeGreaterThanOrEqual(350);
    expect(e.totalMs!).toBeLessThan(250);
    expect(e.totalMs!).toBeLessThan(e.ms);
    expect(Math.abs(e.totalMs! - served)).toBeLessThanOrEqual(100);
  });

  it("une panne du reranker : totalMs présent aussi (la recherche servie a une durée même sans classement)", async () => {
    const { svc, fake, entries } = await setup("shadow");
    fake.failWith = "RERANKER_TIMEOUT";
    await svc.search("x");
    await svc.rerankIdle();
    expect(entries[0]).toMatchObject({ outcome: "timeout", mode: "shadow" });
    expect(typeof entries[0]!.totalMs).toBe("number");
  });
});

describe("totalMs — mode actif", () => {
  it("le reclassement est attendu : totalMs ≥ ms et reflète l'attente vécue par l'appelant", async () => {
    const { svc, fake, entries } = await setup("active");
    fake.delayMs = 300;
    const t0 = Date.now();
    await svc.search("x");
    const served = Date.now() - t0;
    expect(entries).toHaveLength(1);
    const e = EntrySchema.parse(entries[0]);
    expect(e).toMatchObject({ outcome: "ok", mode: "active" });
    expect(e.ms).toBeGreaterThanOrEqual(250);
    expect(e.totalMs!).toBeGreaterThanOrEqual(e.ms);
    expect(Math.abs(e.totalMs! - served)).toBeLessThanOrEqual(100);
  });

  it("repli (échéance, panne) : totalMs présent et ≥ ms", async () => {
    const { svc, fake, entries } = await setup("active");
    fake.delayMs = 150;
    fake.failWith = "RERANKER_TIMEOUT";
    await svc.search("x");
    expect(entries[0]).toMatchObject({ outcome: "timeout", mode: "active", reranked: [] });
    expect(entries[0]!.totalMs!).toBeGreaterThanOrEqual(entries[0]!.ms);
  });

  it("dictée en cours (issue « paused ») : totalMs présent, court — c'est ce qui permet d'écarter ces lignes de la barre « hors dictée »", async () => {
    const { svc, fake, voice, entries } = await setup("active");
    voice.busy();
    fake.paused = true;
    await svc.search("x");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "paused", mode: "active" });
    expect(typeof entries[0]!.totalMs).toBe("number");
    expect(entries[0]!.totalMs!).toBeLessThan(500);
  });
});

describe("totalMs — rejeu différé et confidentialité", () => {
  it("fantôme : la ligne « paused » a un totalMs, le rejeu de fin de dictée n'en a PAS (il ne mesure aucune recherche servie)", async () => {
    const { svc, fake, voice, entries } = await setup("shadow");
    voice.busy();
    fake.paused = true;
    await svc.search("x");
    fake.paused = false;
    voice.free();
    await svc.rerankIdle();
    expect(entries.map((e) => e.outcome)).toEqual(["paused", "ok"]);
    expect(typeof entries[0]!.totalMs).toBe("number");
    expect("totalMs" in entries[1]!).toBe(false);
    for (const e of entries) expect(EntrySchema.safeParse(e).success).toBe(true);
  });

  it("aucun texte dans les entrées : ni passage, ni requête ; totalMs est un nombre fini ≥ 0", async () => {
    const { svc, entries } = await setup("active");
    await svc.search("question-secrete");
    const json = JSON.stringify(entries);
    expect(json).not.toContain("SECRET-TEXTE");
    expect(json).not.toContain("question-secrete");
    expect(Number.isFinite(entries[0]!.totalMs)).toBe(true);
    expect(entries[0]!.totalMs!).toBeGreaterThanOrEqual(0);
  });
});
