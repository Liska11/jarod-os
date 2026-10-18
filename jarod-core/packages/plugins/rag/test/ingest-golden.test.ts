// Non-régression de l'ingestion (PLAN §10 phase 2, lot A ; DECISIONS 2026-09-29 « lot A — critère et barres figés »).
// `fixtures/ingest-golden.json` a été généré par le code d'AVANT le lot A (commit 9bac647) : le lot A est un refactor
// pur, les lignes de `rag_chunks` (hors `id` et `at`) et les résultats de recherche doivent rester identiques.
// Régénérer l'instantané = changer la référence : jamais sans décision (`GOLDEN_WRITE=1`).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { docIdOf, RagService } from "../src/rag.js";

afterEach(cleanup);

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ingest-golden.json");

/** Embedder déterministe : 16 flottants tirés de l'empreinte du texte, normalisés. */
function embedText(text: string): Float32Array {
  const h = createHash("sha256").update(text).digest();
  const v = Float32Array.from({ length: 16 }, (_, i) => h[i]! / 255 - 0.5);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const embedder = async (texts: string[]) => texts.map(embedText);

const PROSE = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `Ligne ${i} de ${tag} : le renard brun saute par-dessus le chien paresseux, ${i * 7} fois.`).join("\n");

interface Stage {
  stage: string;
  result?: unknown;
  rows: unknown[];
}

async function scenario(cfg: { chunkSize: number; chunkOverlap: number }): Promise<{ stages: Stage[]; hits: Record<string, unknown[]> }> {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 4, maxChunksPerDoc: 2, ...cfg });
  const rag = app.rag.rag;
  rag.setEmbedder(embedder);
  // Balayage d'origine sur la même base : le même résultat SANS index en mémoire.
  const scan = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never } });
  scan.setEmbedder(embedder);

  const rows = () =>
    db
      .all<{ doc_id: string; ord: number; text: string; dim: number; embedding: Buffer; sha256: string; source: string | null; model: string | null }>(
        "SELECT doc_id, ord, text, dim, embedding, sha256, source, model FROM rag_chunks ORDER BY doc_id, ord",
      )
      .map((r) => ({ ...r, doc_id: stableId(r.doc_id), embedding: createHash("sha256").update(r.embedding).digest("hex") }));
  const stages: Stage[] = [];
  const step = async (stage: string, run: () => unknown | Promise<unknown>) => {
    let result: unknown;
    try {
      result = await run();
    } catch (e) {
      result = { error: (e as Error).message };
    }
    stages.push({ stage, result, rows: rows() });
  };

  const dir = tempDir();
  // M4 (audit v4) : les `docId` des fichiers indexés par DOSSIER sont désormais leur chemin ABSOLU — le
  // dossier de ce scénario est TEMPORAIRE, donc non reproductible d'une exécution à l'autre. On le remplace
  // par un jeton stable : l'instantané reste STRICT sur le découpage, les empreintes, les dimensions, le
  // texte, l'ordre et le `source`, et ne dépend plus que du schéma d'identifiant (ce qui est justement le
  // point de M4). Les documents nommés explicitement (« a », « b », « vide ») gardent leur identifiant tel quel.
  const root = `${docIdOf(dir)}/`;
  const stableId = (id: string): string => (id.startsWith(root) ? `<dir>/${id.slice(root.length)}` : id);

  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "x.md"), PROSE(12, "x"));
  writeFileSync(join(dir, "sub", "y.ts"), "export const y = 1;\n".repeat(40));
  writeFileSync(join(dir, "bin.md"), "texte\u0000binaire");
  writeFileSync(join(dir, "node_modules", "n.md"), PROSE(3, "n"));
  writeFileSync(join(dir, "note.bin"), "ignoré : extension");

  await step("ingest a", () => rag.ingest(PROSE(20, "a"), { docId: "a", source: "a.md" }));
  await step("ingest sans docId", () => rag.ingest(PROSE(6, "b"), { source: "b.md" }));
  await step("doublon de a", () => rag.ingest(PROSE(20, "a"), { docId: "a", source: "a.md" }));
  await step("a modifié", () => rag.ingest(PROSE(9, "a2"), { docId: "a", source: "a.md" }));
  await step("texte blanc", () => rag.ingest("  \n\t ", { docId: "vide" }));
  await step("dossier", () => rag.indexFolder(dir));
  await step("dossier relancé", () => rag.indexFolder(dir));

  const queries = ["le renard brun", "Ligne 4 de x", "export const", "chien paresseux fois", "a2"];
  const hits: Record<string, unknown[]> = {};
  const shape = (h: { docId: string; ord: number; source: string | null; score: number; text: string }) => ({
    docId: stableId(h.docId),
    ord: h.ord,
    source: h.source,
    score: Number(h.score.toPrecision(12)),
    text: h.text,
  });
  for (const q of queries) {
    const withIndex = (await rag.search(q)).map(shape);
    const bare = (await scan.search(q)).map(shape);
    expect(withIndex, `index et balayage : ${q}`).toEqual(bare);
    hits[q] = withIndex;
  }

  await step("forget b.md", () => ({ removed: rag.forget("b.md") }));
  await step("forget inconnu", () => ({ removed: rag.forget("nexiste-pas") }));
  await step("forget tout", () => ({ removed: rag.forget() }));
  return { stages, hits };
}

type Snapshot = Record<string, { stages: { rows: { doc_id: string; ord: number }[] }[] }>;

/**
 * La base trie les lignes sur le `doc_id` BRUT : celui d'un fichier indexé par dossier est un chemin absolu
 * (`C:/…` sous Windows, `/tmp/…` ailleurs), qui ne se range pas au même endroit que les identifiants nommés.
 * Les deux côtés sont donc rangés sur l'identifiant STABLE puis `ord` : même contenu exigé, ordre de la plateforme ignoré.
 */
function byStableOrder<T>(snapshot: T): T {
  for (const scenario of Object.values(snapshot as Snapshot)) {
    for (const stage of scenario.stages) {
      stage.rows.sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : a.ord - b.ord));
    }
  }
  return snapshot;
}

describe("ingestion : non-régression stricte face au code d'avant le lot A", () => {
  it("lignes de rag_chunks et résultats identiques à l'instantané (deux réglages de découpage)", async () => {
    const current = {
      overlap0: await scenario({ chunkSize: 200, chunkOverlap: 0 }),
      overlap40: await scenario({ chunkSize: 300, chunkOverlap: 60 }),
    };
    if (process.env.GOLDEN_WRITE === "1") {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(current, null, 1)}\n`);
      return;
    }
    const golden = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(byStableOrder(JSON.parse(JSON.stringify(current)))).toEqual(byStableOrder(golden));
  });
});
