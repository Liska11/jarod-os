/**
 * Mesure de la mémoire causale (SPECS-P5-CAUSAL.md §9 et §10). Règles, porte et barres FIGÉES avant (`causal-frozen.json`), UNE seule mesure.
 *   tsx bench/causal-measure.ts calibrate   calibre la porte de couverture sur l'APPRENTISSAGE seul (coupé au 2026-09-03) : courbe + plus petit c à ≥ 85 % de précision
 *   tsx bench/causal-measure.ts freeze      écrit `causal-frozen.json` (empreintes, effectifs, c, chiffres de contrôle) d'après la calibration
 *   tsx bench/causal-measure.ts measure     LA mesure (refuse un second passage sans --again, refuse si l'état n'est pas celui du gel)
 * État vérifié au départ de la mesure (leçon du 2026-10-02) : copie de state.db = rapport = source ; empreintes des cinq fichiers figés et AUCUNE modification non
 * commitée ; effectifs de l'apprentissage et de l'évaluation ; canari de machinerie ; CONTRÔLE DE FIDÉLITÉ : la calibration est rejouée et doit retrouver
 * exactement les chiffres de contrôle (sans porte) et le même c que ceux figés.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { actionText, calibrate, collectRecords, type Episode, measureAt, type RawMessage, runMeasure } from "./causal-eval.js";
import { CUT_TS, FILES, loadResults, SOURCE_DIR, sha256File, type ToolResult, WORK_DIR } from "./causal-prep.js";
import { type CausalMeasure, causalVerdict } from "./causal-verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FROZEN_PATH = join(HERE, "causal-frozen.json");
const CALIBRATION_PATH = join(WORK_DIR, "calibration.json");
const REPORT_PATH = join(WORK_DIR, "measure-report.json");
const FROZEN_FILES = ["causal-rules.ts", "causal-eval.ts", "causal-verdict.ts", "causal-prep.ts", "causal-measure.ts"] as const;
/** Précision hors cibles visée à la calibration (marge de 5 points sur la barre de 80 %), décision de l'utilisateur 2026-10-02. */
export const PRECISION_TARGET_PERCENT = 85;
/** Coupe INTERNE de la calibration : index jusqu'au 2026-09-03 23:59:59 UTC inclus, requêtes du 04 au 10 septembre. */
export const CALIBRATION_SPLIT_TS = Math.floor(Date.UTC(2026, 8, 3, 23, 59, 59) / 1000);

/** Chiffres du RODAGE du 2026-10-02 (ancien code, index d'échecs seuls, sans porte, coupe interne du 3 septembre) : la machinerie actuelle doit les retrouver à l'unité. */
export const RODAGE_REFERENCE = { targets: 640, baselineHits: 5, systemHits: 175, offTargets: 10672, falseAlarms: 10672 } as const;

export class MeasureStateError extends Error {}

const sha256Text = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

interface Frozen {
  rules: Record<string, string>;
  trainResults: number;
  testResults: number;
  cutTs: number;
  calibrationSplitTs: number;
  precisionTargetPercent: number;
  /** Porte de couverture FIGÉE (pourcentage des termes de la requête qui doivent figurer dans l'épisode proposé). */
  gateCoveragePercent: number;
  /** Chiffres de la calibration SANS porte (c = 0) : contrôle de fidélité à retrouver exactement. */
  controls: CausalMeasure;
  calibrationSha256: string;
}

function readUsers(): Map<string, { ts: number; content: string }[]> {
  const db = new Database(join(WORK_DIR, "state.db"), { readonly: true });
  try {
    const out = new Map<string, { ts: number; content: string }[]>();
    for (const r of db.prepare("SELECT session_id, timestamp, content FROM messages WHERE role = 'user' AND content IS NOT NULL ORDER BY session_id, timestamp").all() as { session_id: string; timestamp: number; content: string }[]) {
      const l = out.get(r.session_id) ?? [];
      l.push({ ts: r.timestamp, content: r.content });
      out.set(r.session_id, l);
    }
    return out;
  } finally {
    db.close();
  }
}

