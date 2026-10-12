// SPECS-P5-HYBRID.md §2.2 : fusion RRF (k = 60, profondeur 50) du classement dense et du classement lexical FTS5 dans RagService.search.
// Drapeau éteint = la pile d'avant, octet pour octet ; seul l'ORDRE vient de la fusion, le score reste le cosinus ; plafond par document APRÈS
// la fusion ; une erreur ou une requête sans terme laisse l'ordre dense. Vraie base, vecteurs fabriqués, aucun modèle.
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 16;
/** Vecteur dont le cosinus avec `unit(0)` décroît avec `k` : l'ordre du dense est celui de `k` croissant. */
const vec = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? k * 0.1 : 0));
const QUERY = vec(0);

interface Doc {
  doc: string;
  k: number;
  text: string;
}
/** 60 documents génériques (le dense les classe par k) ; `extra` ajoute des passages. */
async function setup(extra: Doc[] = [], opts: { perDoc?: number; flag?: "on" | "off"; log?: string[] } = {}) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 5, maxChunksPerDoc: opts.perDoc ?? 2 });
  settings.set("ecosystem", { ...settings.get("ecosystem"), hybrid: opts.flag ?? "on" });
  const docs: Doc[] = [...Array.from({ length: 60 }, (_, i) => ({ doc: `gen${i}`, k: i, text: `passage générique numéro ${i} sur des sujets variés` })), ...extra];
  const ords = new Map<string, number>();
  for (const d of docs) {
    const ord = ords.get(d.doc) ?? 0;
    ords.set(d.doc, ord + 1);
    db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", d.doc, ord, d.text, DIM, floatsToBlob(vec(d.k)), "h", d.doc, "test", 1);
  }
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never }, log: (l) => opts.log?.push(l) });
  svc.setEmbedder(async () => [QUERY]);
  return { svc, db, settings, setFlag: (f: "on" | "off") => settings.set("ecosystem", { ...settings.get("ecosystem"), hybrid: f }) };
}
const ids = (h: { docId: string; ord: number }[]) => h.map((x) => `${x.docId}#${x.ord}`);

