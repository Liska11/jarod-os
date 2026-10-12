/**
 * Orchestrateur de la contention « ingestion de documents → voix » (protocole FIGÉ le 2026-10-01, DECISIONS).
 *   tsx bench/voice-contention.ts run [N]     alternance stricte A (à vide) / B (pendant une ingestion), A d'abord, N passages par
 *                                              condition (défaut 30) ; REPREND là où le fichier de résultats s'est arrêté
 *   tsx bench/voice-contention.ts verdict     verdict pur (`voice-contention-verdict.ts`) sur les passages enregistrés
 * Un passage = `voice.e2e` (2 tests, ≈ 48 s). En B, le processus de charge (`voice-contention-load.ts`) est lancé AVANT, doit
 * annoncer « ready », puis est arrêté APRÈS : A ne voit jamais de processus de charge. Résultats : .work/voice-contention/.
 * Machine inutilisée pendant toute la série (plusieurs heures au total).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Outcome, type Pass, voiceContentionVerdict } from "./voice-contention-verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const OUT = join(ROOT, ".work", process.env.VC_OUT ?? "voice-contention");
const RESULTS = join(OUT, "results.json");
const STOP = join(OUT, "load.stop");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
/**
 * VC_LOAD : « full » (défaut, protocole d'origine : charge dans un processus séparé), « embed » / « parse » (diagnostics
 * exploratoires), « inapp » (SPECS-P5-VOIX-PRIORITAIRE.md §7 : le pilote d'ingestion tourne DANS l'application sous test, priorité
 * de la voix ACTIVE ; les embeddings sont calculés par un serveur séparé) et « inapp-off » (condition TÉMOIN : même chose, priorité
 * désactivée — elle doit reproduire la dégradation), « rerank » (SPECS-P5-RERANKER.md §8 d : la condition B active le worker du reranker et
 * fait tourner des reclassements RÉELS en boucle sur le NPU PENDANT la dictée, dans l'application sous test ; même verdict, mêmes seuils).
 */
const MODE = process.env.VC_LOAD ?? "full";
const INAPP = MODE === "inapp" || MODE === "inapp-off";
/** Affectation sous laquelle la dégradation d'origine (+79 %) existe : formes courtes (128) sur l'iGPU, longues (512) sur le NPU. */
const EXPECTED_DEVICES = '{"128":"GPU.0","512":"NPU"}';
const PY = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const DOCLING = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const PDFIUM = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
const inappDocs = (): string[] => {
  const dir = join(ROOT, "scripts", "corpus");
  return readdirSync(dir)
    .filter((f) => [".xlsx", ".docx", ".pdf"].includes(extname(f).toLowerCase()) && statSync(join(dir, f)).size <= 7 * 1024 * 1024)
    .sort((a, b) => a.localeCompare(b))
    .map((f) => join(dir, f));
};

interface Rec extends Pass {
  index: number;
  startedAt: number;
  endedAt: number;
  loadChunksDuring?: number;
}

const load = (): Rec[] => (existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, "utf8")) as Rec[]) : []);
const save = (r: Rec[]) => writeFileSync(RESULTS, JSON.stringify(r, null, 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kill = (pid: number | undefined) => {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* déjà terminé */
  }
};

interface LoadProc {
  pid: number | undefined;
  docs: { at: number; chunks: number }[];
  ready: Promise<boolean>;
  done: Promise<void>;
}

function startLoad(): LoadProc {
  rmSync(STOP, { force: true });
  const p = spawn(process.execPath, ["--import", "tsx", join(HERE, "voice-contention-load.ts"), STOP], { cwd: join(ROOT, "tests"), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const docs: { at: number; chunks: number }[] = [];
  let buf = "";
  let markReady: (v: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => (markReady = r));
  const done = new Promise<void>((r) => p.on("exit", () => (markReady(false), r())));
  p.stdout.on("data", (c) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const e = JSON.parse(line) as { event: string; at?: number; chunks?: number };
        if (e.event === "ready") markReady(true);
        if (e.event === "doc") docs.push({ at: e.at ?? Date.now(), chunks: e.chunks ?? 0 });
      } catch {
        /* ligne non JSON */
      }
    }
  });
  return { pid: p.pid, docs, ready, done };
}