/** Épisodes (résultats classés, hors indéterminés) avec leur situation (dernier message de l'utilisateur avant l'appel) et leur action. */
function toEpisodes(results: ToolResult[], users: Map<string, { ts: number; content: string }[]>): Episode[] {
  const situationOf = (sessionId: string, ts: number): string => {
    const list = users.get(sessionId);
    if (!list) return "";
    let lo = 0;
    let hi = list.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.ts <= ts) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best >= 0 ? list[best]!.content.slice(0, 500) : "";
  };
  return results
    .filter((r) => r.outcome.kind !== "indetermine")
    .map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      tool: r.tool,
      situation: situationOf(r.sessionId, r.ts),
      action: actionText(r.tool, r.args),
      kind: r.outcome.kind === "echec" ? ("echec" as const) : ("succes" as const),
      text: r.outcome.text,
      signature: r.signature,
    }));
}

function readMessages(failureByResultId: Map<string, Episode>, maxTs: number): RawMessage[] {
  const db = new Database(join(WORK_DIR, "state.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT id, session_id, role, content FROM messages WHERE timestamp <= ? AND role IN ('user','assistant','tool') AND content IS NOT NULL AND content <> ''").all(maxTs) as { id: string; session_id: string; role: string; content: string }[];
    return rows.map((r) => {
      const f = r.role === "tool" ? failureByResultId.get(r.id) : undefined;
      return { id: r.id, sessionId: r.session_id, role: r.role, content: r.content, ...(f ? { failureOf: f } : {}) };
    });
  } finally {
    db.close();
  }
}

/** Collecte pour une fenêtre : index = résultats d'apprentissage ≤ `indexUntil` ; requêtes = `queries`. */
function collectWindow(trainAll: ToolResult[], indexUntil: number, queries: ToolResult[], users: Map<string, { ts: number; content: string }[]>) {
  const index = toEpisodes(trainAll.filter((r) => r.ts <= indexUntil), users);
  const failureByResultId = new Map(index.filter((e) => e.kind === "echec" && e.text !== "").map((e) => [e.id, e]));
  const msgs = readMessages(failureByResultId, indexUntil);
  return collectRecords({ train: index, test: toEpisodes(queries, users), trainMessages: msgs, indexMode: "failures" });
}

async function checkState(label: string, strict: boolean): Promise<Frozen | null> {
  // 1. La copie est celle du rapport ET la source n'a pas bougé.
  const report = JSON.parse(readFileSync(join(WORK_DIR, "copy-report.json"), "utf8")) as { files: Record<string, { sourceSha256: string; copySha256: string }> };
  for (const f of FILES) {
    const r = report.files[f];
    if (!r) continue;
    if ((await sha256File(join(WORK_DIR, f))) !== r.copySha256) throw new MeasureStateError(`[${label}] ${f} : la copie a changé depuis le rapport`);
    if (existsSync(join(SOURCE_DIR, f)) && f !== "state.db-shm" && (await sha256File(join(SOURCE_DIR, f))) !== r.sourceSha256)
      throw new MeasureStateError(`[${label}] ${f} : la source a changé depuis la copie`);
  }
  // 2. Règles, machinerie, verdict et chargement = empreintes figées, et rien de modifié ou non commité.
  let frozen: Frozen | null = null;
  if (strict) {
    frozen = JSON.parse(readFileSync(FROZEN_PATH, "utf8")) as Frozen;
    for (const f of FROZEN_FILES) {
      const now = sha256Text(join(HERE, f));
      if (now !== frozen.rules[f]) throw new MeasureStateError(`[${label}] ${f} : empreinte ${now.slice(0, 12)} ≠ figée ${String(frozen.rules[f]).slice(0, 12)}`);
    }
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...FROZEN_FILES.map((f) => join(HERE, f)), FROZEN_PATH], { encoding: "utf8" }).trim();
    if (dirty) throw new MeasureStateError(`[${label}] fichiers figés modifiés ou non commités :\n${dirty}`);
    if (!existsSync(CALIBRATION_PATH) || sha256Text(CALIBRATION_PATH) !== frozen.calibrationSha256) throw new MeasureStateError(`[${label}] calibration.json absent ou modifié depuis le gel`);
  }
  // 3. Canari de machinerie : un cas connu doit être retrouvé.
  const mk = (o: Partial<Episode> & Pick<Episode, "id" | "sessionId">): Episode => ({ tool: "ssh", situation: "", action: "", kind: "succes", text: "", signature: null, ...o });
  const canary = runMeasure({
    train: [mk({ id: "c1", sessionId: "A", situation: "deployer le service canari", action: "ssh deploy canari", kind: "echec", text: "permission denied", signature: "ssh|permission denied" })],
    test: [mk({ id: "c2", sessionId: "B", situation: "relancer le deploiement du service canari", action: "ssh deploy canari", kind: "echec", text: "permission denied", signature: "ssh|permission denied" })],
    trainMessages: [],
  });
  if (canary.measure.targets !== 1 || canary.measure.systemHits !== 1) throw new MeasureStateError(`[${label}] canari de machinerie raté : ${JSON.stringify(canary.measure)}`);
  return frozen;
}

