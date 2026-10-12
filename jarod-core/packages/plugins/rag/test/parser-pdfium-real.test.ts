// Option b (DECISIONS 2026-09-30) : les PDF sont lus par le VRAI worker pdfium (venv `tools/docling-venv`, script versionné
// `sidecars/pdfium-worker/`), pas par Docling. Ignoré si le venv n'est pas installé. Aucun téléchargement, hors ligne.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltinParser, RagService, routeByExtension, WorkerParser, withFallback } from "../src/index.js";

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const DOCLING = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const PDFIUM = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
const HAVE = existsSync(PYTHON) && existsSync(PDFIUM) && existsSync(DOCLING);
// PDF synthétique de 3 pages : texte visible p.1, texte HORS de la page p.1, p.2 sans aucun texte, texte p.3.
const SAMPLE = readFileSync(join(HERE, "fixtures", "sample.pdf"));

const pdfium = () => new WorkerParser({ name: "pdfium", command: PYTHON, args: [PDFIUM], extensions: [".pdf"], allowPath: () => false, timeoutMs: 60_000, startTimeoutMs: 60_000 });

describe.skipIf(!HAVE)("worker pdfium réel", () => {
  it("protocole : aucune ligne spontanée, exactement une réponse par hello", { timeout: 60_000 }, async () => {
    const proc = spawn(PYTHON, [PDFIUM], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    try {
      await new Promise((r) => setTimeout(r, 1500));
      expect(out).toBe("");
      proc.stdin.write(`${JSON.stringify({ op: "hello" })}\n`);
      await new Promise((r) => setTimeout(r, 1500));
      expect(out.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(out)).toMatchObject({ ok: true, name: "pdfium", protocol: 1 });
    } finally {
      proc.kill();
    }
  });

  it("couche texte : le texte visible y est, le texte HORS page n'y est pas, pages exactes, page sans texte signalée", { timeout: 60_000 }, async () => {
    const p = pdfium();
    try {
      const r = await p.parse({ bytes: SAMPLE, name: "s.pdf" });
      expect(r.manifest.parser.name).toBe("pdfium");
      expect(r.manifest.pages).toBe(3);
      expect(r.text).toContain("ventes progressent de 12 pourcent");
      expect(r.text).toContain("Troisieme page");
      expect(r.text).not.toContain("HORS PAGE");
      expect(r.manifest.errors).toEqual([{ code: "PAGE_WITHOUT_TEXT", page: 2 }]);
      expect([r.manifest.sections, r.manifest.tables, r.manifest.images]).toEqual([[], [], []]);
      expect(r.manifest.source.mime).toBe("application/pdf");
      // Déterminisme : même fichier, même résultat.
      const again = await p.parse({ bytes: SAMPLE, name: "s.pdf" });
      expect(JSON.stringify(again)).toBe(JSON.stringify(r));
    } finally {
      await p.close();
    }
  });

  it("fichier tronqué ou sans octet : erreur de DOCUMENT, le worker reste utilisable", { timeout: 60_000 }, async () => {
    const p = pdfium();
    try {
      await expect(p.parse({ bytes: SAMPLE.subarray(0, 200), name: "t.pdf" })).rejects.toMatchObject({ code: expect.stringContaining("WORKER_ERROR") });
      await expect(p.parse({ bytes: Buffer.alloc(0), name: "v.pdf" })).rejects.toThrow();
      expect((await p.parse({ bytes: SAMPLE, name: "s.pdf" })).manifest.pages).toBe(3);
    } finally {
      await p.close();
    }
  });
});

async function service(rag: Record<string, unknown>) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0, ...rag });
  settings.set("ecosystem", { ...settings.get("ecosystem"), documentParser: "docling" });
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never } });
  svc.setEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])));
  return { svc, parsers: () => db.all<{ doc_id: string; parser: string }>("SELECT doc_id, parser FROM rag_documents ORDER BY doc_id") };
}

describe("routage : Office et HTML → Docling, PDF → pdfium", () => {
  it.skipIf(!HAVE)("via RagService : chaque format va à son worker", { timeout: 300_000 }, async () => {
    const { svc, parsers } = await service({ doclingPython: PYTHON, doclingWorker: DOCLING, pdfiumWorker: PDFIUM });
    try {
      await svc.ingest("<html><body><h1>Titre</h1><p>Un texte court.</p></body></html>", { docId: "h", source: "h.html" });
      // Un PDF s'ingère avec le TEXTE extrait et les octets d'origine (le manifeste se rapporte à ces octets).
      const extractor = pdfium();
      const { text } = await extractor.parse({ bytes: SAMPLE, name: "p.pdf" });
      await extractor.close();
      await svc.ingest(text, { docId: "p", source: "p.pdf", bytes: SAMPLE });
      expect(parsers()).toEqual([
        { doc_id: "h", parser: "docling" },
        { doc_id: "p", parser: "pdfium" },
      ]);
    } finally {
      await svc.close();
    }
  });

  it("pdfiumWorker absent ou relatif : pas de processus, le PDF n'a AUCUN texte (refus net), le reste continue", async () => {
    const { svc, parsers } = await service({ doclingPython: "python.exe", doclingWorker: "docling-worker.py", pdfiumWorker: "pdfium-worker.py" });
    await svc.ingest("# Titre\n\nUn texte assez long pour être indexé correctement.", { docId: "m", source: "m.md" });
    await svc.ingest("x", { docId: "p", source: "p.pdf", bytes: SAMPLE });
    expect(parsers().map((r) => r.parser)).toEqual(["builtin"]); // le PDF n'est pas décrit par le builtin, il n'est pas décodé en déchets
    await svc.close();
  });

  it("routeByExtension : le premier parseur qui accepte le fichier le lit ; aucun ne l'accepte ⇒ refus net", async () => {
    const mk = (name: string, ext: string) => ({
      available: true,
      info: () => ({ name, version: "1" }),
      accepts: (n: string) => n.endsWith(ext),
      parse: async () => ({ text: name, manifest: {} as never }),
    });
    const r = routeByExtension(mk("a", ".docx"), mk("b", ".pdf"));
    expect((await r.parse({ bytes: Buffer.from("x"), name: "f.pdf" })).text).toBe("b");
    expect((await r.parse({ bytes: Buffer.from("x"), name: "f.docx" })).text).toBe("a");
    await expect(r.parse({ bytes: Buffer.from("x"), name: "f.zip" })).rejects.toThrow(/NO_PARSER/);
    expect(withFallback(r, new BuiltinParser()).accepts("f.pdf")).toBe(true);
  });
});
