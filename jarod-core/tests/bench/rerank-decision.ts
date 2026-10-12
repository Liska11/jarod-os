/**
 * Passe de décision d'activation du reranker (SPECS-P5-RERANKER.md §10). Barres A à E APPROUVÉES le 2026-10-02 (seuils dans rerank-decision-verdict.ts).
 * Trois commandes :
 *   check   : n'évalue AUCUNE question. Empreinte du corpus, lignes du fantôme postérieures au nettoyage, fichiers du banc propres dans git.
 *   freeze  : refuse si D n'est pas mesurable (moins de 30 lignes) ou si un fichier est modifié ; écrit `rerank-decision-frozen.json` (à COMMITER).
 *   measure : UNE SEULE exécution. Vérifie le gel (empreintes SHA-256, git propre, corpus identique, journal e2e + canari POSTÉRIEUR au gel), pose
 *             le verrou `.work/rerank-decision.done` AVANT toute question, mesure sur une COPIE du profil, rend les chiffres tels quels.
 * Application FERMÉE (verrou du profil libre). Ne rend que des compteurs et des identifiants `document#ordre` : aucun texte de document.
 *
 *     tsx bench/rerank-decision.ts check|freeze|measure [--e2e-log .work/e2e-canary.log]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { isProcessAlive, readRuntimeLock } from "@jarod/plugin-agent";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";
import { resetBenchState } from "./bench-state.js";
import { BARS, decisionVerdict, gainsLosses, realUseStats, type SetResult, type ShadowLine, setMetrics } from "./rerank-decision-verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const FROZEN = join(HERE, "rerank-decision-frozen.json");
const DONE = join(ROOT, ".work", "rerank-decision.done");
const EMB_MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const RR_MODEL = join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const TOP_N = 16;
const DEADLINE_MS = 4000;
const LIMIT = 50;
/** Coupe de la barre (D) : modification de la base par la suppression du doublon (2026-10-02 15:01:46.008 UTC). Strictement postérieur. */
const CUT_MS = Date.parse("2026-10-02T15:01:46.008Z");
const EXPECTED_PASSAGES = 395;

const GUARDED = ["tests/bench/rerank-decision.ts", "tests/bench/rerank-decision-verdict.ts", "tests/bench/bench-state.ts", "tests/bench/a-prime-targets.json", "tests/bench/hybrid-heldout.json", "tests/bench/hybrid-heldout-2.json", "question test rag.txt"];

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const fail = (m: string): never => {
  console.error(`ARRÊT : ${m}`);
  process.exit(2);
};
const profileRoot = () => join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Jarod-One", "data");
const profileDir = () => join(profileRoot(), "profiles", "default");

