// Portage de packages/core/test/rag.test.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestCore as JarodCore } from "./helpers.js";
import { MIGRATIONS } from "@jarod/plugin-storage";
import {
  blobToFloats,
  chunkText,
  cosine,
  type Embedder,
  floatsToBlob,
  listTextFiles,
  readEmbeddings,
} from "@jarod/plugin-rag";
import type { Settings } from "@jarod/plugin-storage";
import { makeCore, tempDir, testKeys } from "./helpers.js";
import { describeRefused } from "../src/rag-tools.js";

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/**
 * Deterministic 8-dimension vectors: a word present in the text lights its axis. Every component
 * carries a small floor so no vector is ever zero — a zero vector scores 0, which would hide the
 * difference between "unrelated" and "broken".
 */
function vector(text: string): Float32Array {
  const v = new Float32Array(WORDS.length);
  const lower = text.toLowerCase();
  for (let i = 0; i < WORDS.length; i++) v[i] = (lower.includes(WORDS[i]!) ? 1 : 0) + 0.01;
  return v;
}

const embedder: Embedder = async (texts) => texts.map(vector);

/** Lines of ~117 characters, each carrying `word`, so chunks land on line breaks predictably. */
function body(lines: number, word: string): string {
  const line = `${word} ${"lorem ipsum dolor sit amet ".repeat(4)}`.trim();
  return `${Array.from({ length: lines }, () => line).join("\n")}\n`;
}

const RAG_ON: Settings["rag"] = {
  enabled: true,
  embeddingsUrl: "",
  embeddingsModel: "",
  chunkSize: 800,
  chunkOverlap: 100,
  maxChunksPerDoc: 2,
  topK: 5,
  doclingPython: "",
  doclingWorker: "",
  pdfiumWorker: "",
};

async function setup(over: Partial<Settings["rag"]> = {}) {
  const core = await makeCore();
  const ws = tempDir();
  core.settings.set("workspace", ws);
  core.settings.set("rag", { ...RAG_ON, ...over });
  core.rag.setEmbedder(embedder);
  const tool = (name: string, args: Record<string, unknown>) =>
    core.tools.get(name)!.run(args, { sessionId: "s", workspace: ws });
  return { core, ws, tool };
}

