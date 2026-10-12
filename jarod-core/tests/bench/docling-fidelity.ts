/**
 * Banc de la gate B (fidélité Docling) — critères FIGÉS le 2026-09-30 (DECISIONS), verdict pur dans
 * `docling-verdict.ts`. Trois modes, chacun dans son PROCESSUS (passages en processus neufs) :
 *   tsx bench/docling-fidelity.ts prep        table d'identifiants anonymes + référence automatique (pdfium / XML brut)
 *   tsx bench/docling-fidelity.ts pass 1|2    lecture de chaque document par le VRAI worker ; textes et manifestes dans .work/
 *   tsx bench/docling-fidelity.ts verdict     compare, rend le verdict
 * Corpus : scripts/corpus/ (ignoré par git). Tout ce qui contient du texte de document reste dans .work/ (ignoré).
 * Ce qui s'imprime ne contient que des identifiants anonymes (F01…), des tailles, des durées et des rapports.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WorkerParser } from "@jarod/plugin-rag";
import { compare, type DocResult, type Format, galleryVerdict, normalizeOutput, type RefStructure, type Robustness } from "./docling-verdict.js";

const sh = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "scripts", "corpus");
// Jeu de MISE AU POINT (dev : le corpus déjà mesuré) ou jeu de VALIDATION (held : jamais mesuré). DECISIONS 2026-09-30.
const HELD = process.argv.includes("held");
const WORK = join(ROOT, ".work", HELD ? "docling-fid-held" : "docling-fid");
const SYNTH = join(WORK, "synth");
const DEV_MAX_BYTES = 25 * 1024 * 1024;
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const WORKER = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const MAX_BYTES = (HELD ? 100 : 25) * 1024 * 1024;
const TIMEOUT_MS = HELD ? 300_000 : 120_000;
const FMT: Record<string, Format> = { ".pdf": "pdf", ".docx": "docx", ".pptx": "pptx", ".xlsx": "xlsx" };
const PROCESS_CODES = new Set(["WORKER_EXIT", "WORKER_TIMEOUT", "WORKER_BAD_RESPONSE", "WORKER_SPAWN", "WORKER_MISSING", "WORKER_UNAVAILABLE"]);

interface Entry {
  id: string;
  file: string;
  path: string;
  format: Format | null;
  size: number;
}

function listDir(dir: string, prefix: string, keep: (size: number) => boolean): Entry[] {
  return readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ file, path: join(dir, file), format: FMT[extname(file).toLowerCase()] ?? null, size: statSync(join(dir, file)).size }))
    .filter((e) => keep(e.size))
    .map((e, i) => ({ id: `${prefix}${String(i + 1).padStart(2, "0")}`, ...e }));
}

/** dev : le corpus entier (ids F01…, numérotation d'origine). held : les PDF > 25 Mio du corpus (jamais notés) + le corpus synthétique. */
function inventory(): Entry[] {
  if (!HELD) return readdirSync(CORPUS).filter((f) => statSync(join(CORPUS, f)).isFile()).sort((a, b) => a.localeCompare(b)).map((file, i) => ({ id: `F${String(i + 1).padStart(2, "0")}`, file, path: join(CORPUS, file), format: FMT[extname(file).toLowerCase()] ?? null, size: statSync(join(CORPUS, file)).size }));
  const big = listDir(CORPUS, "P", (size) => size > DEV_MAX_BYTES).filter((e) => e.format === "pdf");
  const synth = existsSync(SYNTH) ? listDir(SYNTH, "S", () => true) : [];
  return [...big, ...synth];
}

const scope = (inv: Entry[]) => inv.filter((e) => e.format && e.size <= MAX_BYTES);
const tooBig = (inv: Entry[]) => inv.filter((e) => e.format && e.size > MAX_BYTES);
/** Le plus petit document trop gros : lu à titre INFORMATIF seulement (hors barres). */
const informative = (inv: Entry[]) => tooBig(inv).sort((a, b) => a.size - b.size)[0];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

function parser(over: { maxBytes?: number; timeoutMs?: number } = {}): WorkerParser {
  return new WorkerParser({
    name: "docling",
    command: PYTHON,
    args: [WORKER],
    extensions: [".pdf", ".docx", ".pptx", ".xlsx", ".html"],
    allowPath: () => false,
    timeoutMs: over.timeoutMs ?? TIMEOUT_MS,
    startTimeoutMs: 120_000,
    maxBytes: over.maxBytes ?? MAX_BYTES,
    threads: 2,
  });
}

/** Processus du worker (lanceur du venv ET interpréteur réel, repérés par leur ligne de commande) : orphelins après l'arrêt, mémoire (octets). */
async function venvProcesses(): Promise<{ count: number; rss: number }> {
  const ps = `$p = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*docling-worker.py*' }); "$($p.Count) $(($p | Measure-Object WorkingSetSize -Sum).Sum)"`;
  const { stdout } = await sh("powershell", ["-NoProfile", "-Command", ps]);
  const [count, rss] = stdout.trim().split(/\s+/).map(Number);
  return { count: count ?? 0, rss: rss ?? 0 };
}

