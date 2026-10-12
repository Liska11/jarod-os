// Lot A ③ : chaque document indexé garde son manifeste et son texte (`rag_documents`), chaque chunk sa place
// (`rag_chunk_spans`) — sans changer une ligne de `rag_chunks` (l'instantané `ingest-golden` le garantit).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentManifest, type DocumentParser } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { BuiltinParser, chunkText, chunkTextSpans, docIdOf, RagService, sectionAt } from "../src/index.js";

afterEach(cleanup);

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const embedder = async (texts: string[]) => texts.map((t) => Float32Array.from({ length: 4 }, (_, i) => (t.charCodeAt(i) || 1) / 255));

async function setup(cfg: Record<string, unknown> = { chunkSize: 120, chunkOverlap: 0 }, parser?: DocumentParser) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, ...cfg });
  // Service propre quand un parseur particulier est demandé ; sinon celui du plugin (parseur d'origine).
  const rag = parser ? new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never }, parser }) : app.rag.rag;
  rag.setEmbedder(embedder);
  const docs = () => db.all<Record<string, unknown>>("SELECT * FROM rag_documents ORDER BY doc_id");
  const spans = () =>
    db.all<{ doc_id: string; ord: number; text: string; char_start: number; char_end: number; page: number | null; section: string | null }>(
      "SELECT c.doc_id, c.ord, c.text, s.char_start, s.char_end, s.page, s.section FROM rag_chunk_spans s JOIN rag_chunks c ON c.id = s.chunk_id ORDER BY c.doc_id, c.ord",
    );
  const chunks = () => db.all<{ id: number; doc_id: string; ord: number; text: string; sha256: string }>("SELECT id, doc_id, ord, text, sha256 FROM rag_chunks ORDER BY doc_id, ord");
  return { app, db, rag, docs, spans, chunks };
}

const MD = ["# Guide", "Introduction au guide, assez longue pour faire plusieurs passages dans le découpage.", "", "## Installation", "Étape un : télécharger. Étape deux : lancer. Étape trois : vérifier que tout fonctionne bien.", "", "## Usage", "Utiliser la commande principale avec les options de son choix, puis relire le résultat obtenu."].join("\n");

describe("chunkTextSpans", () => {
  it("mêmes chunks que chunkText, et `text.slice(start, end)` les retrouve, quels que soient taille, recouvrement et texte", () => {
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const words = ["alpha", "bêta", "gamma", "δ", "\n", "  ", "x".repeat(40), "\n\n"];
    for (let n = 0; n < 60; n++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 80) }, () => words[Math.floor(next() * words.length)]!).join(next() < 0.5 ? " " : "");
      const size = 1 + Math.floor(next() * 90);
      const overlap = Math.floor(next() * 60);
      const spans = chunkTextSpans(text, size, overlap);
      expect(spans.map((c) => c.text), `${size}/${overlap}`).toEqual(chunkText(text, size, overlap));
      for (const c of spans) expect(text.slice(c.start, c.end)).toBe(c.text);
    }
    expect(chunkTextSpans("", 10, 0)).toEqual([]);
  });
});

describe("sectionAt", () => {
  const sections = [
    { start: 0, end: 50, page: null, level: 1, title: "A" },
    { start: 10, end: 30, page: null, level: 2, title: "A1" },
    { start: 30, end: 50, page: null, level: 2, title: "A2" },
    { start: 60, end: 80, page: null, level: 1, title: "B" },
  ];
  it("rend la section la plus profonde ; null hors de toute section", () => {
    expect(sectionAt(sections, 0)).toBe("A");
    expect(sectionAt(sections, 10)).toBe("A1");
    expect(sectionAt(sections, 29)).toBe("A1");
    expect(sectionAt(sections, 30)).toBe("A2");
    expect(sectionAt(sections, 55)).toBeNull();
    expect(sectionAt(sections, 60)).toBe("B");
    expect(sectionAt(sections, 80)).toBeNull();
    expect(sectionAt([], 3)).toBeNull();
  });
});

