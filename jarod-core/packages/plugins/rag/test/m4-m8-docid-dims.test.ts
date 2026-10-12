/**
 * M4/M8 (audit v4 § 1) — l'identifiant d'un document, et les dimensions mélangées.
 *
 * M4 : `docId` était le chemin RELATIF au dossier indexé. `projetA/README.md` et `projetB/README.md`
 * portaient donc le MÊME identifiant, et indexer le second SUPPRIMAIT le premier
 * (`DELETE FROM rag_chunks WHERE doc_id = ?` avant réécriture). L'identifiant est maintenant le chemin
 * ABSOLU normalisé ; le nom affiché (`source`) reste le chemin relatif.
 *
 * M8 : l'index vectoriel prenait la dimension de la PREMIÈRE ligne et tronquait ou complétait de ZÉROS
 * toutes les autres (`subarray(0, dim)` / `set` plus court) ; le balayage de secours ne comparait que la
 * première ligne. Des dimensions mélangées (modèle d'embeddings changé, réindexation interrompue) rendaient
 * donc des scores faux SANS RIEN DIRE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 4;
const vec = (x: number) => Float32Array.from([x, 0, 0, 1]);

/** Un RAG sur une base réelle, avec un embedder factice (aucun réseau). */
async function setup() {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0 });
  const rag = new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never } });
  rag.setEmbedder(async (texts) => texts.map(() => vec(1)));
  return { app, db, settings, rag };
}

const insertChunk = (
  db: Awaited<ReturnType<typeof setup>>["db"],
  doc: string,
  ord: number,
  dim: number,
  v: Float32Array,
) =>
  db.run(
    "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?,?,?,?,?,?,?,?,?)",
    doc,
    ord,
    `${doc}#${ord}`,
    dim,
    floatsToBlob(v),
    doc,
    "test",
    "m",
    1,
  );

describe("M4 — deux dossiers qui contiennent le même chemin relatif coexistent", () => {
  it("indexer projetB ne supprime plus projetA", async () => {
    const { rag, db } = await setup();
    const ws = tempDir();
    for (const d of ["projetA", "projetB"]) {
      mkdirSync(join(ws, d));
      writeFileSync(join(ws, d, "README.md"), `Contenu propre à ${d}, assez long pour faire un passage.`);
    }

    await rag.indexFolder(join(ws, "projetA"));
    await rag.indexFolder(join(ws, "projetB"));

    const rows = db.all<{ doc_id: string; text: string; source: string }>(
      "SELECT doc_id, text, source FROM rag_chunks ORDER BY doc_id",
    );
    expect(rows.some((r) => r.text.includes("projetA")), "projetA est toujours là").toBe(true);
    expect(rows.some((r) => r.text.includes("projetB")), "projetB est là").toBe(true);
    // L'identifiant est absolu, le nom affiché reste le chemin relatif.
    expect(rows.map((r) => r.source).sort()).toEqual(["README.md", "README.md"]);
    for (const r of rows) expect(r.doc_id).toBe(resolve(ws, r.doc_id.includes("projetA") ? "projetA/README.md" : "projetB/README.md").split("\\").join("/"));
  });

  it("un identifiant HÉRITÉ (chemin relatif) est remplacé, jamais laissé en double", async () => {
    const { rag, db } = await setup();
    const ws = tempDir();
    mkdirSync(join(ws, "dossier"));
    writeFileSync(join(ws, "dossier", "note.md"), "Texte de la note, assez long pour un passage net.");
    // L'état d'avant le correctif : un document enregistré sous son chemin RELATIF.
    insertChunk(db, "note.md", 0, DIM, vec(1));
    db.run(
      "INSERT INTO rag_documents (doc_id, source, parser, parser_version, source_sha256, content_sha256, manifest, text, state, at) VALUES (?,?,?,?,?,?,?,?,'indexed',?)",
      "note.md",
      "note.md",
      "builtin",
      "1",
      "x",
      "y",
      "{}",
      "ancien",
      1,
    );

    await rag.indexFolder(join(ws, "dossier"));

    const ids = db.all<{ doc_id: string }>("SELECT doc_id FROM rag_chunks").map((r) => r.doc_id);
    expect(ids).not.toContain("note.md");
    expect(ids).toEqual([resolve(ws, "dossier", "note.md").split("\\").join("/")]);
    expect(db.all("SELECT doc_id FROM rag_documents")).toHaveLength(1);
  });
});

describe("M8 — des dimensions mélangées se disent, elles ne se tronquent pas", () => {
  it("l'index en mémoire REFUSE un index en dimensions mélangées", async () => {
    const { app, db } = await setup();
    insertChunk(db, "a", 0, DIM, vec(1));
    insertChunk(db, "b", 0, 8, Float32Array.from([1, 0, 0, 1, 0, 0, 0, 0]));
    app.rag.rag.setEmbedder(async (texts) => texts.map(() => vec(1)));
    await expect(app.rag.rag.search("question")).rejects.toThrow(/RAG_DIM_MISMATCH/);
  });

  it("le balayage de secours (sans index) refuse aussi", async () => {
    const { db, settings, rag } = await setup();
    insertChunk(db, "a", 0, DIM, vec(1));
    insertChunk(db, "b", 0, 8, Float32Array.from([1, 0, 0, 1, 0, 0, 0, 0]));
    void settings;
    await expect(rag.search("question")).rejects.toThrow(/RAG_DIM_MISMATCH/);
  });

  it("une dimension HOMOGÈNE cherche normalement (aucune régression)", async () => {
    const { app, db } = await setup();
    insertChunk(db, "a", 0, DIM, vec(1));
    app.rag.rag.setEmbedder(async (texts) => texts.map(() => vec(1)));
    const hits = await app.rag.rag.search("question");
    expect(hits.map((h) => h.docId)).toEqual(["a"]);
  });
});