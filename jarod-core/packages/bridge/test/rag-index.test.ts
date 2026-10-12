/**
 * SPECS-P5-UI-PARITE.md § 20 — le bouton « Reindex » du volet Documents côté MAIN : canaux `rag-index-status`, `rag-reindex`, `rag-reindex-cancel`.
 * VRAI kernel (vrai service RAG, vraie base), VRAIS handlers, boîte native scriptée, embedder déterministe dont on peut RETENIR les réponses.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel, until } from "./ui-parite-helpers.js";

afterEach(cleanup);

interface Run {
  state: "idle" | "running" | "done" | "cancelled" | "failed";
  done: number;
  total: number;
  documents: number;
  passages: number;
  cancelling: boolean;
  error: string | null;
}
interface Status {
  enabled: boolean;
  documents: number;
  passages: number;
  reindexable: number;
  missing: number;
  endpoint: string | null;
  chunkSize: number;
  chunkOverlap: number;
  run: Run;
}
type Rag = {
  ingest(text: string, meta: { docId: string; source: string }): Promise<{ chunks: number }>;
  setEmbedder(f: (texts: string[]) => Promise<Float32Array[]>): void;
};

const vec = (t: string): Float32Array => Float32Array.from({ length: 4 }, (_, i) => ((t.charCodeAt(i % Math.max(1, t.length)) || 1) + i) / 300);
const line = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} ligne ${i} : un texte assez long pour remplir un passage ou deux.`).join("\n");

/** Un noyau avec N documents indexés à la taille 800 ; l'embedder suit `gate` (rendre une promesse non résolue RETIENT la réponse). */
async function setup(answers: boolean[], docs = 2, extra: Parameters<typeof setupKernel>[2] = {}) {
  const k = await setupKernel(undefined, answers, extra);
  const rag = (k.app as unknown as { rag: { rag: Rag } }).rag.rag;
  // `calls` compte les DOCUMENTS dont l'embarquement a commencé (un document tient en plusieurs lots : seul le premier lot, qui commence par « docN ligne 0 », compte).
  const hold = { calls: 0, gate: (_n: number): Promise<void> | undefined => undefined, fail: (_n: number): Error | undefined => undefined };
  rag.setEmbedder(async (texts) => {
    if (/^doc[0-9]+ ligne 0 /.test(texts[0] ?? "")) {
      const n = ++hold.calls;
      const err = hold.fail(n);
      if (err) throw err;
      await hold.gate(n);
    }
    return texts.map(vec);
  });
  const settings = k.app.agent.settings;
  settings.set("rag", { ...settings.get("rag"), enabled: true, embeddingsUrl: "http://127.0.0.1:1/v1", chunkSize: 800, chunkOverlap: 100 });
  for (let i = 0; i < docs; i++) await rag.ingest(line(`doc${i}`, 40), { docId: `d${i}`, source: `d${i}.md` });
  hold.calls = 0;
  const status = () => k.call("rag-index-status") as Promise<Status>;
  const rows = () =>
    (k.app as unknown as { storage: { db: { all<T>(sql: string, ...p: unknown[]): T[] } } }).storage.db.all<{ doc_id: string; n: number }>("SELECT doc_id, count(*) AS n FROM rag_chunks GROUP BY doc_id ORDER BY doc_id");
  const resize = (chunkSize: number, chunkOverlap = 20) => settings.set("rag", { ...settings.get("rag"), chunkSize, chunkOverlap });
  return { k, rag, hold, status, rows, resize };
}

