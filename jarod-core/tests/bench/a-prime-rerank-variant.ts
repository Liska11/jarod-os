/**
 * Variante EXPLORATOIRE (post hoc, HORS des barres figées de la gate du reranker) : et si les candidats étaient pris SANS le plafond de
 * `maxChunksPerDoc` (2 par document), et le plafond appliqué APRÈS le reclassement ? Motif : la gate a montré que les questions 10 et 15 ne sont
 * jamais récupérées ; leur passage-réponse est écarté par le plafond avant que le reranker le voie. Cette mesure CHIFFRE l'effet, elle ne change
 * rien à la production. Sur une copie de la base ; compteurs et rangs seulement.
 *
 *     tsx bench/a-prime-rerank-variant.ts <dossier-profil-copie> [--devices CPU] [--port 8931]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const CAP = 2;
const TOP_N = 16;

interface Hit { docId: string; ord: number; text: string; score: number }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) throw new Error("usage : tsx bench/a-prime-rerank-variant.ts <dossier-profil-copie> [--devices CPU] [--port 8931]");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const devices = (opt("--devices") ?? "CPU").split(",");
  const port = Number(opt("--port") ?? 8931);
  const spec = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: { n: number; answer: string[] }[] };
  const questions = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !HEADERS.some((h) => h.test(l)));
  const full = (s: string) => `${spec.docs[s.split("#")[0]!]}#${s.split("#")[1]}`;
  const idOf = (h: Hit) => `${h.docId}#${h.ord}`;

  const cipher = electronSecretsCipher(electronUserDataDir(process.env));
  {
    const first = new JarodApp({ plugins: { storage: { dataDir: dir, cipher } } } as never);
    const st = await start(first);
    const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
    s.set("rag", { ...s.get("rag"), enabled: true });
    s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: TOP_N, rerankDeadlineMs: 4000, rerankMode: "shadow" });
    await stop(st);
  }
  const app = new JarodApp({
    plugins: {
      storage: { dataDir: dir, cipher },
      llm: {},
      embeddings: { modelDir: join(ROOT, "tools", "ov-bge-m3-int8"), port: 8920, isolation: {}, reranker: { modelDir: join(ROOT, "tools", "ov-bge-reranker-int8-b8x512"), port, batch: 8, maxLength: 512, devices } },
      rag: { embeddingsDefaultUrl: "http://127.0.0.1:8920/v1" },
    },
  } as never);
  const started = await start(app);
  const a = app as unknown as {
    rag: { rag: { search(q: string, k?: number): Promise<Hit[]> } };
    reranker: { available: boolean; info(): { device?: string }; rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<{ id: number; score: number }[]> };
    storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } };
  };
  try {
    const t0 = Date.now();
    while (!a.reranker.available && Date.now() - t0 < 360_000) await sleep(500);
    if (!a.reranker.available) throw new Error("reranker indisponible");
    console.log(`appareil ${a.reranker.info().device}`);
    // Le worker est lancé (drapeau allumé au démarrage) ; on COUPE le drapeau pour que `search` ne lance aucun reclassement fantôme en tâche de fond
    // (il occuperait le worker et ferait refuser les appels directs de cette mesure).
    a.storage.settings.set("ecosystem", { ...a.storage.settings.get("ecosystem"), reranker: "off" });
    // Recherche SANS plafond : on relève maxChunksPerDoc très haut.
    const rag = a.storage.settings.get("rag");
    a.storage.settings.set("rag", { ...rag, maxChunksPerDoc: 100000 });
    const capList = (list: Hit[]): Hit[] => {
      const seen = new Map<string, number>();
      return list.filter((h) => {
        const n = seen.get(h.docId) ?? 0;
        if (n >= CAP) return false;
        seen.set(h.docId, n + 1);
        return true;
      });
    };
    const scored = spec.questions.filter((q) => q.answer.length > 0);
    const rankOf = (list: string[], answers: string[]): number | null => {
      const want = new Set(answers.map(full));
      const p = list.findIndex((id) => want.has(id));
      return p >= 0 ? p + 1 : null;
    };
    const lists = { nocapDense: {} as Record<number, string[]>, variant: {} as Record<number, string[]> };
    for (let qi = 0; qi < questions.length; qi++) {
      const n = spec.questions[qi]!.n;
      const nocap = await a.rag.rag.search(questions[qi]!, 400);
      const cands = nocap.slice(0, TOP_N);
      const hits = await a.reranker.rerank({ query: questions[qi]!, candidates: cands.map((h, i) => ({ id: i, text: h.text })), topN: cands.length, deadlineMs: 4000 });
      const reranked = [...hits.map((h) => cands[h.id]!), ...nocap.slice(TOP_N)];
      lists.nocapDense[n] = capList(nocap).map(idOf); // le dense d'aujourd'hui (plafond appliqué après), pour comparaison
      lists.variant[n] = capList(reranked).map(idOf); // reclassement AVANT le plafond
    }
    const stats = (key: "nocapDense" | "variant") => {
      const ranks = scored.map((q) => rankOf(lists[key][q.n]!, q.answer));
      return {
        at1: ranks.filter((r) => r !== null && r <= 1).length,
        at3: ranks.filter((r) => r !== null && r <= 3).length,
        at10: ranks.filter((r) => r !== null && r <= 10).length,
        mrr: Number((ranks.reduce<number>((sum, r) => sum + (r ? 1 / r : 0), 0) / ranks.length).toFixed(4)),
        ranks: Object.fromEntries(scored.map((q, i) => [q.n, ranks[i]])),
      };
    };
    const d = stats("nocapDense");
    const v = stats("variant");
    const f = (s: { at1: number; at3: number; at10: number; mrr: number }) => `@1 ${s.at1}/22  @3 ${s.at3}/22  @10 ${s.at10}/22  MRR ${s.mrr}`;
    console.log("VARIANTE EXPLORATOIRE (hors barres) : candidats SANS plafond, plafond de 2 par document appliqué APRÈS le reclassement");
    console.log(`dense, plafond appliqué après (équivalent au dense d'aujourd'hui) ${f(d)}`);
    console.log(`reclassé AVANT le plafond (N=16)                                  ${f(v)}`);
    console.log("rangs qui changent (dense | variante) :", scored.filter((q) => d.ranks[q.n] !== v.ranks[q.n]).map((q) => `Q${q.n}: ${d.ranks[q.n] ?? "-"}→${v.ranks[q.n] ?? "-"}`).join("  "));
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
