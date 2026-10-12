/**
 * Bench Q16-chat (INFORMATIF, sans seuil ni verdict) : le LLM de chat — llama-server déjà lancé sur :8080,
 * raisonnement coupé, sortie contrainte par un schéma JSON — décide `intent` + `effect` sur les 60 requêtes
 * FRANÇAISES de `q16-fixtures.ts`, même méthode que le prototype Laya (`q16.ts`) : 3 PROCESSUS NEUFS, même
 * ordre, médiane des processus [plage]. Méthode figée dans DECISIONS (2026-09-29) avant tout run.
 *
 * Ce script ne LIT rien du serveur hormis `/props` et `/slots` (GET) et n'écrit que le rapport
 * `.work/q16/chat-report-<date>.json`. Il ne lance, ne charge ni n'arrête aucun modèle. Machine calme exigée :
 * `Q16_CHAT_CALM=1` (l'opérateur atteste) ET aucun créneau du serveur occupé au départ.
 *
 *   Q16_CHAT_CALM=1 pnpm --filter @jarod/gates bench:q16-chat
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChatCall, chatRequestBody, parseChatResponse, scoreChat } from "./q16-chat-core.js";
import { FIXTURES } from "./q16-fixtures.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = join(ROOT, ".work", "q16");
const BASE = process.env.Q16_CHAT_URL ?? "http://127.0.0.1:8080";
const REPEATS = 3;
const WARMUP = 3;
const CALL_TIMEOUT_MS = 60_000;

interface ServerInfo {
  alias: string | null;
  modelFile: string | null;
  build: string | null;
  slotsBusy: number | null;
}

async function getJson(path: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`${path} : HTTP ${r.status}`);
  return r.json();
}

async function serverInfo(): Promise<ServerInfo> {
  const props = (await getJson("/props")) as { model_alias?: string; model_path?: string; build_info?: string };
  let slotsBusy: number | null = null;
  try {
    const slots = (await getJson("/slots")) as { is_processing?: boolean }[];
    slotsBusy = slots.filter((s) => s.is_processing).length;
  } catch {
    /* /slots désactivé : calme non vérifiable côté serveur, consigné dans le rapport */
  }
  return {
    alias: props.model_alias ?? null,
    modelFile: props.model_path ? basename(props.model_path.replaceAll("\\", "/")) : null,
    build: props.build_info ?? null,
    slotsBusy,
  };
}

async function one(model: string, i: number, request: string): Promise<ChatCall> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequestBody(model, request)),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const clientMs = Math.round((performance.now() - t0) * 100) / 100;
    if (!r.ok) return { i, intent: null, effect: null, clientMs, promptMs: null, predictedMs: null, promptTokens: null, completionTokens: null, reasoningLeak: false, error: `HTTP ${r.status}` };
    return { i, clientMs, ...parseChatResponse(await r.json()) };
  } catch (e) {
    return { i, intent: null, effect: null, clientMs: Math.round((performance.now() - t0) * 100) / 100, promptMs: null, predictedMs: null, promptTokens: null, completionTokens: null, reasoningLeak: false, error: String((e as Error).message).slice(0, 120) };
  }
}

async function worker(out: string): Promise<void> {
  const info = await serverInfo();
  const model = info.alias ?? "default";
  for (let w = 0; w < WARMUP; w++) await one(model, -1, FIXTURES[w]!.fr);
  const calls: ChatCall[] = [];
  for (const [i, f] of FIXTURES.entries()) calls.push(await one(model, i, f.fr));
  writeFileSync(out, JSON.stringify({ pid: process.pid, calls }));
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.ceil(s.length / 2) - 1]! * 100) / 100 : null;
};
const range = (xs: readonly (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return { median: median(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
};

async function main(): Promise<void> {
  if (process.env.Q16_CHAT_CALM !== "1") throw new Error("Machine calme non attestée : Q16_CHAT_CALM=1 requis (mesure de performance, règle de conduite)");
  const info = await serverInfo();
  if (info.slotsBusy !== null && info.slotsBusy > 0) throw new Error(`Serveur occupé (${info.slotsBusy} créneau(x) en traitement) : pas de mesure`);
  mkdirSync(OUT_DIR, { recursive: true });
  const runs = Array.from({ length: REPEATS }, (_, r) => {
    const out = join(OUT_DIR, `chat-worker-${r}.json`);
    console.log(`[q16-chat] processus ${r + 1}/${REPEATS}…`);
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "worker", out], { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT });
    return JSON.parse(readFileSync(out, "utf8")) as { pid: number; calls: ChatCall[] };
  });
  const scores = runs.map((r) => scoreChat(r.calls));
  const ref = runs[0]!.calls;
  const identical = runs.slice(1).map((r) => r.calls.filter((c, k) => c.intent === ref[k]!.intent && c.effect === ref[k]!.effect).length);
  const report = {
    at: new Date().toISOString(),
    method: "DECISIONS 2026-09-29 « Q16 — mesure du LLM de chat » : informatif, sans seuil ni verdict",
    server: info,
    processes: runs.map((r) => r.pid),
    perProcess: scores,
    stability: { statesIdenticalToProcess0: identical, total: ref.length },
    aggregate: {
      intentHits: range(scores.map((s) => s.intentHits)),
      effectHits: range(scores.map((s) => s.effectHits)),
      reminderHits: range(scores.map((s) => s.reminderHits)),
      usable: range(scores.map((s) => s.usable)),
      reasoningLeaks: range(scores.map((s) => s.reasoningLeaks)),
      clientP50Ms: range(scores.map((s) => s.clientMs.p50)),
      clientP95Ms: range(scores.map((s) => s.clientMs.p95)),
      serverPromptP50Ms: range(scores.map((s) => s.promptMs.p50)),
      serverPredictedP50Ms: range(scores.map((s) => s.predictedMs.p50)),
      promptTokensMedian: range(scores.map((s) => s.promptTokensMedian)),
      completionTokensMedian: range(scores.map((s) => s.completionTokensMedian)),
    },
    // Repères déjà consignés (PHASE-4 « Q16 — prototype Laya »), reproduits sans être comparés à un seuil.
    references: { layaEnglishCheckpointIntentFr: "36/60", bgeM3ZeroShotIntentFr: "34/60", majorityEffect: "36/60" },
  };
  const file = join(OUT_DIR, `chat-report-${report.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ server: info, aggregate: report.aggregate, stability: report.stability, confusionProcess0: scores[0]!.confusion }, null, 2));
  console.log(`[q16-chat] rapport → ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, out] = process.argv.slice(2);
  (mode === "worker" ? worker(out!) : main()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
