// "Test 3" du RAG sur le profil RÉEL (application fermée, LECTURE SEULE : rien n'est indexé ni écrit) : pour deux documents, un terme EXCLUSIF
// à chacun ; chaque requête doit ramener son document en tête.
//   ../../node_modules/.bin/tsx src/diag-search.ts <fragment de source A> <fragment de source B>
//   ex. : tsx src/diag-search.ts MATRICE_ESCALADE Formation_Presentation_GSMR
// Règle de choix des termes, FIXÉE avant toute recherche : pour chaque document, un mot de lettres seules (≥ 8 caractères, accents ôtés,
// minuscules) présent dans UN SEUL passage de ce document et dans AUCUN autre document ; le plus long, à égalité l'ordre alphabétique.
// Les deux termes suivants sont aussi interrogés, pour information (hors critère). Le critère : le document attendu est en tête (rang 1).
import { homedir } from "node:os";
import { join } from "node:path";
import { JarodApp, start, stop } from "@jarod/kernel";
import { ProfileManager } from "@jarod/plugin-persona";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";
import { readFileSync } from "node:fs";

type Db = { all<T = Record<string, unknown>>(sql: string, ...args: unknown[]): T[] };
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function exclusiveTerms(rows: { source: string; text: string }[], want: string): string[] {
  const perDoc = new Map<string, Map<string, number>>(); // source → terme → nombre de passages
  for (const r of rows) {
    const terms = new Set(fold(r.text).match(/[a-z]{8,}/g) ?? []);
    const m = perDoc.get(r.source) ?? new Map<string, number>();
    for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
    perDoc.set(r.source, m);
  }
  const mine = [...perDoc.entries()].filter(([s]) => s.includes(want));
  if (mine.length !== 1) throw new Error(`« ${want} » correspond à ${mine.length} source(s) : ${[...perDoc.keys()].join(" | ")}`);
  const [, terms] = mine[0]!;
  const others = new Set<string>();
  for (const [s, m] of perDoc) if (!s.includes(want)) for (const t of m.keys()) others.add(t);
  return [...terms.entries()]
    .filter(([t, n]) => n === 1 && !others.has(t))
    .map(([t]) => t)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
}

async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) throw new Error("usage : diag-search.ts <fragment A> <fragment B>");
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const root = process.env.JAROD_HOME ?? join(appData, "Jarod-One", "data");
  const dir = new ProfileManager(root).dirFor("default");
  const emb = JSON.parse(readFileSync(join(dir, "embeddings.json"), "utf8")) as { modelDir: string; port: number };
  const app = new JarodApp({
    plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) }, embeddings: { modelDir: emb.modelDir, port: emb.port, isolation: {} }, llm: {}, rag: { embeddingsDefaultUrl: `http://127.0.0.1:${emb.port}/v1` } },
  } as never);
  const started = await start(app);
  try {
    const k = app as unknown as { storage: { db: Db }; rag: { rag: { search(q: string, k?: number): Promise<{ source?: string; docId: string; score: number }[]> } }; embeddings: { host: { ready(): Promise<void> } | null } };
    await k.embeddings.host?.ready();
    const rows = k.storage.db.all<{ source: string; text: string }>("SELECT source, text FROM rag_chunks");
    let ok = true;
    for (const [label, want, other] of [["A", a, b], ["B", b, a]] as const) {
      const terms = exclusiveTerms(rows, want);
      console.log(`\n[${label}] ${want} : ${terms.length} terme(s) exclusif(s) ; retenus : ${terms.slice(0, 3).join(", ")}`);
      for (const [i, term] of terms.slice(0, 3).entries()) {
        const hits = await k.rag.rag.search(term, 10);
        const top = hits[0];
        const good = (top?.source ?? top?.docId ?? "").includes(want);
        const rank = hits.findIndex((h) => (h.source ?? h.docId).includes(want)) + 1;
        console.log(`  ${i === 0 ? "CRITÈRE" : "info   "} « ${term} » → ${hits.map((h) => `${(h.source ?? h.docId).slice(0, 40)} ${h.score.toFixed(3)}`).slice(0, 3).join(" | ")} → ${good ? "EN TÊTE" : `PAS en tête (attendu : ${want}, autre : ${other})`} ; rang du document attendu dans les 10 premiers : ${rank > 0 ? rank : "absent"}`);
        if (i === 0 && !good) ok = false;
      }
    }
    console.log(`\nTEST 3 : ${ok ? "RÉUSSI" : "ÉCHOUÉ"}`);
    process.exitCode = ok ? 0 : 2;
  } finally {
    await stop(started);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