interface EmbProc {
  pid: number | undefined;
  url: Promise<string | null>;
  done: Promise<void>;
}

/** Serveur d'embeddings séparé (mode « inapp ») : annonce son URL quand les formes sont compilées. */
function startEmbeddings(): EmbProc {
  rmSync(STOP, { force: true });
  const p = spawn(process.execPath, ["--import", "tsx", join(HERE, "voice-contention-embeddings.ts"), STOP], { cwd: join(ROOT, "tests"), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  let setUrl: (v: string | null) => void = () => {};
  const url = new Promise<string | null>((r) => (setUrl = r));
  const done = new Promise<void>((r) => p.on("exit", () => (setUrl(null), r())));
  p.stdout.on("data", (c) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const e = JSON.parse(line) as { event: string; url?: string };
        if (e.event === "ready" && e.url) setUrl(e.url);
      } catch {
        /* ligne non JSON */
      }
    }
  });
  return { pid: p.pid, url, done };
}

/** Journal du pilote d'ingestion DANS l'application : documents indexés et temps total cédé à la voix. */
function readIngest(file: string): { docs: number; chunks: number; pausedMs: number } {
  let docs = 0;
  let chunks = 0;
  let pausedMs = 0;
  if (!existsSync(file)) return { docs, chunks, pausedMs };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as { event: string; chunks?: number; pausedMs?: number };
      if (e.event === "doc") (docs += 1), (chunks += e.chunks ?? 0);
      if (typeof e.pausedMs === "number") pausedMs = Math.max(pausedMs, e.pausedMs);
    } catch {
      /* ligne incomplète (application arrêtée en cours d'écriture) */
    }
  }
  return { docs, chunks, pausedMs };
}

function runVoice(log: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [VITEST, "run", "test/e2e/voice.e2e.test.ts", "--config", "vitest.e2e.config.ts"], { cwd: DESKTOP, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => {
      writeFileSync(log, out);
      done(code ?? -1);
    });
  });
}

/** Métriques du passage : le rapport du cas NORMAL (pas celui où le processus du mot d'activation est tué) écrit pendant le passage. */
function metrics(since: number): { sttMs?: number; wakeAtMs?: number } {
  const dir = join(ROOT, ".work");
  for (const f of readdirSync(dir).filter((x) => /^e2e-voice-report-\d+\.json$/.test(x))) {
    if (statSync(join(dir, f)).mtimeMs < since) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as { JAROD_SMOKE_WAKEWORD_KILL?: string; transcripts?: { sttMs?: number; wake?: { atMs?: number } }[] };
      if (r.JAROD_SMOKE_WAKEWORD_KILL === "1") continue;
      const t = r.transcripts?.[0];
      if (t?.sttMs !== undefined) return { sttMs: t.sttMs, ...(t.wake?.atMs !== undefined ? { wakeAtMs: t.wake.atMs } : {}) };
    } catch {
      /* rapport illisible */
    }
  }
  return {};
}

