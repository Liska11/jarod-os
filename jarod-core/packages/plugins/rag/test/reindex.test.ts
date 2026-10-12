// Lot A ⑤ : réindexation depuis le manifeste et le texte gardés — sans relire l'original, un document à la fois, atomique.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentParser } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { BuiltinParser, chunkDocument, chunkText, docIdOf, markdownSections, RagService } from "../src/index.js";

afterEach(cleanup);

const embed = (dim: number) => async (texts: string[]) =>
  texts.map((t) => Float32Array.from({ length: dim }, (_, i) => ((t.charCodeAt(i % Math.max(1, t.length)) || 1) + i) / 300));

async function setup(cfg: Record<string, unknown> = { chunkSize: 200, chunkOverlap: 0 }, parser?: DocumentParser) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  const configure = (extra: Record<string, unknown>) => settings.set("rag", { ...settings.get("rag"), enabled: true, ...cfg, ...extra });
  configure({});
  const rag = parser
    ? new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never }, parser })
    : app.rag.rag;
  rag.setEmbedder(embed(4));
  const rows = () =>
    db.all<{ id: number; doc_id: string; ord: number; text: string; dim: number; sha256: string; model: string | null }>(
      "SELECT id, doc_id, ord, text, dim, sha256, model FROM rag_chunks ORDER BY doc_id, ord",
    );
  const stable = () => rows().map(({ id: _id, ...r }) => r);
  const spans = () =>
    db.all<{ doc_id: string; ord: number; char_start: number; char_end: number; section: string | null }>(
      "SELECT c.doc_id, c.ord, s.char_start, s.char_end, s.section FROM rag_chunk_spans s JOIN rag_chunks c ON c.id = s.chunk_id ORDER BY c.doc_id, c.ord",
    );
  return { app, db, rag, rows, stable, spans, configure };
}

const line = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} ligne ${i} : un texte assez long pour remplir un chunk ou deux.`).join("\n");
const MD = `# Guide\n${line("g", 6)}\n\n## Installation\n${line("i", 6)}\n\n## Usage\n${line("u", 6)}\n`;

