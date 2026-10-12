import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { applyIngestion, ingestionPaths } from "../src/wire-ingestion.js";

describe("activation de l'ingestion de documents", () => {
  it("les trois chemins sont absolus et pointent le venv Docling et les deux workers du dépôt", () => {
    const p = ingestionPaths();
    for (const v of Object.values(p)) expect(isAbsolute(v)).toBe(true);
    const norm = (s: string) => s.split(String.fromCharCode(92)).join("/");
    expect(norm(p.doclingPython).endsWith("/tools/docling-venv/Scripts/python.exe")).toBe(true);
    expect(norm(p.doclingWorker).endsWith("/sidecars/docling-worker/docling-worker.py")).toBe(true);
    expect(norm(p.pdfiumWorker).endsWith("/sidecars/pdfium-worker/pdfium-worker.py")).toBe(true);
  });

  it("ne change que les trois chemins et documentParser ; rag.enabled et le reste sont rendus tels quels ; idempotente", () => {
    const paths = { doclingPython: "P", doclingWorker: "D", pdfiumWorker: "F" };
    const rag = { enabled: false, topK: 5, doclingPython: "", doclingWorker: "", pdfiumWorker: "" };
    const eco = { vectorIndex: "memory", documentParser: "builtin", reranker: "off" };
    const once = applyIngestion(rag, eco, paths);
    expect(once.rag).toEqual({ enabled: false, topK: 5, ...paths });
    expect(once.ecosystem).toEqual({ vectorIndex: "memory", documentParser: "docling", reranker: "off" });
    expect(applyIngestion(once.rag, once.ecosystem, paths)).toEqual(once);
    expect(rag.doclingPython).toBe("");
  });
});
