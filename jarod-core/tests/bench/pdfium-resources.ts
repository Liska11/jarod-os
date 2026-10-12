/**
 * Banc du worker pdfium (DECISIONS 2026-09-30, option b) : déterminisme, pages, ressources, robustesse sur les PDF du corpus.
 * Barres FIGÉES avant la mesure (voir DECISIONS) :
 *   (1) déterminisme : deux passages en processus neufs ⇒ même empreinte SHA-256 de {manifeste, texte} pour 100 % des PDF ;
 *   (2) pages : `manifest.pages` = nombre de pages de pdfium, exactement ;
 *   (3) durée : ≤ 30 s par PDF ; (4) mémoire : pic du worker ≤ 1 Gio ;
 *   (5) robustesse : 0 échec de PROCESSUS, 0 processus du worker après l'arrêt.
 * Le texte n'est pas jugé contre une référence indépendante (même moteur) : il l'est par le test unitaire du filtre « dans la page ».
 * Usage : tsx bench/pdfium-resources.ts pass 1|2  |  verdict. Sorties : .work/pdfium-res/. Seuls des identifiants anonymes sont imprimés.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WorkerParser } from "@jarod/plugin-rag";

const sh = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "scripts", "corpus");
const WORK = join(ROOT, ".work", "pdfium-res");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const WORKER = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
export const BARS = { maxSeconds: 30, maxRssMiB: 1024 };

const pdfs = () =>
  readdirSync(CORPUS)
    .filter((f) => extname(f).toLowerCase() === ".pdf")
    .sort((a, b) => a.localeCompare(b))
    .map((file, i) => ({ id: `D${String(i + 1).padStart(2, "0")}`, path: join(CORPUS, file), size: statSync(join(CORPUS, file)).size }));

async function workerProcesses(): Promise<{ count: number; rss: number }> {
  const ps = `$p = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*pdfium-worker.py*' }); "$($p.Count) $(($p | Measure-Object WorkingSetSize -Sum).Sum)"`;
  const { stdout } = await sh("powershell", ["-NoProfile", "-Command", ps]);
  const [count, rss] = stdout.trim().split(/\s+/).map(Number);
  return { count: count ?? 0, rss: rss ?? 0 };
}

interface Rec {
  id: string;
  mb: number;
  ms: number;
  error: string | null;
  hash: string | null;
  pages: number;
  chars: number;
  pagesWithoutText: number;
}

async function pass(n: 1 | 2): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const before = await workerProcesses();
  const p = new WorkerParser({ name: "pdfium", command: PYTHON, args: [WORKER], extensions: [".pdf"], allowPath: () => false, timeoutMs: 120_000, startTimeoutMs: 60_000, maxBytes: 100 * 1024 * 1024, threads: 1 });
  let peak = 0;
  const timer = setInterval(() => void workerProcesses().then((v) => (peak = Math.max(peak, v.rss))).catch(() => {}), 500);
  const recs: Rec[] = [];
  for (const e of pdfs()) {
    const t0 = Date.now();
    try {
      const r = await p.parse({ bytes: readFileSync(e.path), name: e.path });
      recs.push({ id: e.id, mb: e.size / 1048576, ms: Date.now() - t0, error: null, hash: createHash("sha256").update(`${JSON.stringify(r.manifest)}\n${r.text}`).digest("hex"), pages: r.manifest.pages ?? 0, chars: r.text.length, pagesWithoutText: r.manifest.errors.filter((x) => x.code === "PAGE_WITHOUT_TEXT").length });
    } catch (err) {
      recs.push({ id: e.id, mb: e.size / 1048576, ms: Date.now() - t0, error: (err as { code?: string }).code ?? (err as Error).name, hash: null, pages: 0, chars: 0, pagesWithoutText: 0 });
    }
  }
  clearInterval(timer);
  await p.close();
  await new Promise((r) => setTimeout(r, 1500));
  const after = await workerProcesses();
  writeFileSync(join(WORK, `pass${n}.json`), JSON.stringify({ recs, peakRssMiB: Math.round(peak / 1048576), orphans: Math.max(0, after.count - before.count) }, null, 1));
  console.log(`passage ${n} : ${recs.length} PDF, pic mémoire ≈ ${Math.round(peak / 1048576)} Mio, orphelins ${Math.max(0, after.count - before.count)}`);
}

async function verdict(): Promise<void> {
  const a = JSON.parse(readFileSync(join(WORK, "pass1.json"), "utf8")) as { recs: Rec[]; peakRssMiB: number; orphans: number };
  const b = JSON.parse(readFileSync(join(WORK, "pass2.json"), "utf8")) as { recs: Rec[]; peakRssMiB: number; orphans: number };
  // Nombre de pages de référence : pdfium lui-même (interpréteur du venv), lu hors du worker.
  const py = `import sys,json,pypdfium2 as p;print(json.dumps([len(p.PdfDocument(x)) for x in sys.argv[1:]]))`;
  const refPages = JSON.parse((await sh(PYTHON, ["-c", py, ...pdfs().map((e) => e.path)])).stdout) as number[];
  const lines: string[] = [];
  const bad = { det: [] as string[], pages: [] as string[], slow: [] as string[], fail: [] as string[] };
  a.recs.forEach((r, i) => {
    const r2 = b.recs[i]!;
    if (r.hash === null || r.hash !== r2.hash) bad.det.push(r.id);
    if (r.pages !== refPages[i]) bad.pages.push(r.id);
    if (Math.max(r.ms, r2.ms) > BARS.maxSeconds * 1000) bad.slow.push(r.id);
    if (r.error || r2.error) bad.fail.push(r.id);
    lines.push(`${r.id} ${r.mb.toFixed(1).padStart(5)} Mio  ${String(r.pages).padStart(4)} p (réf ${refPages[i]})  ${String(r.ms).padStart(6)} / ${String(r2.ms).padStart(6)} ms  ${String(r.chars).padStart(8)} car.  pages sans texte ${r.pagesWithoutText}  ${r.error ?? ""}`);
  });
  const rss = Math.max(a.peakRssMiB, b.peakRssMiB);
  const checks: [string, boolean, string][] = [
    ["déterminisme", bad.det.length === 0, `différents/absents : ${bad.det.join(", ") || "aucun"}`],
    ["pages", bad.pages.length === 0, `≠ pdfium : ${bad.pages.join(", ") || "aucun"}`],
    ["durée ≤ 30 s", bad.slow.length === 0, `trop longs : ${bad.slow.join(", ") || "aucun"}`],
    ["mémoire ≤ 1 Gio", rss <= BARS.maxRssMiB, `pic ≈ ${rss} Mio`],
    ["robustesse", bad.fail.length === 0 && a.orphans === 0 && b.orphans === 0, `échecs : ${bad.fail.join(", ") || "aucun"} ; orphelins ${a.orphans}/${b.orphans}`],
  ];
  console.log(lines.join("\n"));
  for (const [name, ok, detail] of checks) console.log(`barre ${name.padEnd(16)} ${ok ? "tenue" : "MANQUÉE"}  ${detail}`);
  console.log(`\nVERDICT : ${checks.every(([, ok]) => ok) ? "VERTE" : "ROUGE"}`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "pass" && (arg === "1" || arg === "2")) await pass(Number(arg) as 1 | 2);
else if (mode === "verdict") await verdict();
else {
  console.error("usage : pdfium-resources.ts pass 1|2 | verdict");
  process.exit(2);
}
process.exit(0);