describe("RagService.reindex", () => {
  it("rechunk et réembarque depuis le texte gardé, SANS relire le fichier (supprimé) : nouvelle taille, mêmes documents", async () => {
    const { rag, rows, spans, configure } = await setup({ chunkSize: 300, chunkOverlap: 0 });
    const dir = tempDir();
    writeFileSync(join(dir, "guide.md"), MD);
    await rag.indexFolder(dir);
    const before = rows();
    expect(before.map((r) => r.text)).toEqual(chunkText(MD, 300, 0));
    rmSync(join(dir, "guide.md")); // l'original n'existe plus

    configure({ chunkSize: 120 });
    expect(await rag.reindex()).toEqual({ documents: 1, chunks: chunkText(MD, 120, 0).length, missing: 0 });
    const after = rows();
    expect(after.map((r) => r.text)).toEqual(chunkText(MD, 120, 0));
    // M4 : l'identifiant est le chemin ABSOLU du fichier indexé — on vérifie qu'il est IDENTIQUE avant/après
    // (le document survit au rechunk) ET qu'il correspond bien à ce fichier.
    const docId = docIdOf(join(dir, "guide.md"));
    expect(after.every((r) => r.doc_id === docId), "même document, identifiant inchangé").toBe(true);
    expect(before.every((r) => r.doc_id === docId)).toBe(true);
    expect(spans()).toHaveLength(after.length);
    expect(spans().map((s) => s.section)).toContain("Usage");
    // Les identifiants de chunks sont neufs (AUTOINCREMENT, jamais réutilisés) : les index dérivés se reconstruisent.
    expect(Math.min(...after.map((r) => r.id))).toBeGreaterThan(Math.max(...before.map((r) => r.id)));
  });

  it("changement de modèle d'embeddings : la recherche refuse l'ancien index (RAG_DIM_MISMATCH), la réindexation le corrige", async () => {
    const { rag, rows, stable, configure } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    expect(rows().every((r) => r.dim === 4)).toBe(true);
    rag.setEmbedder(embed(8));
    configure({ embeddingsModel: "modele-b" });
    await expect(rag.search("Installation")).rejects.toThrow(/RAG_DIM_MISMATCH|dimension/i);
    expect(await rag.reindex()).toMatchObject({ documents: 1, missing: 0 });
    expect(rows().every((r) => r.dim === 8 && r.model === "modele-b")).toBe(true);
    expect((await rag.search("Installation")).length).toBeGreaterThan(0);
    expect(stable().map((r) => r.text)).toEqual(chunkText(MD, 200, 0)); // même texte, même découpage
  });

  it("idempotente : rejouée avec les mêmes réglages, mêmes lignes (hors identifiants)", async () => {
    const { rag, stable, rows } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const before = stable();
    await rag.reindex();
    await rag.reindex();
    expect(stable()).toEqual(before);
    expect(new Set(rows().map((r) => r.id)).size).toBe(rows().length);
  });

  it("un document structuré (parseur autre que builtin) est redécoupé par chunkDocument, aux frontières de section", async () => {
    const structured: DocumentParser = {
      available: true,
      info: () => ({ name: "structure", version: "1" }),
      accepts: () => true,
      async parse(input) {
        const text = new TextDecoder().decode("bytes" in input ? input.bytes : new Uint8Array());
        const base = await new BuiltinParser().parse({ bytes: new TextEncoder().encode(text), name: "x.md" });
        return { text, manifest: { ...base.manifest, parser: { name: "structure", version: "1" }, sections: markdownSections(text) } };
      },
    };
    const { db, rag, rows, configure } = await setup({ chunkSize: 400, chunkOverlap: 0 }, structured);
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    configure({ chunkSize: 150 });
    await rag.reindex();
    const manifestRow = db.get<{ manifest: string }>("SELECT manifest FROM rag_documents")!;
    const expected = chunkDocument({ manifest: JSON.parse(manifestRow.manifest), text: MD }, 150, 0);
    expect(rows().map((r) => r.text)).toEqual(expected.map((c) => c.text));
    expect(rows().map((r) => r.text)).not.toEqual(chunkText(MD, 150, 0)); // le découpage par sections diffère du découpage d'origine
  });

  it("un document indexé avant les manifestes est compté et laissé tel quel ; demandé par son identifiant, l'erreur dit quoi faire", async () => {
    const { db, rag, rows, stable } = await setup();
    await rag.ingest(MD, { docId: "ancien", source: "ancien.md" });
    await rag.ingest(MD + "suite", { docId: "recent", source: "recent.md" });
    db.run("DELETE FROM rag_documents WHERE doc_id = 'ancien'"); // ce que voit une base d'avant la v19
    const before = rows().filter((r) => r.doc_id === "ancien");
    expect(await rag.reindex()).toMatchObject({ documents: 1, missing: 1 });
    expect(rows().filter((r) => r.doc_id === "ancien")).toEqual(before); // mêmes lignes, mêmes identifiants
    await expect(rag.reindex({ docId: "ancien" })).rejects.toThrow(/RAG_NO_MANIFEST.*rag_index/);
    await expect(rag.reindex({ docId: "inconnu" })).rejects.toThrow(/RAG_UNKNOWN_DOC/);
    expect(stable().length).toBeGreaterThan(0);
  });

  it("un seul document quand on le demande : les autres gardent leurs identifiants", async () => {
    const { rag, rows } = await setup();
    await rag.ingest(MD, { docId: "a", source: "a.md" });
    await rag.ingest(MD + "b", { docId: "b", source: "b.md" });
    const idsB = rows().filter((r) => r.doc_id === "b").map((r) => r.id);
    const idsA = rows().filter((r) => r.doc_id === "a").map((r) => r.id);
    expect(await rag.reindex({ docId: "a" })).toMatchObject({ documents: 1, missing: 0 });
    expect(rows().filter((r) => r.doc_id === "b").map((r) => r.id)).toEqual(idsB);
    expect(rows().filter((r) => r.doc_id === "a").map((r) => r.id)).not.toEqual(idsA);
  });

  it("atomique par document : un échec d'embedding arrête l'exécution, le document en cours et les suivants restent intacts", async () => {
    const { rag, rows, configure } = await setup();
    await rag.ingest(MD, { docId: "a", source: "a.md" });
    await rag.ingest(MD + "b", { docId: "b", source: "b.md" });
    await rag.ingest(MD + "c", { docId: "c", source: "c.md" });
    const before = rows();
    configure({ chunkSize: 100 });
    let calls = 0;
    rag.setEmbedder(async (texts) => {
      if (++calls === 2) throw new Error("serveur d'embeddings absent");
      return embed(4)(texts);
    });
    await expect(rag.reindex()).rejects.toThrow(/serveur d'embeddings absent/);
    const after = rows();
    expect(after.filter((r) => r.doc_id === "a").map((r) => r.text)).toEqual(chunkText(MD, 100, 0)); // le premier est fait
    expect(after.filter((r) => r.doc_id === "b")).toEqual(before.filter((r) => r.doc_id === "b")); // celui qui a échoué : intact
    expect(after.filter((r) => r.doc_id === "c")).toEqual(before.filter((r) => r.doc_id === "c")); // le suivant : pas touché
  });

  it("la recherche voit le résultat (index en mémoire invalidé) ; désactivée, la réindexation le dit", async () => {
    const { rag, configure } = await setup({ chunkSize: 300, chunkOverlap: 0 });
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const first = await rag.search("Usage", 8);
    configure({ chunkSize: 100 });
    await rag.reindex();
    const second = await rag.search("Usage", 8);
    expect(second.map((h) => h.text)).not.toEqual(first.map((h) => h.text));
    for (const h of second) expect(chunkText(MD, 100, 0)).toContain(h.text);
    configure({ enabled: false });
    await expect(rag.reindex()).rejects.toThrow(/désactivé/);
  });

  it("un manifeste illisible en base : erreur nommée, aucune ligne touchée", async () => {
    const { db, rag, rows } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const before = rows();
    db.run("UPDATE rag_documents SET manifest = '{\"pas\":\"un manifeste\"}'");
    await expect(rag.reindex()).rejects.toThrow(/RAG_BAD_MANIFEST.*guide/);
    expect(rows()).toEqual(before);
  });
});

// SPECS-P5-UI-PARITE.md § 20 : avancement, annulation, plan, texte le plus récent, déterminisme (critère du lot A).
describe("RagService.reindex — § 20 (bouton « Reindex »)", () => {
  const three = async (cfg?: Record<string, unknown>) => {
    const t = await setup(cfg);
    await t.rag.ingest(MD, { docId: "a", source: "a.md" });
    await t.rag.ingest(MD + "b", { docId: "b", source: "b.md" });
    await t.rag.ingest(MD + "c", { docId: "c", source: "c.md" });
    return t;
  };

  it("RS1 onProgress : done va de 0 à N, un appel par document, total constant, identifiant du document refait", async () => {
    const { rag, configure } = await three();
    configure({ chunkSize: 100 });
    const seen: { done: number; total: number; docId: string | null }[] = [];
    const r = await rag.reindex({ onProgress: (p) => seen.push({ ...p }) });
    expect(seen).toEqual([
      { done: 0, total: 3, docId: null },
      { done: 1, total: 3, docId: "a" },
      { done: 2, total: 3, docId: "b" },
      { done: 3, total: 3, docId: "c" },
    ]);
    expect(r).toMatchObject({ documents: 3, missing: 0 });
    expect(r).not.toHaveProperty("cancelled");
  });

  it("RS2 signal interrompu après le premier document : un seul refait, cancelled, les autres gardent leurs passages d'avant, aucune erreur", async () => {
    const { rag, rows, configure } = await three();
    const before = rows();
    configure({ chunkSize: 100 });
    const ctrl = new AbortController();
    const r = await rag.reindex({ signal: ctrl.signal, onProgress: (p) => { if (p.done === 1) ctrl.abort(); } });
    expect(r).toMatchObject({ documents: 1, cancelled: true });
    const after = rows();
    expect(after.filter((x) => x.doc_id === "a").map((x) => x.text)).toEqual(chunkText(MD, 100, 0));
    expect(after.filter((x) => x.doc_id === "b")).toEqual(before.filter((x) => x.doc_id === "b"));
    expect(after.filter((x) => x.doc_id === "c")).toEqual(before.filter((x) => x.doc_id === "c"));
  });

  it("RS3 reindexPlan : documents, passages et non refaisables exacts, SANS appeler l'embedder ; éteint : refus", async () => {
    const { db, rag, rows, configure } = await three();
    db.run("DELETE FROM rag_documents WHERE doc_id = 'c'"); // « c » devient un document d'avant les manifestes
    const mine = rows().filter((x) => x.doc_id !== "c").length;
    let calls = 0;
    rag.setEmbedder(async (texts) => {
      calls++;
      return embed(4)(texts);
    });
    expect(rag.reindexPlan()).toEqual({ documents: 2, chunks: mine, missing: 1 });
    expect(calls).toBe(0);
    configure({ enabled: false });
    expect(() => rag.reindexPlan()).toThrow(/désactivé/);
  });

  it("RS4 un document modifié PENDANT la passe est découpé depuis son texte le plus récent ; un document oublié est sauté sans erreur", async () => {
    const { rag, rows, configure } = await three();
    configure({ chunkSize: 100 });
    const NEWER = line("nouveau", 5);
    let first = true;
    rag.setEmbedder(async (texts) => {
      if (first) {
        first = false;
        rag.setEmbedder(embed(4)); // les appels suivants (y compris celui de ingest ci-dessous) n'interviennent plus
        await rag.ingest(NEWER, { docId: "b", source: "b.md" }); // « b » change pendant que « a » est refait
        await rag.forget("c"); // et « c » disparaît
      }
      return embed(4)(texts);
    });
    const r = await rag.reindex();
    expect(r.documents).toBe(2); // a, b ; c a disparu
    expect(rows().filter((x) => x.doc_id === "b").map((x) => x.text)).toEqual(chunkText(NEWER, 100, 0));
    expect(rows().some((x) => x.doc_id === "c")).toBe(false);
  });

  it("RS5 déterminisme (critère du lot A) : après « Reindex » à la taille T, les lignes sont CELLES d'une ingestion neuve à T (hors id, at, identifiant) ; rejouer ne change rien ; mêmes passages trouvés, mêmes scores, même ordre ; les repérages suivent", async () => {
    const { db, rag, configure } = await setup({ chunkSize: 300, chunkOverlap: 0 });
    await rag.ingest(MD, { docId: "x", source: "g.md" });
    configure({ chunkSize: 120, chunkOverlap: 20 });
    await rag.reindex();
    await rag.ingest(MD, { docId: "y", source: "g.md" }); // ingestion NEUVE à la taille 120 / 20, même texte, même source
    const lines = (id: string) =>
      db.all<Record<string, unknown>>(
        "SELECT c.ord, c.text, c.dim, hex(c.embedding) AS emb, c.sha256, c.source, c.model, s.char_start, s.char_end, s.page, s.section FROM rag_chunks c LEFT JOIN rag_chunk_spans s ON s.chunk_id = c.id WHERE c.doc_id = ? ORDER BY c.ord",
        id,
      );
    expect(lines("x").length).toBeGreaterThan(3);
    expect(lines("x")).toEqual(lines("y"));
    expect(lines("x").every((l) => l.char_end !== null)).toBe(true); // repérages présents
    const docRow = (id: string) => db.get<Record<string, unknown>>("SELECT content_sha256, source, manifest, text FROM rag_documents WHERE doc_id = ?", id);
    expect(docRow("x")).toEqual(docRow("y"));
    const hitsOf = async () => (await rag.search("Installation", 8)).map((h) => [h.docId, h.text, h.score]);
    const hits1 = await hitsOf();
    const before = lines("x");
    await rag.reindex();
    await rag.reindex();
    expect(lines("x")).toEqual(before);
    expect(await hitsOf()).toEqual(hits1);
  });
});