describe("RAG — chunking and similarity", () => {
  it("cuts at line breaks with an exact overlap, and covers the whole text", () => {
    const text = body(20, "alpha");
    const chunks = chunkText(text, 800, 100);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
    for (let i = 0; i + 1 < chunks.length; i++) {
      expect(chunks[i]!.slice(-100)).toBe(chunks[i + 1]!.slice(0, 100));
    }
    expect(text.startsWith(chunks[0]!)).toBe(true);
    expect(text.endsWith(chunks.at(-1)!)).toBe(true);
    // No gap and no duplication beyond the declared overlap.
    const covered = chunks.reduce((n, c, i) => n + c.length - (i ? 100 : 0), 0);
    expect(covered).toBe(text.length);
  });

  it("hard-cuts a single long line rather than looping on it", () => {
    const text = "x".repeat(2000);
    const chunks = chunkText(text, 800, 100);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
    const covered = chunks.reduce((n, c, i) => n + c.length - (i ? 100 : 0), 0);
    expect(covered).toBe(text.length);
  });

  it("returns a short text as one chunk, and nothing for blank input", () => {
    expect(chunkText("court", 800, 100)).toEqual(["court"]);
    expect(chunkText("   \n\t ", 800, 100)).toEqual([]);
    expect(chunkText("", 800, 100)).toEqual([]);
  });

  it("scores similarity without ever producing NaN", () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1, 6);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    // A zero vector has no direction: 0 is the honest answer, NaN the bug.
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
    expect(Number.isNaN(cosine(new Float32Array(0), Float32Array.from([1])))).toBe(false);
  });

  it("round-trips floats, including through an unaligned buffer view", () => {
    const values = [1.5, -2.25, 4, 0.5];
    const blob = floatsToBlob(Float32Array.from(values));
    expect(blob.byteLength).toBe(16);
    expect(Array.from(blobToFloats(blob))).toEqual(values);

    // The driver can hand back a view into a pooled buffer: reading it directly as a Float32Array
    // would decode four bytes-shifted garbage instead of the stored numbers.
    const unaligned = Buffer.concat([Buffer.from([0]), blob]).subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);
    expect(Array.from(blobToFloats(unaligned))).toEqual(values);

    expect(() => blobToFloats(Buffer.from([1, 2, 3]))).toThrow("RAG_BAD_BLOB");
  });

  it("reads both embeddings response shapes and ignores noise", () => {
    expect(readEmbeddings({ data: [{ embedding: [1, 2] }] })).toEqual([Float32Array.from([1, 2])]);
    expect(
      readEmbeddings({
        embeddings: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toHaveLength(2);
    expect(readEmbeddings({ data: [{ embedding: [] }] })).toEqual([]);
    expect(readEmbeddings({ data: [{ embedding: "x" }] })).toEqual([]);
    expect(readEmbeddings(null)).toEqual([]);
    expect(readEmbeddings({ nope: true })).toEqual([]);
  });

  it("lists text files only, skipping heavy folders, big files and empty ones", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "a.md"), "alpha");
    writeFileSync(join(dir, "b.ts"), "beta");
    writeFileSync(join(dir, "sub", "c.json"), "{}");
    writeFileSync(join(dir, "node_modules", "x.md"), "skipped");
    writeFileSync(join(dir, ".git", "y.md"), "skipped");
    writeFileSync(join(dir, "image.png"), "not text");
    writeFileSync(join(dir, "empty.md"), "");
    writeFileSync(join(dir, "big.md"), "z".repeat(300 * 1024));
    const rel = listTextFiles(dir)
      .map((p) => relative(dir, p).split("\\").join("/"))
      .sort();
    expect(rel).toEqual(["a.md", "b.ts", "sub/c.json"]);
  });
});