async function run(n: number): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const recs = load();
  for (let index = recs.length; index < 2 * n; index++) {
    const condition = index % 2 === 0 ? "A" : "B";
    const padded = String(index).padStart(3, "0");
    let lp: LoadProc | null = null;
    let emb: EmbProc | null = null;
    let voiceEnv: Record<string, string> = {};
    let rerankCount = "";
    const ingestLog = join(OUT, `ingest-${padded}.jsonl`);
    if (condition === "B" && INAPP) {
      emb = startEmbeddings();
      const url = await Promise.race([emb.url, sleep(420_000).then(() => null)]);
      if (!url) {
        kill(emb.pid);
        throw new Error(`passage ${index} : le serveur d'embeddings n'a pas démarré (ni « ready » en 7 min) — série arrêtée, reprise possible`);
      }
      rmSync(ingestLog, { force: true });
      voiceEnv = {
        JAROD_E2E_INGEST_LOAD: "1",
        JAROD_E2E_INGEST_EMBEDDINGS_URL: url,
        JAROD_E2E_INGEST_DOCS: JSON.stringify(inappDocs()),
        JAROD_E2E_INGEST_PYTHON: PY,
        JAROD_E2E_INGEST_DOCLING: DOCLING,
        JAROD_E2E_INGEST_PDFIUM: PDFIUM,
        JAROD_E2E_INGEST_LOG: ingestLog,
        ...(MODE === "inapp-off" ? { JAROD_E2E_INGEST_PRIORITY: "off" } : {}),
      };
    } else if (condition === "B" && (MODE === "rerank" || MODE === "rerank-nopause")) {
      // La charge vit dans l'application sous test (voice.e2e prépare le profil, attend la compilation du reranker, puis dicte).
      rerankCount = join(OUT, `pass-${padded}-${condition}.rerank-count.json`);
      voiceEnv = { JAROD_E2E_RERANKER_ACTIVE: "1", JAROD_E2E_RERANK_COUNT_FILE: rerankCount, ...(MODE === "rerank-nopause" ? { JAROD_E2E_RERANK_VOICE_PRIORITY: "0" } : {}) };
    } else if (condition === "B") {
      lp = startLoad();
      if (!(await Promise.race([lp.ready, sleep(420_000).then(() => false)]))) {
        kill(lp.pid);
        throw new Error(`passage ${index} : la charge n'a pas démarré (ni « ready » en 7 min) — série arrêtée, reprise possible`);
      }
    }
    const startedAt = Date.now();
    const rc = await runVoice(join(OUT, `pass-${padded}-${condition}.log`), voiceEnv);
    const endedAt = Date.now();
    const log = readFileSync(join(OUT, `pass-${padded}-${condition}.log`), "utf8");
    const outcome: Outcome = rc === 0 ? "OK" : log.includes("3221225477") ? "CRASH" : "FAIL";
    let during: { docs: number; chunks: number } | undefined;
    let pausedMs: number | undefined;
    let embDevices: string | undefined;
    if (emb) {
      writeFileSync(STOP, "stop");
      await Promise.race([emb.done, sleep(60_000)]);
      kill(emb.pid);
      try {
        const m = JSON.parse(readFileSync(`${STOP}.metrics.json`, "utf8")) as { device: Record<string, string> };
        embDevices = JSON.stringify(Object.fromEntries(Object.entries(m.device).sort(([x], [y]) => x.localeCompare(y))));
      } catch {
        /* métriques absentes : la condition de validité le dira */
      }
      rmSync(`${STOP}.metrics.json`, { force: true });
      const ev = readIngest(ingestLog);
      during = { docs: ev.docs, chunks: ev.chunks };
      pausedMs = ev.pausedMs;
    }
    if (rerankCount) {
      try {
        const c = JSON.parse(readFileSync(rerankCount, "utf8")) as { reranks: number; paused?: number; failed?: number };
        // `docsDuring` = reclassements réels réussis (validité : charge présente) ; `pausedMs` = nombre de refus pendant la dictée (le mécanisme
        // s'est enclenché, vérifié par `requirePause` : > 0).
        during = { docs: c.reranks, chunks: 0 };
        pausedMs = c.paused ?? 0;
      } catch {
        during = { docs: 0, chunks: 0 }; // pas de compte (passage échoué avant la fin) : la charge n'est pas prouvée
      }
    }
    if (lp) {
      during = { docs: lp.docs.filter((d) => d.at >= startedAt && d.at <= endedAt).length, chunks: lp.docs.filter((d) => d.at >= startedAt && d.at <= endedAt).reduce((s, d) => s + d.chunks, 0) };
      writeFileSync(STOP, "stop");
      await Promise.race([lp.done, sleep(120_000)]);
      kill(lp.pid);
    }
    recs.push({ index, condition, outcome, startedAt, endedAt, ...(outcome === "OK" ? metrics(startedAt - 1000) : {}), ...(during ? { docsDuring: during.docs, loadChunksDuring: during.chunks } : {}), ...(pausedMs !== undefined ? { pausedMs } : {}), ...(embDevices ? { embDevices } : {}) });
    save(recs);
    const a = recs.filter((r) => r.condition === "A");
    const b = recs.filter((r) => r.condition === "B");
    console.log(`passage ${index + 1}/${2 * n} ${condition} : ${outcome}${during ? ` (charge : ${during.docs} doc., ${during.chunks} chunks${pausedMs !== undefined ? `, ${(pausedMs / 1000).toFixed(1)} s cédées à la voix` : ""})` : ""} — A ${a.filter((r) => r.outcome === "OK").length}/${a.length}, B ${b.filter((r) => r.outcome === "OK").length}/${b.length}`);
    await sleep(3000);
  }
}