describe("ingestion : document, manifeste et repérage des chunks", () => {
  it("enregistre le document : parseur, empreintes, manifeste valide, texte — l'empreinte du contenu est celle des chunks", async () => {
    const { rag, docs, chunks } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const [doc] = docs() as Array<Record<string, string | number>>;
    expect(docs()).toHaveLength(1);
    expect(doc).toMatchObject({ doc_id: "guide", source: "guide.md", parser: "builtin", parser_version: "1", state: "indexed", text: MD });
    expect(doc!.source_sha256).toBe(sha(MD));
    expect(doc!.content_sha256).toBe(chunks()[0]!.sha256);
    const manifest = DocumentManifest.parse(JSON.parse(String(doc!.manifest)));
    expect(manifest.source).toEqual({ sha256: sha(MD), bytes: Buffer.byteLength(MD), mime: "text/markdown" });
    expect(manifest.sections.map((s) => s.title)).toEqual(["Guide", "Installation", "Usage"]);
  });

  it("repère chaque chunk : décalages qui retrouvent son texte, section la plus profonde, page inconnue", async () => {
    const { rag, docs, spans, chunks } = await setup();
    const r = await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    expect(r.chunks).toBeGreaterThanOrEqual(3);
    expect(spans()).toHaveLength(r.chunks);
    expect(chunks().map((c) => c.text)).toEqual(chunkText(MD, 120, 0)); // les chunks eux-mêmes n'ont pas changé
    const text = String((docs()[0] as { text: string }).text);
    for (const s of spans()) {
      expect(text.slice(s.char_start, s.char_end), `chunk ${s.ord}`).toBe(s.text);
      expect(s.page).toBeNull();
    }
    const bySection = new Set(spans().map((s) => s.section));
    expect(bySection).toEqual(new Set(["Guide", "Installation", "Usage"]));
    expect(spans()[0]!.section).toBe("Guide");
  });

  it("un texte sans titre (ou d'un autre type) : chunks repérés, section null", async () => {
    const { rag, spans } = await setup();
    await rag.ingest("# pas un titre pour un .py\n".repeat(20), { docId: "s", source: "s.py" });
    expect(spans().length).toBeGreaterThan(1);
    expect(new Set(spans().map((s) => s.section))).toEqual(new Set([null]));
  });

  it("un document modifié remplace tout : une seule ligne de document, repérage des anciens chunks parti avec eux", async () => {
    const { rag, docs, spans, chunks } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const r = await rag.ingest("# Nouveau\ntexte tout neuf", { docId: "guide", source: "guide.md" });
    expect(docs()).toHaveLength(1);
    expect((docs()[0] as { text: string }).text).toBe("# Nouveau\ntexte tout neuf");
    expect(chunks()).toHaveLength(r.chunks);
    expect(spans()).toHaveLength(r.chunks);
    expect(spans()[0]).toMatchObject({ char_start: 0, section: "Nouveau" });
  });

  it("contenu inchangé : rien n'est touché ; document indexé avant la v19 (sans manifeste) : le manifeste est ajouté, chunks et identifiants intacts", async () => {
    const { db, rag, docs, spans, chunks } = await setup();
    await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    const before = { chunks: chunks(), docs: docs(), spans: spans() };
    expect(await rag.ingest(MD, { docId: "guide", source: "guide.md" })).toMatchObject({ deduped: true, chunks: 0 });
    expect({ chunks: chunks(), docs: docs(), spans: spans() }).toEqual(before);

    // Ce que voit une base d'avant la v19 : des chunks, ni manifeste ni repérage.
    db.run("DELETE FROM rag_documents");
    db.run("DELETE FROM rag_chunk_spans");
    expect(await rag.ingest(MD, { docId: "guide", source: "guide.md" })).toMatchObject({ deduped: true, chunks: 0 });
    expect(chunks()).toEqual(before.chunks);
    expect(docs()).toEqual(before.docs.map((d) => ({ ...d, at: expect.any(Number) })));
    expect(spans()).toEqual([]); // pas de repérage sans réindexer : les chunks existants ne sont pas recalculés
  });

  it("forget retire le document ET le repérage, par identifiant, par source ou tout", async () => {
    const { rag, docs, spans } = await setup();
    await rag.ingest(MD, { docId: "a", source: "a.md" });
    await rag.ingest(MD + " (b)", { docId: "b", source: "b.md" });
    await rag.ingest(MD + " (c)", { docId: "c", source: "c.md" });
    expect(docs()).toHaveLength(3);
    rag.forget("a");
    expect(docs().map((d) => d.doc_id)).toEqual(["b", "c"]);
    rag.forget("b.md");
    expect(docs().map((d) => d.doc_id)).toEqual(["c"]);
    expect(new Set(spans().map((s) => s.doc_id))).toEqual(new Set(["c"]));
    rag.forget();
    expect(docs()).toEqual([]);
    expect(spans()).toEqual([]);
  });

  it("indexFolder et les octets d'origine : l'empreinte du manifeste est celle du FICHIER, même avec un octet invalide", async () => {
    const { rag, docs } = await setup();
    const dir = tempDir();
    const raw = Buffer.concat([Buffer.from("# Titre\ntexte "), Buffer.from([0xff]), Buffer.from(" fin\n")]);
    writeFileSync(join(dir, "n.md"), raw);
    await rag.indexFolder(dir);
    const doc = docs()[0] as { doc_id: string; source_sha256: string; text: string };
    expect(doc.doc_id).toBe(docIdOf(join(dir, "n.md")));
    expect(doc.source_sha256).toBe(sha(raw));
    expect(doc.text).toBe(raw.toString("utf8"));
    expect(doc.text).toContain("�");
  });

  it("caractère isolé d'une paire de substitution : le texte reçu est gardé, les sections abandonnées, l'erreur est dite dans le manifeste", async () => {
    const { rag, docs, spans, chunks } = await setup({ chunkSize: 4000, chunkOverlap: 0 });
    const text = "# Titre\navant \uD800 après";
    await rag.ingest(text, { docId: "s", source: "s.md" });
    const doc = docs()[0] as { text: string; manifest: string };
    expect(doc.text).toBe(chunks()[0]!.text); // SQLite range le caractère isolé en U+FFFD : le texte du document est celui des chunks
    expect(JSON.parse(doc.manifest)).toMatchObject({ sections: [], errors: [{ code: "TEXT_NOT_ROUNDTRIP", page: null }] });
    expect(spans()[0]).toMatchObject({ char_start: 0, char_end: text.length, section: null });
  });

  it("un parseur qui échoue ne fait pas échouer l'indexation : mêmes chunks, aucun document, aucun repérage", async () => {
    const broken: DocumentParser = { available: true, info: () => ({ name: "casse", version: "1" }), accepts: () => true, parse: async () => { throw new Error("boum"); } };
    const { rag, docs, spans, chunks } = await setup({ chunkSize: 120, chunkOverlap: 0 }, broken);
    const r = await rag.ingest(MD, { docId: "guide", source: "guide.md" });
    expect(r.deduped).toBe(false);
    expect(chunks().map((c) => c.text)).toEqual(chunkText(MD, 120, 0));
    expect(docs()).toEqual([]);
    expect(spans()).toEqual([]);
  });

  it("le parseur d'origine est celui du plugin (builtin) ; le service accepte un autre parseur sans rien changer aux chunks", async () => {
    const { rag: withPlugin, docs } = await setup();
    await withPlugin.ingest(MD, { docId: "x", source: "x.md" });
    expect((docs()[0] as { parser: string }).parser).toBe("builtin");
    const custom = new BuiltinParser();
    const { rag, chunks } = await setup({ chunkSize: 120, chunkOverlap: 0 }, custom);
    await rag.ingest(MD, { docId: "x", source: "x.md" });
    expect(chunks().map((c) => c.text)).toEqual(chunkText(MD, 120, 0));
  });
});