function gitClean(): string[] {
  const r = spawnSync("git", ["status", "--porcelain", "--", ...GUARDED], { cwd: ROOT, encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean);
}
function lockLive(dir: string): string | null {
  const l = readRuntimeLock(dir);
  return l && isProcessAlive(l.pid) ? `le profil est tenu par un processus vivant (pid ${l.pid}) : fermez l'application.` : null;
}

type Db = { all<T = Record<string, unknown>>(sql: string, ...a: unknown[]): T[]; get<T = Record<string, unknown>>(sql: string, ...a: unknown[]): T | undefined };
function corpusOf(db: Db): { passages: number; perSource: Record<string, number>; fingerprint: string } {
  const rows = db.all<{ source: string; doc_id: string; ord: number; sha256: string }>("SELECT source, doc_id, ord, sha256 FROM rag_chunks ORDER BY source, doc_id, ord");
  const perSource: Record<string, number> = {};
  for (const r of rows) perSource[r.source] = (perSource[r.source] ?? 0) + 1;
  return { passages: rows.length, perSource, fingerprint: createHash("sha256").update(rows.map((r) => `${r.source}|${r.doc_id}|${r.ord}|${r.sha256}`).join("\n")).digest("hex") };
}
async function withStorage<T>(dir: string, f: (db: Db) => T | Promise<T>): Promise<T> {
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) }, llm: {} } } as never);
  const started = await start(app);
  try {
    return await f((app as unknown as { storage: { db: Db } }).storage.db);
  } finally {
    await stop(started);
  }
}
function shadowLines(): ShadowLine[] {
  const p = join(profileDir(), "rerank-shadow.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ShadowLine);
}

async function check(): Promise<{ corpus: ReturnType<typeof corpusOf>; real: ReturnType<typeof realUseStats> }> {
  const dir = profileDir();
  const live = lockLive(dir);
  if (live) fail(live);
  const corpus = await withStorage(dir, (db) => corpusOf(db));
  const real = realUseStats(shadowLines(), CUT_MS);
  console.log(`corpus : ${corpus.passages} passages (attendu ${EXPECTED_PASSAGES}) ; empreinte ${corpus.fingerprint.slice(0, 16)}… ; sources : ${JSON.stringify(corpus.perSource)}`);
  console.log(`fantôme postérieur au nettoyage : ${real.n} ligne(s) (minimum de la barre D : ${BARS.dMinLines}) ; ok ${real.ok}, erreurs ${real.errors}`);
  const dirty = gitClean();
  console.log(dirty.length ? `fichiers du banc MODIFIÉS non commités : ${dirty.join(" ; ")}` : "fichiers du banc : propres dans git");
  if (corpus.passages !== EXPECTED_PASSAGES) console.log(`ATTENTION : ${corpus.passages} passages au lieu de ${EXPECTED_PASSAGES}`);
  return { corpus, real };
}

async function freeze(): Promise<void> {
  const { corpus, real } = await check();
  if (corpus.passages !== EXPECTED_PASSAGES) fail("corpus inattendu : la passe est définie sur 395 passages.");
  if (real.n < BARS.dMinLines) fail(`barre D non mesurable : ${real.n} ligne(s) postérieure(s) au nettoyage, ${BARS.dMinLines} requises. Pas de gel.`);
  const dirty = gitClean();
  if (dirty.length) fail(`fichiers du banc non commités : ${dirty.join(" ; ")}`);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const frozen = {
    frozenAt: new Date().toISOString(),
    headAtFreeze: head,
    bars: BARS,
    cutMs: CUT_MS,
    topN: TOP_N,
    deadlineMs: DEADLINE_MS,
    corpus: { passages: corpus.passages, fingerprint: corpus.fingerprint, perSource: corpus.perSource },
    shadowAtFreeze: { postCutLines: real.n, ok: real.ok, errors: real.errors, p95Ms: real.p95Ms },
    files: Object.fromEntries(GUARDED.map((f) => [f, sha(join(ROOT, f))])),
  };
  writeFileSync(FROZEN, `${JSON.stringify(frozen, null, 2)}\n`);
  console.log(`GEL écrit : ${FROZEN}\nÀ COMMITER maintenant ; ensuite : e2e + canari ×10 (journal postérieur au gel), puis UNE mesure.`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Target { n: number; answer: string[]; partial?: string[] }
interface QItem { set: "S1" | "S2a" | "S2b"; label: string; text: string; answers: string[]; ordinary: boolean; docs: Record<string, string> }
interface Hit { docId: string; ord: number; text: string; score: number }
type Rag = { search(q: string, k?: number): Promise<Hit[]>; setEmbedder(f: null): void };
type Svc = { available: boolean; info(): { device?: string }; rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<{ id: number; score: number }[]> };

function loadQuestions(): { items: QItem[]; noAnswer: QItem[] } {
  const bench = (f: string) => JSON.parse(readFileSync(join(HERE, f), "utf8")) as { docs: Record<string, string>; questions: (Target & { q?: string; kind?: string })[] };
  const a = bench("a-prime-targets.json");
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !HEADERS.some((h) => h.test(l)));
  if (lines.length !== a.questions.length) fail(`${lines.length} questions pour ${a.questions.length} cibles (A')`);
  const s1 = a.questions.map((t, i): QItem => ({ set: "S1", label: `A'${t.n}`, text: lines[i]!, answers: t.answer, ordinary: false, docs: a.docs }));
  const h1 = bench("hybrid-heldout.json");
  const h2 = bench("hybrid-heldout-2.json");
  const s2a = h1.questions.map((t): QItem => ({ set: "S2a", label: `H1-${t.n}`, text: t.q!, answers: t.answer, ordinary: true, docs: h1.docs }));
  const s2b = h2.questions.map((t): QItem => ({ set: "S2b", label: `H2-${t.n}`, text: t.q!, answers: t.answer, ordinary: t.kind === "ordinaire", docs: h2.docs }));
  const all = [...s1, ...s2a, ...s2b];
  return { items: all.filter((q) => q.answers.length > 0), noAnswer: all.filter((q) => q.answers.length === 0) };
}

async function measure(): Promise<void> {
  if (existsSync(DONE)) fail(`UNE SEULE mesure : le verrou ${DONE} existe déjà (${readFileSync(DONE, "utf8").trim()}). Rien n'est relancé.`);
  if (!existsSync(FROZEN)) fail("pas de gel : exécutez `freeze` et commitez le fichier.");
  const fz = JSON.parse(readFileSync(FROZEN, "utf8")) as { frozenAt: string; files: Record<string, string>; corpus: { passages: number; fingerprint: string } };
  const bad = Object.entries(fz.files).filter(([f, h]) => sha(join(ROOT, f)) !== h).map(([f]) => f);
  if (bad.length) fail(`le banc a changé depuis le gel : ${bad.join(", ")}`);
  const dirty = gitClean();
  if (dirty.length) fail(`fichiers du banc non commités : ${dirty.join(" ; ")}`);
  if (spawnSync("git", ["ls-files", "--error-unmatch", "tests/bench/rerank-decision-frozen.json"], { cwd: ROOT }).status !== 0) fail("le fichier de gel n'est pas commité.");
  const dir = profileDir();
  const live = lockLive(dir);
  if (live) fail(live);

  // (E) journal e2e + canari : POSTÉRIEUR au gel, vert.
  const argv = process.argv.slice(2);
  const logPath = resolve(ROOT, argv.includes("--e2e-log") ? argv[argv.indexOf("--e2e-log") + 1]! : ".work/e2e-canary.log");
  if (!existsSync(logPath)) fail(`journal e2e + canari introuvable : ${logPath}`);
  const log = readFileSync(logPath, "utf8");
  if (statSync(logPath).mtimeMs < Date.parse(fz.frozenAt)) fail("le journal e2e + canari est ANTÉRIEUR au gel : rejouez-les (règle : le jour de la mesure).");
  const e2eAndCanary = /E2E_EXIT=0/.test(log) && /CANARI_TOTAL pass=10 fail=0/.test(log) && !/\.dmp/.test(log);

  const corpus = await withStorage(dir, (db) => corpusOf(db));
  if (corpus.fingerprint !== fz.corpus.fingerprint) fail("le corpus a changé depuis le gel (empreinte différente).");

  // Copie du profil (jamais l'original) ; le verrou « une seule mesure » est posé AVANT toute question.
  const copy = join(ROOT, ".work", "rerank-decision", "profiles", "default");
  rmSync(join(ROOT, ".work", "rerank-decision"), { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  for (const f of ["jarod.db", "db.key.dpapi"]) copyFileSync(join(dir, f), join(copy, f));
  if (sha(join(copy, "jarod.db")) !== sha(join(dir, "jarod.db"))) fail("copie du profil non identique");
  mkdirSync(dirname(DONE), { recursive: true });
  writeFileSync(DONE, `mesure lancée le ${new Date().toISOString()} (gel du ${fz.frozenAt})\n`);

  const cipher = electronSecretsCipher(electronUserDataDir(process.env));
  {
    const first = new JarodApp({ plugins: { storage: { dataDir: copy, cipher } } } as never);
    const st = await start(first);
    const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
    s.set("rag", { ...s.get("rag"), enabled: true });
    s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: TOP_N, rerankDeadlineMs: DEADLINE_MS, rerankMode: "active" });
    await stop(st);
  }
  const app = new JarodApp({
    plugins: { storage: { dataDir: copy, cipher }, llm: {}, embeddings: { modelDir: EMB_MODEL, port: 8920, isolation: {}, reranker: { modelDir: RR_MODEL, port: 8930, batch: 8, maxLength: 512 } }, rag: { embeddingsDefaultUrl: "http://127.0.0.1:8920/v1" } },
  } as never);
  const started = await start(app);
  const a = app as unknown as { rag: { rag: Rag }; reranker: Svc; storage: { db: Db; settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } }; embeddings: { host: { ready(): Promise<void> } | null } };
  try {
    await a.embeddings.host?.ready();
    const t0 = Date.now();
    while (!a.reranker.available && Date.now() - t0 < 420_000) await new Promise((r) => setTimeout(r, 500));
    if (!a.reranker.available) throw new Error("le reranker n'est pas devenu disponible en 420 s");
    const device = a.reranker.info().device ?? "?";
    const copyCorpus = corpusOf(a.storage.db);
    if (copyCorpus.fingerprint !== fz.corpus.fingerprint) throw new Error("le corpus de la COPIE diffère du corpus gelé");
    const flag = (patch: Record<string, unknown>) => a.storage.settings.set("ecosystem", { ...a.storage.settings.get("ecosystem"), ...patch });

    // État du banc (leçon du 2026-10-02) : canari = extrait verbatim d'un passage ≥ 400 caractères, réponse connue d'avance.
    const rows = a.storage.db.all<{ doc_id: string; ord: number; text: string }>("SELECT doc_id, ord, text FROM rag_chunks ORDER BY id");
    const norm = (s: string) => s.replace(/\s+/g, " ");
    const cand = rows.find((r) => r.text.length >= 400 && norm(r.text).slice(100, 300).trim().length >= 100)!;
    const ext = norm(cand.text).slice(100, 300).trim();
    const canary = { text: ext, ok: new Set(rows.filter((x) => norm(x.text).includes(ext)).map((x) => `${x.doc_id}#${x.ord}`)) };
    flag({ reranker: "off" });
    await resetBenchState("rerank-decision", { rag: a.rag.rag, setFlag: (v) => flag({ reranker: v === "off" ? "off" : "bge-reranker-v2-m3-npu" }), canary });
    console.log(`reranker prêt (${device}) ; état du banc vérifié (canari) ; mesure…`);

    const { items, noAnswer } = loadQuestions();
    const key = (h: { docId: string; ord: number }) => `${h.docId}#${h.ord}`;
    const rankIn = (list: string[], q: QItem): number | null => {
      const want = new Set(q.answers.map((s) => `${q.docs[s.split("#")[0]!]}#${s.split("#")[1]}`));
      const p = list.findIndex((id) => want.has(id));
      return p >= 0 ? p + 1 : null;
    };
    const per = new Map<string, { base: number | null; r16: number | null; r8: number | null; ms: number; fallback: boolean }>();
    let fallbacks = 0;
    const doRerank = async (q: QItem, base: Hit[], count: number): Promise<{ list: string[]; ms: number; fb: boolean; top: number | null }> => {
      const c = base.slice(0, count);
      const t = Date.now();
      try {
        const hits = await a.reranker.rerank({ query: q.text, candidates: c.map((h, i) => ({ id: i, text: h.text })), topN: c.length, deadlineMs: DEADLINE_MS });
        return { list: [...hits.map((h) => c[h.id]!), ...base.slice(count)].map(key), ms: Date.now() - t, fb: false, top: hits[0]?.score ?? null };
      } catch {
        return { list: base.map(key), ms: Date.now() - t, fb: true, top: null }; // repli de production : ordre d'origine
      }
    };
    const tops = new Map<string, number | null>();
    for (const q of [...items, ...noAnswer]) {
      const base = await a.rag.rag.search(q.text, LIMIT);
      const r16 = await doRerank(q, base, TOP_N);
      const r8 = await doRerank(q, base, 8);
      if (r16.fb) fallbacks++;
      tops.set(q.label, r16.top);
      if (q.answers.length) per.set(q.label, { base: rankIn(base.map(key), q), r16: rankIn(r16.list, q), r8: rankIn(r8.list, q), ms: r16.ms, fallback: r16.fb });
    }

    const pick = (pred: (q: QItem) => boolean): SetResult => {
      const qs = items.filter(pred);
      const b = qs.map((q) => per.get(q.label)!.base);
      const r = qs.map((q) => per.get(q.label)!.r16);
      return { base: setMetrics(b), rr: setMetrics(r), gl: gainsLosses(b, r) };
    };
    const s1 = pick((q) => q.set === "S1");
    const s2 = pick((q) => q.set !== "S1");
    const ordinary = pick((q) => q.set !== "S1" && q.ordinary);
    const real = realUseStats(shadowLines(), CUT_MS);
    const verdict = decisionVerdict({ s1, s2, ordinary, real, e2eAndCanary });
    const lost = items.filter((q) => per.get(q.label)!.base === 1 && per.get(q.label)!.r16 !== 1).map((q) => q.label);
    const won = items.filter((q) => per.get(q.label)!.base !== 1 && per.get(q.label)!.r16 === 1).map((q) => q.label);
    const lat = [...per.values()].map((p) => p.ms).sort((x, y) => x - y);
    const s8 = (pred: (q: QItem) => boolean) => setMetrics(items.filter(pred).map((q) => per.get(q.label)!.r8));
    const answeredTops = items.map((q) => tops.get(q.label) ?? 0).sort((x, y) => x - y);
    const report = {
      at: new Date().toISOString(),
      device,
      verdict,
      s1,
      s2,
      ordinary,
      real,
      e2eAndCanary,
      won,
      lost,
      fallbacks,
      latencyMs: { p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)], max: lat.at(-1), n: lat.length },
      relevesSansBarre: {
        n8_S1: s8((q) => q.set === "S1"),
        n8_S2: s8((q) => q.set !== "S1"),
        abstention: { sansReponse: Object.fromEntries(noAnswer.map((q) => [q.label, tops.get(q.label) ?? null])), avecReponseMin: answeredTops[0], avecReponseMediane: answeredTops[answeredTops.length >> 1] },
      },
      perQuestion: Object.fromEntries(items.map((q) => [q.label, { base: per.get(q.label)!.base, r16: per.get(q.label)!.r16, ordinary: q.ordinary }])),
    };
    const file = join(ROOT, ".work", `rerank-decision-report-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const f = (m: { n: number; at1: number; at3: number; mrr: number }) => `n=${m.n} @1 ${m.at1} @3 ${m.at3} MRR ${m.mrr}`;
    console.log(`\nS1 (A') : dense ${f(s1.base)} | reranké ${f(s1.rr)} | gagnées ${s1.gl.gains} perdues ${s1.gl.losses}`);
    console.log(`S2 (hors échantillon) : dense ${f(s2.base)} | reranké ${f(s2.rr)} | gagnées ${s2.gl.gains} perdues ${s2.gl.losses}`);
    console.log(`ordinaires : dense ${f(ordinary.base)} | reranké ${f(ordinary.rr)} | gagnées ${ordinary.gl.gains} perdues ${ordinary.gl.losses}`);
    console.log(`fantôme réel : ${real.n} ligne(s), ok ${real.ok} (${(real.okRate * 100).toFixed(1)} %), erreurs ${real.errors}, p95 ${real.p95Ms} ms ; e2e + canari : ${e2eAndCanary ? "verts" : "NON verts"}`);
    console.log(`gagnées : ${won.join(", ") || "aucune"} ; perdues : ${lost.join(", ") || "aucune"} ; replis : ${fallbacks}`);
    console.log(`BARRES : ${JSON.stringify(verdict.bars)} ; manquées : ${verdict.missed.join(", ") || "aucune"}\nVERDICT : ${verdict.verdict}\nrapport : ${file}`);
  } finally {
    await stop(started);
  }
}

const cmd = process.argv[2];
(cmd === "check" ? check().then(() => undefined) : cmd === "freeze" ? freeze() : cmd === "measure" ? measure() : Promise.reject(new Error("usage : tsx bench/rerank-decision.ts check|freeze|measure [--e2e-log F]"))).then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