describe("RAG — local index", () => {
  it("stays off until asked, and says so instead of indexing in silence", async () => {
    const { core } = await setup({ enabled: false });
    expect(core.rag.status()).toMatchObject({ enabled: false, chunks: 0, docs: 0, dim: null });
    await expect(core.rag.ingest("alpha")).rejects.toThrow("RAG local désactivé");
    await expect(core.rag.search("alpha")).rejects.toThrow("RAG local désactivé");
    expect(core.rag.forget()).toBe(0);
  });

  it("stores chunks in the app database and finds the nearest one first", async () => {
    const { core } = await setup({ chunkSize: 200 });
    const r = await core.rag.ingest(body(4, "alpha"), { docId: "a", source: "a.md" });
    expect(r).toEqual({ docId: "a", chunks: expect.any(Number), deduped: false });
    expect(r.chunks).toBeGreaterThan(1);
    expect(core.rag.status()).toMatchObject({ enabled: true, docs: 1, dim: WORDS.length });

    await core.rag.ingest(body(4, "beta"), { docId: "b", source: "b.md" });
    const hits = await core.rag.search("alpha", 5);
    expect(hits[0]!.docId).toBe("a");
    expect(hits[0]!.score).toBeGreaterThan(0.9);
    expect(hits.every((h) => h.source !== null)).toBe(true);
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((x, y) => y - x));
  });

  it("never writes a second index file next to the database", async () => {
    const dir = tempDir();
    const core = await makeCore({ dataDir: dir, keyStores: [testKeys] });
    core.settings.set("rag", RAG_ON);
    core.rag.setEmbedder(embedder);
    const before = readdirSync(dir).sort();
    await core.rag.ingest(body(4, "alpha"), { docId: "a" });
    expect(readdirSync(dir).sort()).toEqual(before);
    await core.dispose();
  });

  it("treats unchanged content as already indexed", async () => {
    const { core } = await setup({ chunkSize: 200 });
    const text = body(4, "alpha");
    await core.rag.ingest(text, { docId: "a" });
    const stored = core.rag.status().chunks;
    expect(await core.rag.ingest(text, { docId: "a" })).toEqual({ docId: "a", chunks: 0, deduped: true });
    expect(core.rag.status().chunks).toBe(stored);
  });

  it("replaces the previous version of an edited document", async () => {
    const { core } = await setup({ chunkSize: 200 });
    await core.rag.ingest(body(4, "alpha"), { docId: "note", source: "note.md" });
    const before = core.rag.status().chunks;
    const r = await core.rag.ingest(body(4, "beta"), { docId: "note", source: "note.md" });
    expect(r.deduped).toBe(false);
    // The old version is gone, not kept alongside: no stale text can be answered from.
    expect(core.rag.status().chunks).toBe(r.chunks);
    expect(core.rag.status().docs).toBe(1);
    expect(before).toBeGreaterThan(0);
    const hits = await core.rag.search("beta", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.includes("beta"))).toBe(true);
  });

  it("caps passages per document so one long file cannot take every slot", async () => {
    const { core } = await setup({ chunkSize: 200, maxChunksPerDoc: 2, topK: 5 });
    await core.rag.ingest(body(30, "alpha"), { docId: "long", source: "long.md" });
    await core.rag.ingest(body(1, "alpha"), { docId: "short", source: "short.md" });
    const hits = await core.rag.search("alpha", 5);
    expect(hits.filter((h) => h.docId === "long")).toHaveLength(2);
    expect(hits.some((h) => h.docId === "short")).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it("refuses to compare a query with an index built by another model", async () => {
    const { core } = await setup({ chunkSize: 200 });
    await core.rag.ingest(body(2, "alpha"), { docId: "a" });
    core.rag.setEmbedder(async (texts) => texts.map(() => new Float32Array(4)));
    await expect(core.rag.search("alpha")).rejects.toThrow("RAG_DIM_MISMATCH");
  });

  it("forgets one document, or everything", async () => {
    const { core } = await setup({ chunkSize: 200 });
    await core.rag.ingest(body(2, "alpha"), { docId: "a" });
    await core.rag.ingest(body(2, "beta"), { docId: "b" });
    expect(core.rag.forget("a")).toBeGreaterThan(0);
    expect(core.rag.status().docs).toBe(1);
    expect(core.rag.forget()).toBeGreaterThan(0);
    expect(core.rag.status()).toMatchObject({ chunks: 0, docs: 0, dim: null });
  });

  it("repairs a database whose index allowed only one chunk per document", async () => {
    const dir = tempDir();
    const earlier = await makeCore({ dataDir: dir, keyStores: [testKeys] });
    // Recreate what the previous build left behind, and mark the repair migration as not yet run.
    // Which version that is is *derived*: the repair migration is found by the one thing only it
    // does (dropping the old index), so adding another migration after it no longer breaks this test
    // the way "the last one, minus one" did — and a marker shared with the creation no longer can.
    const repair = MIGRATIONS.findIndex((sql) => sql.includes("DROP INDEX IF EXISTS rag_chunks_doc"));
    expect(repair).toBeGreaterThan(0);
    earlier.db.run("DROP INDEX rag_chunks_doc");
    earlier.db.run("CREATE UNIQUE INDEX rag_chunks_doc ON rag_chunks(doc_id, sha256)");
    // user_version counts the migrations already applied: the ones before the repair, and not it.
    earlier.db.run(`PRAGMA user_version = ${repair}`);
    await earlier.dispose();

    const core = await makeCore({ dataDir: dir, keyStores: [testKeys] });
    core.settings.set("rag", { ...RAG_ON, chunkSize: 200 });
    core.rag.setEmbedder(embedder);
    const r = await core.rag.ingest(body(4, "alpha"), { docId: "a" });
    expect(r.chunks).toBeGreaterThan(1);
    expect(core.rag.status()).toMatchObject({ chunks: r.chunks, docs: 1 });
    await core.dispose();
  });

  it("bounds hand-edited settings before they reach the index", async () => {
    // Settings are free-form JSON: a chunk size of 0 would mean one character per chunk, a cap of
    // ten thousand would mean "no cap". The service floors and ceilings them on the way in.
    const { core } = await setup({ chunkSize: 0, chunkOverlap: -5, maxChunksPerDoc: 9999, topK: 100_000 });
    // A chunk size of 0 falls back to the default: without that, the 470-character text below would
    // come out as one chunk per character.
    const r = await core.rag.ingest(body(4, "alpha"), { docId: "a" });
    expect(r.chunks).toBe(1);
    // A cap of ten thousand means "no cap", which is what the cap exists to prevent.
    expect(core.rag.status().capPerDoc).toBe(20);
    await core.rag.ingest(body(60, "alpha"), { docId: "long" });
    const hits = await core.rag.search("alpha");
    expect(hits.filter((h) => h.docId === "long").length).toBeLessThanOrEqual(20);
    expect(hits.length).toBeLessThanOrEqual(50);
  });

  it("keeps the overlap below the chunk size, so chunking always advances", async () => {
    // An overlap equal to the size makes each chunk advance one character: a 7 KB file would come
    // out as thousands of chunks.
    const { core } = await setup({ chunkSize: 400, chunkOverlap: 5000 });
    const r = await core.rag.ingest(body(60, "alpha"), { docId: "a" });
    expect(r.chunks).toBeGreaterThan(5);
    expect(r.chunks).toBeLessThan(60);
  });

  it("follows a local provider and refuses a cloud one", async () => {
    const { core } = await setup({ embeddingsUrl: "" });
    // The default provider is a cloud one: a feature meant to keep documents here must not ship them.
    expect(() => core.rag.endpoint()).toThrow("n'est pas local");
    expect(core.rag.status().endpoint).toBeNull();

    core.settings.set("activeProvider", "llamacpp");
    expect(core.rag.endpoint()).toEqual({ url: "http://localhost:8080/v1", model: null });

    core.settings.set("rag", { ...RAG_ON, embeddingsUrl: "http://127.0.0.1:9999/", embeddingsModel: "e5-large" });
    expect(core.rag.endpoint()).toEqual({ url: "http://127.0.0.1:9999", model: "e5-large" });
    expect(core.rag.status().endpoint).toBe("http://127.0.0.1:9999/embeddings");
  });

  it("indexes a folder and reports what it did, without redoing it", async () => {
    const { core, ws } = await setup({ chunkSize: 200 });
    mkdirSync(join(ws, "sub"), { recursive: true });
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    writeFileSync(join(ws, "a.md"), body(2, "alpha"));
    writeFileSync(join(ws, "sub", "b.ts"), body(2, "beta"));
    writeFileSync(join(ws, "node_modules", "c.md"), "alpha");
    const first = await core.rag.indexFolder(ws);
    expect(first.files).toBe(2);
    expect(first.deduped).toBe(0);
    expect(first.chunks).toBeGreaterThan(1);
    expect(core.rag.status().docs).toBe(2);

    expect(await core.rag.indexFolder(ws)).toEqual({ files: 2, chunks: 0, deduped: 2 });
  });
});