describe("recherche hybride", () => {
  it("drapeau éteint (défaut) : résultats identiques à ceux d'avant, FTS5 jamais interrogée", async () => {
    const off = await setup([{ doc: "rare", k: 55, text: "le terme exclusif autentification apparaît ici" }], { flag: "off" });
    const hits = await off.svc.search("autentification", 5);
    expect(ids(hits)).toEqual(["gen0#0", "gen1#0", "gen2#0", "gen3#0", "gen4#0"]);
  });

  it("allumé : un passage au terme exclusif, dans les 50 premiers du dense (rang 31), remonte en tête ; le score reste son cosinus", async () => {
    const { svc } = await setup([{ doc: "rare", k: 30.5, text: "le terme exclusif autentification apparaît ici" }]);
    const hits = await svc.search("autentification", 5);
    expect(hits[0]!.docId).toBe("rare");
    const cos = (k: number) => 1 / Math.sqrt(1 + (k * 0.1) ** 2);
    expect(hits[0]!.score).toBeCloseTo(cos(30.5), 5);
    expect(hits[1]!.score).toBeGreaterThan(hits[0]!.score); // les suivants (dense) ont un meilleur cosinus : l'ordre vient de la fusion, pas du score
  });

  // ÉGALITÉ (SPECS-P5-HYBRID.md §2 et §3.1, règle V1 refigée le 2026-10-02) : à score RRF égal, le meilleur rang LEXICAL d'abord. Un passage
  // absent des 50 premiers du dense, 1er au lexical, ÉGALE le 1er du dense (1/61 chacun) et passe donc DEVANT lui (la première règle, « meilleur
  // rang dense d'abord », le laissait 2e et a manqué la barre (a)).
  it("candidat seulement lexical (hors des 50 premiers du dense, rang 56) : à égalité avec le 1er du dense, il passe 1er ; son score reste son cosinus", async () => {
    const { svc } = await setup([{ doc: "rare", k: 55, text: "le terme exclusif autentification apparaît ici" }]);
    const hits = await svc.search("autentification", 5);
    expect(hits.map((h) => h.docId).slice(0, 3)).toEqual(["rare", "gen0", "gen1"]);
    const cos = (k: number) => 1 / Math.sqrt(1 + (k * 0.1) ** 2);
    expect(hits[0]!.score).toBeCloseTo(cos(55), 5);
    expect(hits[1]!.score).toBeCloseTo(cos(0), 5);
  });

  it("égalités entre candidats SEULEMENT denses (aucun lexical) : l'ordre dense est conservé", async () => {
    const { svc } = await setup([{ doc: "rare", k: 55, text: "le terme exclusif autentification apparaît ici" }]);
    const hits = await svc.search("autentification", 8);
    expect(hits.map((h) => h.docId).slice(1, 6)).toEqual(["gen0", "gen1", "gen2", "gen3", "gen4"]);
  });

  it("allumé : requête sans terme exclusif (aucun passage ne la contient) = ordre dense inchangé", async () => {
    const on = await setup([{ doc: "rare", k: 55, text: "le terme exclusif autentification apparaît ici" }]);
    const hybrid = await on.svc.search("zzzinexistant", 5);
    on.setFlag("off");
    expect(ids(hybrid)).toEqual(ids(await on.svc.search("zzzinexistant", 5)));
  });

  it("fusion RRF exacte : un passage 1er au lexical et 4e au dense bat un 1er au dense absent du lexical", async () => {
    // gen0 (dense rang 1) ne contient pas le mot ; « cible » est au dense rang 4 (k = 2.5) et seul au lexical (rang 1).
    const { svc } = await setup([{ doc: "cible", k: 2.5, text: "mot unique ultraspecifique ici" }]);
    const hits = await svc.search("ultraspecifique", 3);
    expect(hits[0]!.docId).toBe("cible");
    expect(hits[1]!.docId).toBe("gen0");
  });

  it("le plafond par document s'applique APRÈS la fusion (un document au mot rare ne prend pas tous les créneaux)", async () => {
    const extra: Doc[] = [0, 1, 2, 3].map((i) => ({ doc: "long", k: 40 + i, text: `fragment ${i} contenant le jeton lexicalrare` }));
    const { svc } = await setup(extra, { perDoc: 2 });
    const hits = await svc.search("lexicalrare", 5);
    expect(hits.filter((h) => h.docId === "long")).toHaveLength(2);
    expect(hits[0]!.docId).toBe("long");
  });

  it("deterministe : deux appels, même ordre ; ordre des égalités stable", async () => {
    const { svc } = await setup([{ doc: "rare", k: 55, text: "terme exclusif autentification" }]);
    expect(ids(await svc.search("autentification", 8))).toEqual(ids(await svc.search("autentification", 8)));
  });

  it("requête sans terme exploitable (ponctuation seule) : ordre dense, pas d'erreur", async () => {
    const on = await setup();
    const hybrid = await on.svc.search("?!…", 5);
    on.setFlag("off");
    expect(ids(hybrid)).toEqual(ids(await on.svc.search("?!…", 5)));
  });

  it("table FTS5 absente ou illisible : ordre dense, ligne de journal, jamais d'erreur pour l'utilisateur", async () => {
    const logs: string[] = [];
    const { svc, db } = await setup([{ doc: "rare", k: 55, text: "terme exclusif autentification" }], { log: logs });
    db.run("DROP TABLE rag_chunks_fts");
    const hits = await svc.search("autentification", 5);
    expect(ids(hits)).toEqual(["gen0#0", "gen1#0", "gen2#0", "gen3#0", "gen4#0"]);
    expect(logs.join(" | ")).toMatch(/hybride|FTS/i);
  });

  it("recherche en mode hybride : le texte de la requête ne sort jamais dans le journal", async () => {
    const logs: string[] = [];
    const { svc, db } = await setup([], { log: logs });
    db.run("DROP TABLE rag_chunks_fts");
    await svc.search("question très confidentielle", 3);
    expect(logs.join("\n")).not.toContain("confidentielle");
  });
});