/** Calibration sur l'apprentissage seul. Rend les chiffres sans porte, la courbe et le choix de c. */
function calibrateOnTraining(train: ToolResult[], users: Map<string, { ts: number; content: string }[]>) {
  const { records, details } = collectWindow(train, CALIBRATION_SPLIT_TS, train.filter((r) => r.ts > CALIBRATION_SPLIT_TS), users);
  return { details, controls: measureAt(records, 0), ...calibrate(records, PRECISION_TARGET_PERCENT) };
}

async function calibrateCmd(): Promise<void> {
  await checkState("calibration", false);
  const train = loadResults("train");
  const t0 = Date.now();
  const cal = calibrateOnTraining(train, readUsers());
  for (const k of Object.keys(RODAGE_REFERENCE) as (keyof typeof RODAGE_REFERENCE)[])
    if (cal.controls[k] !== RODAGE_REFERENCE[k]) throw new MeasureStateError(`contrôle de fidélité raté : ${k} = ${cal.controls[k]} au lieu de ${RODAGE_REFERENCE[k]} (rodage du 2026-10-02)`);
  console.log("contrôle de fidélité OK : la machinerie retrouve le rodage (640 / 5 / 175 / 10 672 / 10 672)");
  const out = {
    at: new Date().toISOString(),
    split: "index ≤ 2026-09-03 23:59:59 UTC ; requêtes 2026-09-04 → 2026-09-10 (apprentissage seul, aucun chiffre d'évaluation)",
    precisionTargetPercent: PRECISION_TARGET_PERCENT,
    seconds: Math.round((Date.now() - t0) / 1000),
    controls: cal.controls,
    details: cal.details,
    chosenPercent: cal.chosenPercent,
    curve: cal.curve,
  };
  writeFileSync(CALIBRATION_PATH, JSON.stringify(out, null, 1));
  console.log("sans porte (c = 0) :", JSON.stringify(cal.controls));
  console.log(`c choisi : ${cal.chosenPercent === null ? "AUCUN (précision visée inatteignable)" : `${cal.chosenPercent} %`}`);
  for (const p of cal.curve.filter((x) => x.c % 5 === 0)) console.log(`  c=${String(p.c).padStart(3)} %  rappel ${String(p.recallPercent).padStart(5)} %  précision ${String(p.precisionPercent).padStart(5)} %`);
  console.log(`écrit : ${CALIBRATION_PATH}`);
  if (cal.chosenPercent === null) process.exit(1);
}

/** Écrit `causal-frozen.json` : empreintes des fichiers, effectifs (comptés, sans les regarder), c et chiffres de contrôle de la calibration. */
function freezeCmd(): void {
  const cal = JSON.parse(readFileSync(CALIBRATION_PATH, "utf8")) as { chosenPercent: number | null; controls: CausalMeasure };
  if (cal.chosenPercent === null) throw new MeasureStateError("calibration sans c : rien à figer");
  const frozen: Frozen = {
    rules: Object.fromEntries(FROZEN_FILES.map((f) => [f, sha256Text(join(HERE, f))])),
    trainResults: loadResults("train").length,
    testResults: loadResults("test").length,
    cutTs: CUT_TS,
    calibrationSplitTs: CALIBRATION_SPLIT_TS,
    precisionTargetPercent: PRECISION_TARGET_PERCENT,
    gateCoveragePercent: cal.chosenPercent,
    controls: cal.controls,
    calibrationSha256: sha256Text(CALIBRATION_PATH),
  };
  writeFileSync(FROZEN_PATH, `${JSON.stringify(frozen, null, 1)}\n`);
  console.log(`figé : c = ${frozen.gateCoveragePercent} %, ${frozen.trainResults} résultats d'apprentissage, ${frozen.testResults} d'évaluation (comptes seulement)`);
}

