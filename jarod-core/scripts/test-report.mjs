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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "desktop",
].filter((p) => !only || only.includes(p.split("/").pop()));
const DESKTOP_DIR = resolve(ROOT, "..", "apps", "desktop");
const VITEST_MJS = resolve(ROOT, "..", "node_modules", "vitest", "vitest.mjs");

const outDir = join(tmpdir(), `jarod-test-report-${process.pid}`);
mkdirSync(outDir, { recursive: true });

// Isolation (30/10) : chaque processus vitest tourne avec un « domicile » temporaire et la garde `test-isolation.mjs` (voir ce fichier) ; toute violation
// (profil réel, port réel, port fixe) est journalisée et FAIT ÉCHOUER la mesure, même si le test avait avalé l'exception.
const sandbox = { home: join(outDir, "home"), appdata: join(outDir, "home", "AppData", "Roaming"), local: join(outDir, "home", "AppData", "Local") };
for (const d of Object.values(sandbox)) mkdirSync(d, { recursive: true });
const realHome = homedir();
const guardRoots = [
  "D:/Jarod-OS", "C:/Program Files/Jarod-OS",
  join(process.env.APPDATA ?? join(realHome, "AppData", "Roaming"), "Jarod-OS"), join(process.env.LOCALAPPDATA ?? join(realHome, "AppData", "Local"), "Jarod-OS"),
  join(process.env.LOCALAPPDATA ?? join(realHome, "AppData", "Local"), "hermes"), join(realHome, ".hermes"), join(realHome, ".jarod-os"),
];
const guardLog = join(outDir, "isolation.jsonl");
const guardEnv = {
  JAROD_GUARD_ACTIVE: "1", JAROD_GUARD_REAL_HOME: realHome, JAROD_GUARD_REAL_ENV: JSON.stringify({ USERPROFILE: realHome, HOME: process.env.HOME ?? realHome, APPDATA: process.env.APPDATA ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "" }), JAROD_GUARD_ROOTS: JSON.stringify(guardRoots), JAROD_GUARD_LOG: guardLog, JAROD_GUARD_SANDBOX: JSON.stringify(sandbox),
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(join(ROOT, "scripts", "test-isolation.mjs")).href}`.trim(),
};
const rows = [];
const t0 = Date.now();

/** Lance une commande, attend au plus `limitMs`, puis arrête TOUT l'arbre de processus (Windows : taskkill /T). */
function runLimited(args, limitMs, cwd = ROOT, command = "pnpm", extraEnv = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...guardEnv, ...extraEnv }, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const isDesktop = pkg === "desktop";
  // La parité installation/build COMPARE l'installation à la source : elle lit C:Program FilesJarod-OS par nature. Seul ce dossier est ouvert à ce paquet, en régime lent ; le profil et les données restent protégés.
  const installParity = isDesktop && mode === "slow";
  // Le bureau n'a pas ses propres node_modules : vitest vient de la racine du dépôt (`pnpm exec` tenterait une installation réseau).
  const args = [...(isDesktop ? [VITEST_MJS] : ["--filter", `@jarod/${pkg.startsWith("plugins/") ? `plugin-${name}` : name}`, "exec", "vitest"]), "run", "--reporter=json", `--outputFile=${jsonFile}`, `--testTimeout=${TIMEOUT[mode]}`, `--hookTimeout=${Math.max(30_000, TIMEOUT[mode])}`];
  if (isDesktop) {
    // fenêtres, installation réelle : seuls ces fichiers-là sont « lents » côté bureau ; le reste est rapide
    if (mode === "fast") for (const g of SLOW_GLOBS) args.push("--exclude", `"${g}"`);
    else args.push("os-control", "control-acceptance", "install-parity", "--fileParallelism=false");
  } else if (name === "agent") args.push("--project", mode === "fast" ? "unit" : "engines");
  else if (mode === "fast") for (const g of SLOW_GLOBS) args.push("--exclude", `"${g}"`);
  else args.push("--fileParallelism=false");
  const started = Date.now();
  const run = await runLimited(args, PACKAGE_TIMEOUT_MS[mode], isDesktop ? DESKTOP_DIR : ROOT, isDesktop ? "node" : "pnpm", installParity ? { JAROD_GUARD_ROOTS: JSON.stringify(guardRoots.filter((r) => !/Program Files/i.test(r))) } : {});
  const wall = Date.now() - started;
  let files = [];
  let tests = 0;
  let failed = 0;
  let failures = [];
  try {
    const j = JSON.parse(readFileSync(jsonFile, "utf8"));
    tests = j.numTotalTests ?? 0;
    failed = j.numFailedTests ?? 0;
    failures = (j.testResults ?? []).flatMap((r) => (r.assertionResults ?? []).filter((a) => a.status === "failed").map((a) => `${a.fullName} — ${String(a.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 200)}`));
    files = (j.testResults ?? []).map((r) => ({ file: String(r.name).replace(/^.*[\\/](test|src)[\\/]/, "$1/"), ms: Math.round((r.endTime ?? 0) - (r.startTime ?? 0)) }));
  } catch {
    // pas de JSON : aucun fichier de test dans ce régime, un délai dépassé ou un plantage — dit dans le statut
  }
  const noFiles = /No test files found/i.test(run.out);
  // Le canari du plancher DOIT figurer au rapport lent de l'agent : absent (renommé, exclu), la mesure échoue.
  const canaryMissing = mode === "slow" && name === "agent" && !files.some((f) => f.file.includes("floor-canary.engine.test.ts"));
  const status = run.timedOut ? "DÉLAI DÉPASSÉ" : canaryMissing ? "ÉCHEC" : noFiles ? "aucun fichier dans ce régime" : !files.length && run.status !== 0 ? "ÉCHEC" : failed ? "ÉCHEC" : "ok";
  if (canaryMissing) failures.push("canari du plancher ABSENT du régime lent (floor-canary.engine.test.ts)");
  rows.push({
    package: name,
    wallMs: wall,
    files: files.length,
    tests,
    failed,
    status,
    slowest: [...files].sort((a, b) => b.ms - a.ms).slice(0, 3),
    over5s: mode === "fast" ? files.filter((f) => f.ms > SLOW_THRESHOLD_MS).map((f) => `${f.file} (${f.ms} ms)`) : [],
    ...(failures.length ? { failures } : {}),
    ...(status === "ÉCHEC" || status === "DÉLAI DÉPASSÉ" ? { output: run.out.slice(-1500) } : {}),
  });
  const r = rows.at(-1);
  const mark = status === "ok" ? "✓" : status === "ÉCHEC" || status === "DÉLAI DÉPASSÉ" ? "✗" : "·";
  for (const f of failures.slice(0, 8)) console.log(`    ✗ ${f}`);
  console.log(`${mark} ${name.padEnd(13)} ${String(r.files).padStart(3)} fichiers ${String(r.tests).padStart(5)} tests ${String(failed).padStart(3)} échecs  ${(wall / 1000).toFixed(1).padStart(6)} s  ${status}${r.over5s.length ? `  [> 5 s : ${r.over5s.join(", ")}]` : ""}`);
}

const total = Date.now() - t0;
// Isolation : armée dans combien de processus, et combien de violations ?
const guardLines = existsSync(guardLog) ? readFileSync(guardLog, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
const armed = guardLines.filter((l) => l.kind === "armée").length;
const allow = JSON.parse(readFileSync(join(ROOT, "scripts", "test-isolation.allow.json"), "utf8")).allow;
const attempts = guardLines.filter((l) => !["armée", "sonde", "canari"].includes(l.kind));
const isAllowed = (l) => allow.some((a) => String(l.file ?? "").replaceAll("\\", "/") === a.file && l.kind.startsWith(a.kind));
const blockedKnown = attempts.filter(isAllowed);
const violations = attempts.filter((l) => !isAllowed(l));
const probes = guardLines.filter((l) => l.kind === "sonde");
const canaries = guardLines.filter((l) => l.kind === "canari").length;
const probeDirs = new Set(probes.map((p) => String(p.detail).replace(/[\\/][^\\/]*$/, "")));
console.log(`\nISOLATION : garde armée dans ${armed} processus, ${violations.length} violation(s), ${blockedKnown.length} tentative(s) connue(s) bloquée(s) (liste test-isolation.allow.json), ${canaries} refus voulus du test de la garde, ${probes.length} sonde(s) d'existence dans ${probeDirs.size} dossier(s)`);
for (const v of violations.slice(0, 30)) console.log(`  ✗ ${v.kind} : ${v.detail}  ← ${String(v.stack).slice(0, 220)}`);
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
console.log(`\n${mode.toUpperCase()} : ${sum("files")} fichiers, ${sum("tests")} tests, ${sum("failed")} en échec, ${(total / 1000).toFixed(0)} s au total (délai par test ${TIMEOUT[mode] / 1000} s, par paquet ${PACKAGE_TIMEOUT_MS[mode] / 60000} min)`);
const out = opt("--out");
if (out) writeFileSync(out, JSON.stringify({ mode, isolation: { armedProcesses: armed, violations, knownBlockedAttempts: blockedKnown.length, canaryRefusals: canaries, existenceProbes: probes.length, probedFolders: [...probeDirs] }, timeoutPerTestMs: TIMEOUT[mode], timeoutPerPackageMs: PACKAGE_TIMEOUT_MS[mode], totalMs: total, rows }, null, 2));
rmSync(outDir, { recursive: true, force: true });
process.exit(rows.some((r) => r.status === "ÉCHEC" || r.status === "DÉLAI DÉPASSÉ") || violations.length || !armed ? 1 : 0);