describe("RAG — résumé des fichiers refusés", () => {
  it("aucun refus : rien à dire", () => {
    expect(describeRefused([])).toBe("");
  });

  it("jusqu'à cinq noms avec leur code, au-delà « … et N autre(s) »", () => {
    const f = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `d/f${i + 1}.pdf`, code: i % 2 ? "PARSER_UNAVAILABLE:WORKER_ERROR:PDF_UNREADABLE:PdfiumError" : "RAG_TOO_LARGE" }));
    expect(describeRefused(f(1))).toBe(", 1 refusé(s) : d/f1.pdf (RAG_TOO_LARGE)");
    expect(describeRefused(f(5))).toBe(", 5 refusé(s) : d/f1.pdf (RAG_TOO_LARGE), d/f2.pdf (PARSER_UNAVAILABLE:WORKER_ERROR:PDF_UNREADABLE:PdfiumError), d/f3.pdf (RAG_TOO_LARGE), d/f4.pdf (PARSER_UNAVAILABLE:WORKER_ERROR:PDF_UNREADABLE:PdfiumError), d/f5.pdf (RAG_TOO_LARGE)");
    const six = describeRefused(f(6));
    expect(six).toContain("6 refusé(s) :");
    expect(six).not.toContain("f6.pdf");
    expect(six.endsWith(" … et 1 autre(s)")).toBe(true);
    expect(describeRefused(f(12)).endsWith(" … et 7 autre(s)")).toBe(true);
  });
});