// --- prep ------------------------------------------------------------------------------------------------------------
async function prep(): Promise<void> {
  const inv = inventory();
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, "map.json"), JSON.stringify(inv, null, 1)); // noms de fichiers : local seulement
  const info = informative(inv);
  const jobs = [...scope(inv), ...(info ? [info] : [])].map((e) => ({ id: e.id, path: e.path, format: e.format }));
  writeFileSync(join(WORK, "ref-jobs.json"), JSON.stringify(jobs));
  execFileSync(PYTHON, [join(dirname(fileURLToPath(import.meta.url)), "docling-reference.py"), join(WORK, "ref-jobs.json"), join(WORK, "ref")], { stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 28 });
  const fmts = (xs: Entry[]) => Object.entries(xs.reduce<Record<string, number>>((m, e) => ((m[e.format ?? "hors Q-I3"] = (m[e.format ?? "hors Q-I3"] ?? 0) + 1), m), {}));
  console.log(`corpus : ${inv.length} fichiers ; mesurés (Q-I3, ≤ 25 Mio) : ${scope(inv).length} ${JSON.stringify(fmts(scope(inv)))} ; trop gros : ${tooBig(inv).length} ; hors Q-I3 : ${inv.filter((e) => !e.format).length} ; informatif : ${info?.id ?? "aucun"}`);
}

// --- pass ------------------------------------------------------------------------------------------------------------
interface PassDoc {
  id: string;
  ms: number;
  error: string | null;
  hash: string | null;
  pages: number;
  tables: number;
  sections: number;
}

async function pass(n: 1 | 2): Promise<void> {
  const inv = inventory();
  const out = join(WORK, `out${n}`);
  mkdirSync(out, { recursive: true });
  const load = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"]).toString().trim();
  console.log(`passage ${n} : ${cpus().length} cœurs, charge CPU avant = ${load} %`);
  const before = await venvProcesses();
  const p = parser();
  let peak = 0;
  const timer = setInterval(() => void venvProcesses().then((v) => (peak = Math.max(peak, v.rss))).catch(() => {}), 2000);
  const docs: PassDoc[] = [];
  for (const e of scope(inv)) {
    const t0 = Date.now();
    let rec: PassDoc;
    try {
      const r = await p.parse({ bytes: readFileSync(e.path), name: e.file });
      writeFileSync(join(out, `${e.id}.txt`), r.text);
      writeFileSync(join(out, `${e.id}.manifest.json`), JSON.stringify(r.manifest));
      rec = { id: e.id, ms: Date.now() - t0, error: null, hash: sha(`${JSON.stringify(r.manifest)}\n${r.text}`), pages: r.manifest.pages ?? 0, tables: r.manifest.tables.length, sections: r.manifest.sections.length };
    } catch (err) {
      rec = { id: e.id, ms: Date.now() - t0, error: (err as { code?: string }).code ?? (err as Error).name, hash: null, pages: 0, tables: 0, sections: 0 };
    }
    docs.push(rec);
    console.log(`${rec.id} ${e.format} ${mb(e.size)} Mio ${rec.ms} ms ${rec.error ?? "ok"}`);
  }
  clearInterval(timer);
  const res: { docs: PassDoc[]; peakRssMb: number; robustness?: Robustness & { cases: Record<string, string> }; informative?: { id: string; ms: number; error: string | null; textChars: number } } = { docs, peakRssMb: Math.round(peak / 1024 / 1024) };

  if (n === 1) {
    // Robustesse sur le vrai worker : PDF tronqué, fichier de 0 octet, trop gros (refusé AVANT tout envoi).
    const cases: Record<string, string> = {};
    const firstPdf = scope(inv).find((e) => e.format === "pdf");
    const run = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        cases[label] = "accepté";
      } catch (err) {
        cases[label] = (err as { code?: string }).code ?? `EXCEPTION:${(err as Error).name}`;
      }
    };
    if (firstPdf) await run("pdf-tronqué", () => p.parse({ bytes: readFileSync(firstPdf.path).subarray(0, 1000), name: "t.pdf" }));
    await run("zéro-octet", () => p.parse({ bytes: Buffer.alloc(0), name: "v.docx" }));
    const big = tooBig(inv)[0];
    if (big) await run("trop-gros", () => p.parse({ bytes: readFileSync(big.path), name: big.file }));
    // Le worker reste utilisable après ces refus.
    const good = scope(inv)[0];
    if (good) await run("reprise-après-refus", () => p.parse({ bytes: readFileSync(good.path), name: good.file }));
    const clean = cases["zéro-octet"]?.startsWith("WORKER_") && cases["pdf-tronqué"]?.startsWith("WORKER_") && (HELD || cases["trop-gros"] === "WORKER_TOO_LARGE") && cases["reprise-après-refus"] === "accepté";
    await p.close();
    await new Promise((r) => setTimeout(r, 1500));
    const after = await venvProcesses();
    res.robustness = { orphans: Math.max(0, after.count - before.count), cleanRefusals: Boolean(clean), cases };

    // Informatif : un PDF trop gros, borne relevée (hors barres).
    const info = informative(inv);
    if (info) {
      const big2 = parser({ maxBytes: 100 * 1024 * 1024, timeoutMs: 300_000 });
      const t0 = Date.now();
      try {
        const r = await big2.parse({ bytes: readFileSync(info.path), name: info.file });
        res.informative = { id: info.id, ms: Date.now() - t0, error: null, textChars: r.text.length };
      } catch (err) {
        res.informative = { id: info.id, ms: Date.now() - t0, error: (err as { code?: string }).code ?? (err as Error).name, textChars: 0 };
      }
      await big2.close();
    }
  } else await p.close();
  writeFileSync(join(WORK, `pass${n}.json`), JSON.stringify(res, null, 1));
  console.log(`passage ${n} terminé ; pic mémoire du worker ≈ ${res.peakRssMb} Mio`);
}

