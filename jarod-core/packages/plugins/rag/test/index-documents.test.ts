// Option b (DECISIONS 2026-09-30) : `indexFolder` / `indexDocument` lisent les PDF et fichiers Office par leurs workers.
// Les tests « réels » sont ignorés sans le venv (aucun téléchargement, hors ligne).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentManifest, type DocumentParser } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { docIdOf, listDocumentFiles, RagService } from "../src/index.js";

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const DOCLING = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const PDFIUM = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
const HAVE = existsSync(PYTHON) && existsSync(DOCLING) && existsSync(PDFIUM);
const SAMPLE = readFileSync(join(HERE, "fixtures", "sample.pdf"));

async function setup(rag: Record<string, unknown>, docling: boolean, parser?: DocumentParser) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0, ...rag });
  if (docling) settings.set("ecosystem", { ...settings.get("ecosystem"), documentParser: "docling" });
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never }, ...(parser ? { parser } : {}) });
  svc.setEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])));
  return { svc, db };
}

const workspace = () => {
  const dir = tempDir();
  mkdirSync(join(dir, "sous"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nUn texte assez long pour être indexé correctement dans le dossier.");
  writeFileSync(join(dir, "sous", "rapport.pdf"), SAMPLE);
  writeFileSync(join(dir, "casse.pdf"), SAMPLE.subarray(0, 200)); // tronqué : illisible
  return dir;
};

describe("listDocumentFiles", () => {
  it("ne liste que les PDF et fichiers Office, bornés, en ignorant les dossiers de build", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    for (const f of ["a.pdf", "b.docx", "c.pptx", "d.xlsx", "e.txt", "f.doc", "node_modules/g.pdf"]) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, "vide.pdf"), "");
    expect(listDocumentFiles(dir).map((p) => p.slice(dir.length + 1)).sort()).toEqual(["a.pdf", "b.docx", "c.pptx", "d.xlsx"]);
  });
});

describe("drapeau éteint : comportement d'avant", () => {
  it("les PDF sont ignorés et le retour garde sa forme exacte", async () => {
    const { svc } = await setup({}, false);
    const r = await svc.indexFolder(workspace());
    expect(r).toEqual({ files: 1, chunks: expect.any(Number), deduped: 0 });
    expect(svc.documentExtensions().size).toBe(0);
    await expect(svc.indexDocument(join(workspace(), "casse.pdf"), "casse.pdf")).rejects.toThrow(/RAG_FORMAT_UNSUPPORTED/);
  });
});

describe("lecture unique", () => {
  it("un document déjà lu (`parsed`) n'est pas relu par le parseur à l'ingestion", async () => {
    const boom: DocumentParser = {
      available: true,
      info: () => ({ name: "boom", version: "1" }),
      accepts: () => true,
      parse: async () => {
        throw new Error("ne doit pas être appelé");
      },
    };
    const { svc, db } = await setup({}, false, boom);
    const text = "Contenu extrait du document par un worker, assez long pour un passage.";
    const manifest = DocumentManifest.parse({ manifestVersion: 1, parser: { name: "pdfium", version: "1.0.0" }, source: { sha256: "a".repeat(64), bytes: 3, mime: "application/pdf" }, language: null, pages: 1, sections: [], tables: [], images: [], errors: [] });
    await svc.ingest(text, { docId: "d", source: "d.pdf", bytes: Buffer.from("abc"), parsed: { manifest, text } });
    expect(db.all<{ parser: string }>("SELECT parser FROM rag_documents")).toEqual([{ parser: "pdfium" }]);
  });
});

describe.skipIf(!HAVE)("indexFolder avec les vrais workers", () => {
  it("texte + PDF lus, PDF illisible REFUSÉ avec son code (l'indexation continue), relance idempotente", { timeout: 300_000 }, async () => {
    const { svc, db } = await setup({ doclingPython: PYTHON, doclingWorker: DOCLING, pdfiumWorker: PDFIUM }, true);
    try {
      const dir = workspace();
      const first = await svc.indexFolder(dir);
      expect(first.files).toBe(1);
      expect(first.documents).toBe(1);
      expect(first.refused).toEqual([{ file: "casse.pdf", code: "PARSER_UNAVAILABLE:WORKER_ERROR:PDF_UNREADABLE:PdfiumError" }]);
      expect(first.chunks).toBeGreaterThan(1);
      const rows = db.all<{ doc_id: string; parser: string }>("SELECT doc_id, parser FROM rag_documents ORDER BY doc_id");
      // M4 (audit v4) : le `docId` d'un document indexé par DOSSIER est son chemin ABSOLU normalisé (avant,
      // c'était le chemin relatif — deux dossiers contenant `notes.md` s'écrasaient mutuellement).
      expect(rows).toEqual([
        { doc_id: docIdOf(join(dir, "notes.md")), parser: "builtin" },
        { doc_id: docIdOf(join(dir, "sous", "rapport.pdf")), parser: "pdfium" },
      ]);
      const text = db
        .all<{ text: string }>("SELECT text FROM rag_chunks WHERE doc_id = ? ORDER BY ord", docIdOf(join(dir, "sous", "rapport.pdf")))
        .map((r) => r.text)
        .join(" ");
      expect(text).toContain("ventes progressent");
      expect(text).not.toContain("HORS PAGE");
      const again = await svc.indexFolder(dir);
      expect(again.chunks).toBe(0);
      expect(again.deduped).toBe(2); // notes.md + rapport.pdf : contenu inchangé
    } finally {
      await svc.close();
    }
  });
});