describe("RAG — tools", () => {
  it("indexes a file and searches what it indexed", async () => {
    const { ws, tool } = await setup({ chunkSize: 200 });
    expect(await tool("rag_search", { query: "alpha" })).toContain("Aucun passage trouvé");

    writeFileSync(join(ws, "note.md"), body(2, "alpha"));
    expect(await tool("rag_index", { path: "note.md" })).toContain("Indexé : note.md");
    const out = await tool("rag_search", { query: "alpha", k: 3 });
    expect(out).toContain("note.md —");
    expect(out).toMatch(/^\[\d\.\d{3}\] note\.md — /);
    expect(await tool("rag_index", { path: "note.md" })).toBe("Déjà indexé, contenu inchangé : note.md.");
  });

  it("fail-closed : un document de plus de 1 Mio de caractères est REFUSÉ, jamais tronqué ni indexé en partie (DECISIONS 2026-10-01)", async () => {
    const { core, ws, tool } = await setup({ chunkSize: 200 });
    const MAX = 1 << 20; // 1 048 576 caractères
    writeFileSync(join(ws, "gros.md"), "a".repeat(MAX + 1));
    // Message EXACT montré à l'utilisateur (rag_index sur un fichier) :
    expect(await tool("rag_index", { path: "gros.md" })).toBe(`Indexation impossible : RAG_TOO_LARGE: ${MAX + 1} caractères, maximum ${MAX}.`);
    // Rien n'a été écrit : ni passage, ni document, ni empan.
    expect(core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_chunks")!.n).toBe(0);
    expect(core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_documents")!.n).toBe(0);
    expect(core.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rag_chunk_spans")!.n).toBe(0);
    // La borne est incluse : exactement 1 Mio passe.
    writeFileSync(join(ws, "limite.md"), "b".repeat(MAX));
    expect(await tool("rag_index", { path: "limite.md" })).toContain("Indexé : limite.md");
  });

  it("records the manifest of an indexed file, hashed from the file itself (even with an invalid byte)", async () => {
    const { core, ws, tool } = await setup({ chunkSize: 200 });
    const raw = Buffer.concat([Buffer.from("# Titre\n"), Buffer.from([0xff]), Buffer.from(" alpha\n")]);
    writeFileSync(join(ws, "brut.md"), raw);
    expect(await tool("rag_index", { path: "brut.md" })).toContain("Indexé : brut.md");
    const doc = core.db.get<{ parser: string; source_sha256: string; text: string }>(
      "SELECT parser, source_sha256, text FROM rag_documents WHERE doc_id = ?",
      "brut.md",
    );
    expect(doc?.parser).toBe("builtin");
    expect(doc?.source_sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(doc?.text).toBe(raw.toString("utf8"));
  });

  it("indexes a folder when given one", async () => {
    const { ws, tool } = await setup({ chunkSize: 200 });
    writeFileSync(join(ws, "a.md"), body(2, "alpha"));
    expect(await tool("rag_index", { path: "." })).toContain("Dossier indexé : 1 fichier(s)");
  });

  it("cannot index a path outside the workspace", async () => {
    const { tool } = await setup({ chunkSize: 200 });
    expect(await tool("rag_index", { path: "../secret.md" })).toContain("Indexation impossible");
  });

  it("says why it cannot work when the index is switched off", async () => {
    const { tool } = await setup({ enabled: false });
    expect(await tool("rag_index", { path: "." })).toContain("RAG local désactivé");
    await expect(tool("rag_search", { query: "alpha" })).rejects.toThrow("RAG local désactivé");
  });
});

describe("RAG — embeddings over HTTP", () => {
  type Seen = { url: string; body: { input: string[]; model?: string } };

  /** A real local HTTP server: the injected embedder of the other tests bypasses this path. */
  async function serve(handler: (res: ServerResponse, seen: Seen) => void) {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const entry = { url: req.url ?? "", body: JSON.parse(raw || "{}") as Seen["body"] };
        seen.push(entry);
        handler(res, entry);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      seen,
      url: `http://127.0.0.1:${port}/v1`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const echo = (res: ServerResponse, seen: Seen, dims: number[]) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: seen.body.input.map(() => ({ embedding: dims })) }));
  };

  it("posts the passages and reads the vectors back", async () => {
    const srv = await serve((res, seen) => echo(res, seen, [1, 0.5, 0.25]));
    try {
      const { core } = await setup({ embeddingsUrl: srv.url, embeddingsModel: "bge-m3", chunkSize: 400, chunkOverlap: 0 });
      core.rag.setEmbedder(null); // the real path: fetch to a local server
      const r = await core.rag.ingest(body(30, "alpha"), { docId: "a" });

      expect(r.deduped).toBe(false);
      expect(srv.seen).toHaveLength(1);
      expect(srv.seen[0]!.url).toBe("/v1/embeddings");
      expect(srv.seen[0]!.body.model).toBe("bge-m3");
      expect(srv.seen[0]!.body.input).toHaveLength(r.chunks);
      expect(core.rag.status().dim).toBe(3);

      const hits = await core.rag.search("alpha", 2);
      expect(hits).toHaveLength(2);
      expect(srv.seen[1]!.body.input).toEqual(["alpha"]);
    } finally {
      await srv.close();
    }
  });

  it("splits into batches instead of one huge request", async () => {
    const srv = await serve((res, seen) => echo(res, seen, [1, 0]));
    try {
      const { core } = await setup({ embeddingsUrl: srv.url, chunkSize: 400, chunkOverlap: 0 });
      core.rag.setEmbedder(null);
      const r = await core.rag.ingest(body(120, "alpha"), { docId: "a" });

      expect(r.chunks).toBeGreaterThan(16);
      expect(srv.seen.length).toBeGreaterThan(1);
      for (const s of srv.seen) expect(s.body.input.length).toBeLessThanOrEqual(16);
      expect(srv.seen.reduce((n, s) => n + s.body.input.length, 0)).toBe(r.chunks);
    } finally {
      await srv.close();
    }
  });

  it("names the address that failed when the server refuses", async () => {
    const srv = await serve(async (res) => {
      res.statusCode = 503;
      res.end("modèle non chargé");
    });
    try {
      const { core } = await setup({ embeddingsUrl: srv.url, chunkSize: 400, chunkOverlap: 0 });
      core.rag.setEmbedder(null);
      await expect(core.rag.ingest(body(2, "alpha"), { docId: "a" })).rejects.toThrow(/RAG_EMBED_HTTP_503/);
      await expect(core.rag.ingest(body(3, "alpha"), { docId: "b" })).rejects.toThrow(/modèle non chargé/);
    } finally {
      await srv.close();
    }
  });

  it("refuses a response that does not answer every passage", async () => {
    const srv = await serve(async (res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
    try {
      const { core } = await setup({ embeddingsUrl: srv.url, chunkSize: 400, chunkOverlap: 0 });
      core.rag.setEmbedder(null);
      await expect(core.rag.ingest(body(40, "alpha"), { docId: "a" })).rejects.toThrow(/RAG_EMBED_BAD_RESPONSE/);
    } finally {
      await srv.close();
    }
  });
});
