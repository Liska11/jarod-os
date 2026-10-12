/**
 * `pnpm gate:p4` — GATE P4 (PLAN §6 ; périmètre validé par l'utilisateur le 2026-09-28, PHASE-4 « Gate P4 ») :
 * contention, reprise après crash, budget, déport NPU (chunks courts, puis chunks longs — forme 512 sur
 * l'iGPU, décision (d) du 2026-09-29), enchaînés sur l'arbre courant.
 *
 * Rapport : `.work/gate-p4/<horodatage>/report.txt` (+ un journal par étape).
 * Code de sortie : 0 = verte ; 1 = au moins une étape rouge ; 3 = aucune rouge mais mesure NPU INVALIDE
 * (écart entre les séries à vide > 5 %) — à relancer, jamais comptée en échec.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICT_FILE, VERDICT_FILE_LONG } from "./p4-npu-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TESTS = join(ROOT, "tests");
const DESKTOP = join(ROOT, "packages", "desktop");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(ROOT, ".work", "gate-p4", stamp);
mkdirSync(OUT, { recursive: true });

type Status = "verte" | "rouge" | "invalide";
interface Step {
  id: string;
  label: string;
  cwd: string;
  commands: string[][];
}

const vitest = (...args: string[]) => [VITEST, "run", ...args];
const STEPS: Step[] = [
  {
    id: "contention",
    label: "contention — SQLite, 2 processus (U3)",
    cwd: TESTS,
    commands: [vitest("--config", "vitest.integration.config.ts", "integration/sqlite-contention.test.ts", "-t", "contention SQLite")],
  },
  {
    id: "reprise-base",
    label: "reprise après crash — base et jobs (U3)",
    cwd: TESTS,
    commands: [vitest("--config", "vitest.integration.config.ts", "integration/sqlite-contention.test.ts", "-t", "reprise après arrêt brutal")],
  },
  {
    id: "reprise-desktop",
    label: "reprise après crash — renderer tué (U3 e2e), processus du mot d'activation tué (Q9)",
    cwd: DESKTOP,
    commands: [
      ["scripts/build.mjs"],
      vitest("--config", "vitest.e2e.config.ts", "test/e2e/recovery.e2e.test.ts", "test/e2e/voice.e2e.test.ts", "-t", "U3 e2e|Q9 :"),
    ],
  },
  { id: "budget", label: "budget — plafond par conversation (G4)", cwd: TESTS, commands: [vitest("gates/p4-budget.test.ts")] },
  { id: "npu", label: "déport NPU — chat llama-server pendant l'indexation NPU", cwd: TESTS, commands: [vitest("gates/p4-npu.test.ts", "-t", "chunks courts")] },
  {
    id: "npu-long",
    label: "déport — chat llama-server pendant l'indexation de chunks longs (forme 512, iGPU)",
    cwd: TESTS,
    commands: [vitest("gates/p4-npu.test.ts", "-t", "chunks longs")],
  },
];

function run(cmd: string[], cwd: string, logFile: string): Promise<number> {
  return new Promise((done) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
    const child = spawn(process.execPath, cmd, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("exit", (code) => {
      writeFileSync(logFile, `$ node ${cmd.join(" ")}\n${out}\n[code ${code}]\n`, { flag: "a" });
      done(code ?? 1);
    });
  });
}

const lines: string[] = [`GATE P4 — ${new Date().toISOString()}`, `arbre : ${ROOT}`, ""];
const say = (l: string) => {
  lines.push(l);
  console.log(`[gate-p4] ${l}`);
};

const results: { step: Step; status: Status; ms: number; note: string }[] = [];
for (const step of STEPS) {
  const t0 = Date.now();
  const logFile = join(OUT, `${step.id}.log`);
  let code = 0;
  for (const cmd of step.commands) {
    code = await run(cmd, step.cwd, logFile);
    if (code !== 0) break;
  }
  let status: Status = code === 0 ? "verte" : "rouge";
  let note = "";
  const verdictFile = step.id === "npu" ? VERDICT_FILE : step.id === "npu-long" ? VERDICT_FILE_LONG : null;
  if (verdictFile) {
    const v = existsSync(verdictFile) ? (JSON.parse(readFileSync(verdictFile, "utf8")) as { at: number; verdict: Status; reasons: string[]; genSlowdown: number; promptSlowdown: number; genDrift: number; promptDrift: number }) : null;
    if (!v || v.at < t0) {
      if (status === "verte") status = "rouge";
      note = "aucun verdict écrit par cette exécution";
    } else {
      if (status === "verte" && v.verdict !== "verte") status = v.verdict;
      const p = (x: number) => `${(x * 100).toFixed(1)} %`;
      note = `génération ${p(v.genSlowdown)}, prompt ${p(v.promptSlowdown)}, écart à vide ${p(v.genDrift)} / ${p(v.promptDrift)}${v.reasons.length ? ` — ${v.reasons.join(" ; ")}` : ""}`;
    }
  }
  const ms = Date.now() - t0;
  results.push({ step, status, ms, note });
  say(`${status.toUpperCase().padEnd(8)} ${step.label} (${(ms / 1000).toFixed(0)} s)${note ? ` — ${note}` : ""}`);
}

const red = results.some((r) => r.status === "rouge");
const invalid = results.some((r) => r.status === "invalide");
say("");
say(red ? "GATE P4 : ROUGE" : invalid ? "GATE P4 : mesure NPU INVALIDE — à relancer (pas un échec)" : "GATE P4 : VERTE");
say(`journaux : ${OUT}`);
writeFileSync(join(OUT, "report.txt"), `${lines.join("\n")}\n`);
process.exit(red ? 1 : invalid ? 3 : 0);
