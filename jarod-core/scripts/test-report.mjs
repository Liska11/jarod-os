// Lance les suites de tests paquet par paquet, en deux régimes, et rend la durée de chaque suite (30/10).
//
//   node scripts/test-report.mjs fast   [--only a,b] [--out fichier.json]   suites RAPIDES : sans moteur ni vrai bureau ; 30 s au plus par test, 6 min au plus par paquet
//   node scripts/test-report.mjs slow   [--only a,b] [--out fichier.json]   suites LENTES  : moteurs, vrai PowerShell, fenêtres ; 120 s par test, 25 min par paquet, un fichier à la fois
//
// Deux délais : par TEST (vitest `--testTimeout`) et par PAQUET (ce script, qui arrête alors tout l'arbre de processus et le dit : un fichier qui se fige ne
// peut plus suspendre la mesure, comme `integrations` le 30/10). « Lente » = un fichier qui pilote une vraie machine (FlaUI, PowerShell, processus,
// ports, navigateur) : la liste est SLOW_GLOBS ; le rapport signale tout fichier rapide qui dépasse 5 s. L'agent a déjà ses projets vitest (unit / engines).
// La sortie s'écrit paquet par paquet (jamais derrière un `| tail`). Code de sortie : 0 si tout passe, 1 sinon.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [mode = "fast", ...rest] = process.argv.slice(2);
if (mode !== "fast" && mode !== "slow") throw new Error("usage : test-report.mjs fast|slow [--only a,b] [--out f.json]");
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const only = opt("--only")?.split(",");

/** Les fichiers qui pilotent une vraie machine : exclus du régime rapide, seuls dans le lent (globs vitest). */
const SLOW_GLOBS = [
  "**/*.engine.test.ts", "**/engines/**", "**/firefox/**", "**/*.real.test.ts",
  "**/os-control*", "**/control-acceptance*", "**/system-destroy*", "**/lot4-everyday*", "**/lot5-mark*", "**/install-parity*",
  "**/browser*.test.ts", "**/connected-browser-*", "**/uia.test.ts", "**/desktop.test.ts", "**/mxc-runner*", "**/child-env-launch*",
];
const TIMEOUT = { fast: 30_000, slow: 120_000 };
const PACKAGE_TIMEOUT_MS = { fast: 6 * 60_000, slow: 25 * 60_000 };
const SLOW_THRESHOLD_MS = 5_000;

const packages = [
  "contracts", "kernel", "bridge", "cli",
  ...["agent", "automation", "embeddings", "gateways", "hyperv", "integrations", "kanban", "llm", "mcp", "memory", "permissions", "persona", "platform", "quarantine", "rag", "scheduler", "skills", "storage", "tools", "updates", "vision", "voice", "workflows", "workspace"].map((p) => `plugins/${p}`),
].filter((p) => !only || only.includes(p.split("/").pop()));

const outDir = join(tmpdir(), `jarod-test-report-${process.pid}`);
mkdirSync(outDir, { recursive: true });
const rows = [];
const t0 = Date.now();

/** Lance une commande, attend au plus `limitMs`, puis arrête TOUT l'arbre de processus (Windows : taskkill /T). */
function runLimited(args, limitMs) {
  return new Promise((done) => {
    const child = spawn("pnpm", args, { cwd: ROOT, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d) => (out = (out + d).slice(-20_000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }, limitMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, timedOut, out });
    });
  });
}

for (const pkg of packages) {
  const name = pkg.split("/").pop();
  const jsonFile = join(outDir, `${name}.json`);
  const args = ["--filter", `@jarod/${pkg.startsWith("plugins/") ? `plugin-${name}` : name}`, "exec", "vitest", "run", "--reporter=json", `--outputFile=${jsonFile}`, `--testTimeout=${TIMEOUT[mode]}`, `--hookTimeout=${Math.max(30_000, TIMEOUT[mode])}`];
  if (name === "agent") args.push("--project", mode === "fast" ? "unit" : "engines");
  else if (mode === "fast") for (const g of SLOW_GLOBS) args.push("--exclude", `"${g}"`);
  else args.push("--fileParallelism=false");
  const started = Date.now();
  const run = await runLimited(args, PACKAGE_TIMEOUT_MS[mode]);
  const wall = Date.now() - started;
  let files = [];
  let tests = 0;
  let failed = 0;
  try {
    const j = JSON.parse(readFileSync(jsonFile, "utf8"));
    tests = j.numTotalTests ?? 0;
    failed = j.numFailedTests ?? 0;
    files = (j.testResults ?? []).map((r) => ({ file: String(r.name).replace(/^.*[\\/](test|src)[\\/]/, "$1/"), ms: Math.round((r.endTime ?? 0) - (r.startTime ?? 0)) }));
  } catch {
    // pas de JSON : aucun fichier de test dans ce régime, un délai dépassé ou un plantage — dit dans le statut
  }
  const noFiles = /No test files found/i.test(run.out);
  const status = run.timedOut ? "DÉLAI DÉPASSÉ" : noFiles ? "aucun fichier dans ce régime" : !files.length && run.status !== 0 ? "ÉCHEC" : failed ? "ÉCHEC" : "ok";
  rows.push({
    package: name,
    wallMs: wall,
    files: files.length,
    tests,
    failed,
    status,
    slowest: [...files].sort((a, b) => b.ms - a.ms).slice(0, 3),
    over5s: mode === "fast" ? files.filter((f) => f.ms > SLOW_THRESHOLD_MS).map((f) => `${f.file} (${f.ms} ms)`) : [],
    ...(status === "ÉCHEC" || status === "DÉLAI DÉPASSÉ" ? { output: run.out.slice(-1500) } : {}),
  });
  const r = rows.at(-1);
  const mark = status === "ok" ? "✓" : status === "ÉCHEC" || status === "DÉLAI DÉPASSÉ" ? "✗" : "·";
  console.log(`${mark} ${name.padEnd(13)} ${String(r.files).padStart(3)} fichiers ${String(r.tests).padStart(5)} tests ${String(failed).padStart(3)} échecs  ${(wall / 1000).toFixed(1).padStart(6)} s  ${status}${r.over5s.length ? `  [> 5 s : ${r.over5s.join(", ")}]` : ""}`);
}

const total = Date.now() - t0;
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
console.log(`\n${mode.toUpperCase()} : ${sum("files")} fichiers, ${sum("tests")} tests, ${sum("failed")} en échec, ${(total / 1000).toFixed(0)} s au total (délai par test ${TIMEOUT[mode] / 1000} s, par paquet ${PACKAGE_TIMEOUT_MS[mode] / 60000} min)`);
const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify({ mode, timeoutPerTestMs: TIMEOUT[mode], timeoutPerPackageMs: PACKAGE_TIMEOUT_MS[mode], totalMs: total, rows }, null, 2));
rmSync(outDir, { recursive: true, force: true });
process.exit(rows.some((r) => r.status === "ÉCHEC" || r.status === "DÉLAI DÉPASSÉ") ? 1 : 0);
