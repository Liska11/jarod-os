// SPECS-P5-VOIX-PRIORITAIRE.md §4, §6 : l'ingestion cède la place à la voix ENTRE deux lots d'embeddings ; la recherche, jamais.
import type { VoicePriority } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { RagService } from "../src/index.js";

afterEach(cleanup);

/** Une voix pilotée à la main. */
function fakeVoice() {
  let active = false;
  const waiters: (() => void)[] = [];
  const api: VoicePriority = {
    get active() {
      return active;
    },
    whenIdle: () => (active ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
  };
  return {
    api,
    set(v: boolean) {
      active = v;
      if (!v) for (const w of waiters.splice(0)) w();
    },
    waiting: () => waiters.length,
  };
}

const vec = (t: string) => Float32Array.from({ length: 4 }, (_, i) => (t.charCodeAt(i) || 1) / 255);
/** ~ 65 passages de 200 caractères : 5 lots de 16 (EMBED_BATCH). */
const TEXT = Array.from({ length: 130 }, (_, i) => `Phrase numéro ${i} du document de test, assez longue pour faire plusieurs passages dans le découpage.`).join("\n");

async function setup(voice?: () => VoicePriority | undefined, extra: { onBatch?: (n: number, size: number) => void } = {}) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0 });
  const logs: string[] = [];
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never }, ...(voice ? { voice } : {}), log: (l) => logs.push(l) });
  let batches = 0;
  svc.setEmbedder(async (texts) => {
    batches += 1;
    extra.onBatch?.(batches, texts.length);
    return texts.map(vec);
  });
  return { svc, db, logs, batches: () => batches };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

describe("l'ingestion cède la place à la voix entre deux lots", () => {
  it("la voix s'active pendant le 2e lot : le 3e attend, puis repart dès l'inactivation (sans délai ajouté)", async () => {
    const v = fakeVoice();
    const { svc, batches, logs } = await setup(() => v.api, { onBatch: (n) => n === 2 && v.set(true) });
    const done = svc.ingest(TEXT, { docId: "d", source: "d.md" });
    let finished = false;
    void done.then(() => (finished = true));
    await tick();
    expect(batches()).toBe(2); // le 3e lot n'est pas parti
    expect(v.waiting()).toBe(1);
    expect(finished).toBe(false);

    const t0 = Date.now();
    v.set(false);
    const r = await done;
    expect(Date.now() - t0).toBeLessThan(200); // reprise immédiate, aucun délai de grâce
    expect(batches()).toBeGreaterThanOrEqual(4);
    expect(r.chunks).toBeGreaterThan(48);
    expect(svc.voicePauses().pauses).toBe(1);
    expect(logs.length).toBe(0); // pause < 1 s : pas de bruit
  });

  it("un lot déjà parti n'est pas interrompu : au plus un lot recouvre l'ouverture de la fenêtre", async () => {
    const v = fakeVoice();
    const sizes: number[] = [];
    const { svc, batches } = await setup(() => v.api, { onBatch: (n, size) => (sizes.push(size), n === 1 && v.set(true)) });
    const done = svc.ingest(TEXT, { docId: "d", source: "d.md" });
    await tick();
    expect(batches()).toBe(1);
    expect(sizes[0]).toBe(16); // le lot en cours est allé jusqu'au bout
    v.set(false);
    await done;
    expect(sizes.every((s) => s <= 16)).toBe(true);
  });

  it("la recherche n'attend JAMAIS la voix", async () => {
    const v = fakeVoice();
    const { svc } = await setup(() => v.api);
    await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    v.set(true);
    const t0 = Date.now();
    const hits = await svc.search("Phrase numéro 3");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(hits.length).toBeGreaterThan(0);
    expect(v.waiting()).toBe(0);
  });

  it("aucune voix (plugin absent) : aucune attente, comportement d'avant (un seul appel à l'embedder)", async () => {
    const { svc, batches } = await setup(undefined);
    await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    expect(batches()).toBe(1);
    expect(svc.voicePauses()).toEqual({ pauses: 0, pausedMs: 0 });
  });

  it("voix inactive : aucune pause comptée", async () => {
    const v = fakeVoice();
    const { svc } = await setup(() => v.api);
    await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    expect(svc.voicePauses().pauses).toBe(0);
  });
});

describe("fail-open : la voix ne bloque jamais le RAG", () => {
  it("whenIdle qui lève : l'ingestion se termine et l'erreur est journalisée", async () => {
    const broken: VoicePriority = { active: true, whenIdle: () => Promise.reject(new Error("voix en panne")) };
    const { svc, logs, db } = await setup(() => broken);
    const r = await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    expect(r.chunks).toBeGreaterThan(48);
    expect(logs.join(" ")).toContain("voix en panne");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_chunks")!.n).toBe(r.chunks);
  });

  it("le fournisseur lui-même lève (lecture de la voix) : ingestion sans pause", async () => {
    const { svc, logs } = await setup(() => {
      throw new Error("plugin voice cassé");
    });
    const r = await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    expect(r.chunks).toBeGreaterThan(48);
    expect(logs.join(" ")).toContain("plugin voice cassé");
  });
});

describe("l'attente ne change rien au résultat ni ne tient de verrou", () => {
  it("mêmes passages et mêmes vecteurs avec et sans pauses", async () => {
    const plain = await setup(undefined);
    await plain.svc.ingest(TEXT, { docId: "d", source: "d.md" });
    const v = fakeVoice();
    const paused = await setup(() => v.api, { onBatch: (n) => n === 1 && v.set(true) });
    const done = paused.svc.ingest(TEXT, { docId: "d", source: "d.md" });
    await tick();
    v.set(false);
    await done;
    const rows = (db: typeof plain.db) => db.all<{ ord: number; text: string; sha256: string; embedding: Buffer }>("SELECT ord, text, sha256, embedding FROM rag_chunks ORDER BY ord").map((r) => ({ ...r, embedding: Buffer.from(r.embedding).toString("hex") }));
    expect(rows(paused.db)).toEqual(rows(plain.db));
    expect(paused.svc.voicePauses().pauses).toBe(1);
  });

  it("pendant l'attente, aucun document à moitié écrit ni verrou : la base reste lisible et inscriptible", async () => {
    const v = fakeVoice();
    const { svc, db } = await setup(() => v.api, { onBatch: (n) => n === 1 && v.set(true) });
    const done = svc.ingest(TEXT, { docId: "d", source: "d.md" });
    await tick();
    // L'ingestion attend ; rien n'est encore écrit (les vecteurs sont calculés AVANT la transaction).
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_chunks")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_documents")!.n).toBe(0);
    db.run("CREATE TABLE IF NOT EXISTS zz_probe (x INTEGER)");
    db.run("INSERT INTO zz_probe (x) VALUES (1)");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM zz_probe")!.n).toBe(1);
    v.set(false);
    await done;
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_documents")!.n).toBe(1);
  });

  it("la réindexation cède aussi la place (même chemin d'écriture) ; une pause > 1 s est journalisée", async () => {
    const v = fakeVoice();
    const { svc, logs } = await setup(() => v.api);
    await svc.ingest(TEXT, { docId: "d", source: "d.md" });
    v.set(true);
    const re = svc.reindex({ docId: "d" });
    await new Promise((r) => setTimeout(r, 1100));
    v.set(false);
    await re;
    expect(svc.voicePauses().pauses).toBeGreaterThanOrEqual(1);
    expect(logs.join(" ")).toContain("ingestion cédée à la voix");
  });
});