// --- verdict ---------------------------------------------------------------------------------------------------------
function verdict(): void {
  const inv = inventory();
  const p1 = JSON.parse(readFileSync(join(WORK, "pass1.json"), "utf8")) as { docs: PassDoc[]; robustness?: Robustness & { cases: Record<string, string> }; informative?: { id: string; ms: number; error: string | null; textChars: number }; peakRssMb: number };
  const p2 = JSON.parse(readFileSync(join(WORK, "pass2.json"), "utf8")) as { docs: PassDoc[]; peakRssMb: number };
  const results: DocResult[] = [];
  const lines: string[] = [];
  for (const e of scope(inv)) {
    const a = p1.docs.find((d) => d.id === e.id);
    const b = p2.docs.find((d) => d.id === e.id);
    const refMeta = JSON.parse(readFileSync(join(WORK, "ref", `${e.id}.json`), "utf8")) as { ok: boolean } & RefStructure;
    const refText = existsSync(join(WORK, "ref", `${e.id}.txt`)) ? readFileSync(join(WORK, "ref", `${e.id}.txt`), "utf8") : "";
    const outText = a?.error === null && existsSync(join(WORK, "out1", `${e.id}.txt`)) ? readFileSync(join(WORK, "out1", `${e.id}.txt`), "utf8") : null;
    const c = outText === null ? { recall: 0, excess: 0, refTokens: 0, outTokens: 0 } : compare(refText, normalizeOutput(outText));
    const c1 = outText === null ? null : compare(refText, outText);
    results.push({
      id: e.id,
      format: e.format as Format,
      recall: c.recall,
      excess: c.excess,
      hashes: [a?.hash ?? null, b?.hash ?? null],
      manifestPages: a?.pages ?? 0,
      manifestTables: a?.tables ?? 0,
      manifestSections: a?.sections ?? 0,
      ref: { pages: refMeta.pages, tables: refMeta.tables, headings: refMeta.headings, cells: refMeta.cells },
      processFailure: [a, b].some((d) => d?.error && PROCESS_CODES.has(d.error)),
    });
    lines.push(`${e.id} ${String(e.format).padEnd(4)} ${mb(e.size).padStart(5)} Mio  rappel ${(c.recall * 100).toFixed(1).padStart(5)} %  excès ${(c.excess * 100).toFixed(1).padStart(5)} %  (v1 ${c1 ? `${(c1.recall * 100).toFixed(1)} / ${(c1.excess * 100).toFixed(1)}` : "—"})  jetons réf ${String(c.refTokens).padStart(7)}  ${a?.ms ?? "?"} ms  ${a?.error ?? ""}`);
  }
  const v = galleryVerdict(results, p1.robustness ?? null, scope(inv).length);
  console.log(lines.join("\n"));
  console.log(`\nrefusés par la borne (trop gros) : ${tooBig(inv).length} ; hors Q-I3 : ${inv.filter((e) => !e.format).length}`);
  console.log(`robustesse : ${JSON.stringify(p1.robustness)}`);
  console.log(`informatif : ${JSON.stringify(p1.informative)}`);
  console.log(`durée totale passage 1 : ${(p1.docs.reduce((s, d) => s + d.ms, 0) / 1000).toFixed(0)} s ; pic mémoire worker ≈ ${p1.peakRssMb} / ${p2.peakRssMb} Mio`);
  for (const [k, b] of Object.entries(v.bars)) console.log(`barre ${k.padEnd(12)} ${b.ok === null ? "—" : b.ok ? "tenue" : "MANQUÉE"}  ${b.detail}`);
  console.log(`\nVERDICT (sur la référence automatique) : ${v.verdict.toUpperCase()}`);
  writeFileSync(join(WORK, "verdict.json"), JSON.stringify({ v, results }, null, 1));
}

const [mode, arg] = process.argv.slice(2);
if (mode === "prep") await prep();
else if (mode === "pass" && (arg === "1" || arg === "2")) await pass(Number(arg) as 1 | 2);
else if (mode === "verdict") verdict();
else {
  console.error("usage : docling-fidelity.ts prep | pass 1|2 | verdict");
  process.exit(2);
}
process.exit(0);