function verdict(): void {
  const recs = load();
  const v = voiceContentionVerdict(recs, { requirePause: MODE === "inapp" || MODE === "rerank", ...(INAPP ? { expectedDevices: EXPECTED_DEVICES } : {}) });
  const b = recs.filter((r) => r.condition === "B");
  console.log(JSON.stringify({ ...v, loadDocsMedianPerPass: b.length ? [...b.map((r) => r.docsDuring ?? 0)].sort((x, y) => x - y)[Math.floor(b.length / 2)] : null }, null, 1));
  console.log(`\nVERDICT : ${v.verdict.toUpperCase()} — à vide ${v.ok.A}/${v.n.A} (plantages ${v.crash.A}), sous charge ${v.ok.B}/${v.n.B} (plantages ${v.crash.B}), Fisher unilatéral p = ${v.fisherP.toFixed(3)}`);
  for (const r of v.reasons) console.log(`  - ${r}`);
}

/**
 * Conclusion des deux séries « dans l'application » (protocole figé le 2026-10-01 à la revue du banc) : le TÉMOIN (priorité
 * désactivée) doit REPRODUIRE la dégradation (médiane de la transcription > 1,10× l'à-vide du même lot) ET porter l'affectation
 * d'appareils attendue ; sinon le banc ne mesure pas ce qu'on croit et le résultat de la série principale est NON CONCLUANT.
 */
function final(): void {
  const read = (dir: string): Rec[] => JSON.parse(readFileSync(join(ROOT, ".work", dir, "results.json"), "utf8")) as Rec[];
  const main = read("voice-contention-inapp");
  const witness = read("voice-contention-inapp-off");
  const mainV = voiceContentionVerdict(main, { requirePause: true, expectedDevices: EXPECTED_DEVICES });
  const witnessV = voiceContentionVerdict(witness, { expectedDevices: EXPECTED_DEVICES });
  const ratio = witnessV.medians.sttB !== null && witnessV.medians.sttA ? witnessV.medians.sttB / witnessV.medians.sttA : null;
  const reproduced = ratio !== null && ratio > 1.1 && witnessV.verdict !== "invalide";
  console.log(`SÉRIE PRINCIPALE (priorité active) : ${mainV.verdict.toUpperCase()} — à vide ${mainV.ok.A}/${mainV.n.A}, sous charge ${mainV.ok.B}/${mainV.n.B}, plantages ${mainV.crash.A}/${mainV.crash.B}, Fisher p = ${mainV.fisherP.toFixed(3)}, transcription ${mainV.medians.sttA} → ${mainV.medians.sttB} ms, mot d'activation ${mainV.medians.wakeA} → ${mainV.medians.wakeB} ms`);
  for (const r of mainV.reasons) console.log(`   - ${r}`);
  console.log(`TÉMOIN (priorité désactivée) : transcription ${witnessV.medians.sttA} → ${witnessV.medians.sttB} ms${ratio ? ` (×${ratio.toFixed(3)})` : ""} — dégradation ${reproduced ? "REPRODUITE" : "NON reproduite"}${witnessV.verdict === "invalide" ? ` (témoin INVALIDE : ${witnessV.reasons.join(" ; ")})` : ""}`);
  const conclusion = !reproduced ? "NON CONCLUANT" : mainV.verdict === "invalide" ? "INVALIDE" : mainV.verdict === "dégradation" ? "DÉGRADATION PERSISTANTE" : "LA PRIORITÉ SUFFIT (pas de dégradation démontrée, témoin reproduit)";
  console.log(`\nCONCLUSION : ${conclusion}`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "run") await run(Number(arg ?? 30));
else if (mode === "verdict") verdict();
else if (mode === "final") final();
else {
  console.error("usage : voice-contention.ts run [N] | verdict | final");
  process.exit(2);
}
process.exit(0);