async function measureCmd(again: boolean): Promise<void> {
  if (existsSync(REPORT_PATH) && !again) throw new MeasureStateError(`une mesure existe déjà (${REPORT_PATH}) : UNE seule mesure (--again pour la refaire, à dire)`);
  const frozen = (await checkState("mesure", true)) as Frozen;
  const train = loadResults("train");
  const test = loadResults("test");
  if (train.length !== frozen.trainResults || test.length !== frozen.testResults) throw new MeasureStateError(`effectifs ${train.length}/${test.length} ≠ figés ${frozen.trainResults}/${frozen.testResults}`);
  const users = readUsers();
  const t0 = Date.now();
  // Contrôle de fidélité : la calibration rejouée retrouve EXACTEMENT les chiffres sans porte et le même c que ceux figés.
  const cal = calibrateOnTraining(train, users);
  const same = (a: CausalMeasure, b: CausalMeasure) => (Object.keys(b) as (keyof CausalMeasure)[]).every((k) => a[k] === b[k]);
  if (!same(cal.controls, frozen.controls)) throw new MeasureStateError(`contrôle de fidélité raté : ${JSON.stringify(cal.controls)} ≠ ${JSON.stringify(frozen.controls)}`);
  if (cal.chosenPercent !== frozen.gateCoveragePercent) throw new MeasureStateError(`contrôle de fidélité raté : c rejoué ${String(cal.chosenPercent)} ≠ figé ${frozen.gateCoveragePercent}`);
  console.log(`contrôle de fidélité OK (sans porte ${JSON.stringify(cal.controls)} ; c = ${cal.chosenPercent} %)`);

  const { records, details } = collectWindow(train, CUT_TS, test, users);
  const measure = measureAt(records, frozen.gateCoveragePercent);
  const verdict = causalVerdict(measure);
  const WARN = /\[Tool loop warning:/;
  const testCurve = calibrate(records, frozen.precisionTargetPercent).curve; // INFORMATIF : la porte utilisée est celle figée
  const out = {
    at: new Date().toISOString(),
    again,
    frozen,
    seconds: Math.round((Date.now() - t0) / 1000),
    gateUsedPercent: frozen.gateCoveragePercent,
    measure,
    verdict,
    details,
    withoutGate: measureAt(records, 0),
    baselineFalseAlarms: records.offTargets.filter((o) => o.baselineAlarm).length,
    byTool: Object.fromEntries(
      [...new Set(records.targets.map((t) => t.tool))].map((tool) => {
        const ts = records.targets.filter((t) => t.tool === tool);
        return [tool, { targets: ts.length, baselineHits: ts.filter((t) => t.baselineHit).length, systemHits: ts.filter((t) => t.hitCoverage !== null && t.hitCoverage.num * 100 >= frozen.gateCoveragePercent * t.hitCoverage.den).length }];
      }),
    ),
    loopWarningsAfterCut: test.filter((x) => WARN.test(x.content)).length,
    testCurve,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ gate: frozen.gateCoveragePercent, measure, verdict }, null, 1));
  console.log(`rapport : ${REPORT_PATH}`);
}

const cmd = process.argv[2];
if (process.argv[1]?.endsWith("causal-measure.ts")) {
  const fail = (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  };
  if (cmd === "calibrate") calibrateCmd().catch(fail);
  else if (cmd === "freeze") {
    try {
      freezeCmd();
    } catch (e) {
      fail(e);
    }
  } else if (cmd === "measure") measureCmd(process.argv.includes("--again")).catch(fail);
  else console.error("usage : causal-measure.ts calibrate | freeze | measure [--again]");
}