describe("rag-index — état et refus", () => {
  it("RH1 l'état : interrupteur, documents, passages, refaisables, serveur, taille, et une passe au repos", async () => {
    const { status, rows } = await setup([], 2);
    const s = await status();
    expect(s).toMatchObject({ enabled: true, documents: 2, reindexable: 2, missing: 0, endpoint: "http://127.0.0.1:1/v1/embeddings", chunkSize: 800, chunkOverlap: 100 });
    expect(s.passages).toBe(rows().reduce((a, r) => a + r.n, 0));
    expect(s.run).toEqual({ state: "idle", done: 0, total: 0, documents: 0, passages: 0, cancelling: false, error: null });
  });

  it("RH2 interrupteur éteint : refus qui nomme « Réglages › Documents », aucune boîte, rien ne change", async () => {
    const { k, status, rows, hold, resize } = await setup([true], 2);
    resize(100);
    k.app.agent.settings.set("rag", { ...k.app.agent.settings.get("rag"), enabled: false });
    const before = rows();
    await expect(Promise.resolve().then(() => k.call("rag-reindex"))).rejects.toThrow(/Réglages › Documents/);
    expect(k.confirms).toHaveLength(0);
    expect(rows()).toEqual(before);
    expect(hold.calls).toBe(0);
    expect((await status()).enabled).toBe(false);
  });

  it("RH3 boîte REFUSÉE : rien ne démarre, aucun embarquement, passages d'avant ; boîte INDISPONIBLE : refusé", async () => {
    const { k, status, rows, hold, resize } = await setup([false], 2);
    resize(100);
    const before = rows();
    await expect(Promise.resolve().then(() => k.call("rag-reindex"))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(k.confirms).toHaveLength(1);
    expect(hold.calls).toBe(0);
    expect(rows()).toEqual(before);
    expect((await status()).run.state).toBe("idle");
    const nb = await setup([], 2, { noConfirm: true });
    nb.resize(100);
    await expect(Promise.resolve().then(() => nb.k.call("rag-reindex"))).rejects.toThrow(/confirmation native indisponible/);
    expect(nb.hold.calls).toBe(0);
  });

  it("RH8 rien à refaire : index vide, ou seulement des documents d'avant les manifestes — le refus le dit, sans boîte", async () => {
    const empty = await setup([true], 0);
    await expect(Promise.resolve().then(() => empty.k.call("rag-reindex"))).rejects.toThrow(/rien à refaire.*aucun document indexé/);
    expect(empty.k.confirms).toHaveLength(0);
    const old = await setup([true], 1);
    (old.k.app as unknown as { storage: { db: { run(sql: string): void } } }).storage.db.run("DELETE FROM rag_documents");
    const s = await old.status();
    expect(s).toMatchObject({ documents: 1, reindexable: 0, missing: 1 });
    await expect(Promise.resolve().then(() => old.k.call("rag-reindex"))).rejects.toThrow(/rien à refaire.*1 document\(s\) indexé\(s\) avant/);
    expect(old.k.confirms).toHaveLength(0);
  });
});

describe("rag-index — la passe", () => {
  it("RH4 boîte ACCEPTÉE : la boîte dit le nombre de documents, la taille, le recouvrement et le serveur ; la passe va à « done », les passages ont la nouvelle taille", async () => {
    const { k, status, rows, resize } = await setup([true], 2);
    const before = rows();
    resize(200, 50);
    const started = (await k.call("rag-reindex")) as Status;
    expect(["running", "done"]).toContain(started.run.state);
    expect(k.confirms).toHaveLength(1);
    expect(k.confirms[0]!.message).toMatch(/2 documents/);
    expect(k.confirms[0]!.detail).toMatch(/200 caractères/);
    expect(k.confirms[0]!.detail).toMatch(/recouvrement 50/);
    expect(k.confirms[0]!.detail).toContain("http://127.0.0.1:1/v1/embeddings");
    expect(k.confirms[0]!.detail).toMatch(/fichiers d'origine ne sont pas relus/);
    expect(k.confirms[0]!.action).toBe("Réindexer");
    let s = await status();
    for (let i = 0; i < 400 && s.run.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.run).toMatchObject({ state: "done", done: 2, total: 2, documents: 2, error: null });
    const after = rows();
    expect(after.map((r) => r.doc_id)).toEqual(["d0", "d1"]);
    for (let i = 0; i < 2; i++) expect(after[i]!.n, `d${i}`).toBeGreaterThan(before[i]!.n);
    expect(s.passages).toBe(after.reduce((a, r) => a + r.n, 0));
    expect(s.run.passages).toBe(s.passages);
  });

  it("RH5 une seconde demande pendant une passe est refusée, sans seconde boîte ; une seule passe tourne", async () => {
    const { k, status, hold, resize } = await setup([true, true], 2);
    resize(200, 50);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hold.gate = (n) => (n === 1 ? held : undefined);
    await k.call("rag-reindex");
    await until(() => hold.calls >= 1, "premier embarquement");
    await expect(Promise.resolve().then(() => k.call("rag-reindex"))).rejects.toThrow(/déjà en cours/);
    expect(k.confirms).toHaveLength(1);
    release();
    let s = await status();
    for (let i = 0; i < 400 && s.run.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.run.state).toBe("done");
    expect(hold.calls).toBe(2); // un embarquement par document, une seule passe
  });

  it("RH6 annulation : « cancelling » tout de suite, puis « cancelled », done < total, plus rien ne tourne ; le document déjà refait le reste", async () => {
    const { k, status, rows, hold, resize } = await setup([true], 3);
    const before = rows();
    resize(200, 50);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    hold.gate = (n) => (n === 1 ? held : undefined);
    await k.call("rag-reindex");
    await until(() => hold.calls >= 1, "premier embarquement");
    const c = (await k.call("rag-reindex-cancel")) as Status;
    expect(c.run).toMatchObject({ state: "running", cancelling: true });
    release();
    let s = await status();
    for (let i = 0; i < 400 && s.run.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.run).toMatchObject({ state: "cancelled", done: 1, total: 3, documents: 1, cancelling: false });
    const after = rows();
    expect(after[0]!.n).toBeGreaterThan(before[0]!.n); // d0 est refait
    expect(after[1]).toEqual(before[1]); // d1 et d2 gardent leurs passages d'avant
    expect(after[2]).toEqual(before[2]);
    expect(hold.calls).toBe(1);
    // rien ne tourne : une nouvelle demande est possible (elle demande sa boîte)
    await expect(Promise.resolve().then(() => k.call("rag-reindex-cancel"))).resolves.toMatchObject({ run: { state: "cancelled" } });
  });

  it("RH7 échec d'embarquement : « failed », message lisible SANS préfixe technique, documents non atteints intacts", async () => {
    const { k, status, rows, hold, resize } = await setup([true], 3);
    const before = rows();
    resize(200, 50);
    hold.fail = (n) => (n === 2 ? new Error("RAG_EMBED_HTTP_500 sur http://127.0.0.1:1/v1/embeddings — panne simulée. Un serveur d'embeddings répond-il à cette adresse ?") : undefined);
    await k.call("rag-reindex");
    let s = await status();
    for (let i = 0; i < 400 && s.run.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.run.state).toBe("failed");
    expect(s.run.error).toMatch(/Le serveur d'embeddings http:\/\/127\.0\.0\.1:1\/v1\/embeddings a répondu 500/);
    expect(s.run.error).toMatch(/après 1 sur 3/);
    expect(s.run.error).not.toMatch(/RAG_/);
    const after = rows();
    expect(after[0]!.n).toBeGreaterThan(before[0]!.n); // le premier est fait
    expect(after[1]).toEqual(before[1]); // celui qui a échoué : intact
    expect(after[2]).toEqual(before[2]);
  });

  it("RH9 l'avancement est observable PENDANT la passe (done monte, total constant)", async () => {
    const { k, status, hold, resize } = await setup([true], 3);
    resize(200, 50);
    const gates: (() => void)[] = [];
    hold.gate = (n) => new Promise<void>((r) => { gates[n] = r; });
    await k.call("rag-reindex");
    const seen: number[] = [];
    for (let n = 1; n <= 3; n++) {
      await until(() => hold.calls >= n, `embarquement ${n}`);
      const s = await status();
      expect(s.run).toMatchObject({ state: "running", total: 3 });
      seen.push(s.run.done);
      gates[n]!();
    }
    let s = await status();
    for (let i = 0; i < 400 && s.run.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(s.run).toMatchObject({ state: "done", done: 3 });
  });
});
