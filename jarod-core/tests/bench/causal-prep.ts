/**
 * Préparation de la mesure de la mémoire causale (SPECS-P5-CAUSAL.md §9). LECTURE SEULE sur la source.
 *   tsx bench/causal-prep.ts copy      copie de `backup-hermes/state.db` (+ `-wal`, `-shm`) dans `.work/causal/`, SHA-256 source = copie vérifié
 *   tsx bench/causal-prep.ts samples   40 résultats d'outils + 40 paires de signatures à faire valider (apprentissage seulement) → `.work/causal/validation-40-40.md`
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "@jarod/kernel/redact";
import Database from "better-sqlite3-multiple-ciphers";
import { classifyResult, mulberry32, normalizeText, type Outcome, signatureOf } from "./causal-rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const SOURCE_DIR = join(ROOT, "backup-hermes");
export const WORK_DIR = join(ROOT, ".work", "causal");
export const FILES = ["state.db", "state.db-wal", "state.db-shm"] as const;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function copy(): Promise<void> {
  mkdirSync(WORK_DIR, { recursive: true });
  const report: Record<string, { bytes: number; sourceSha256: string; copySha256: string }> = {};
  for (const f of FILES) {
    const src = join(SOURCE_DIR, f);
    if (!existsSync(src)) {
      console.log(`${f} : absent de la source (ignoré)`);
      continue;
    }
    const before = await sha256File(src);
    const dest = join(WORK_DIR, f);
    copyFileSync(src, dest);
    const after = await sha256File(dest);
    const stillSource = await sha256File(src);
    if (before !== after || before !== stillSource) throw new Error(`${f} : hash différent (source ${before.slice(0, 12)}, copie ${after.slice(0, 12)}, source relue ${stillSource.slice(0, 12)}) — copie REFUSÉE`);
    report[f] = { bytes: statSync(dest).size, sourceSha256: before, copySha256: after };
    console.log(`${f} : ${statSync(dest).size} octets, SHA-256 ${before.slice(0, 16)}… identique source/copie`);
  }
  writeFileSync(join(WORK_DIR, "copy-report.json"), JSON.stringify({ at: new Date().toISOString(), files: report }, null, 1));
}

/** Coupe STRICTE (SPECS-P5-CAUSAL.md §9) : apprentissage = horodatage ≤ 2026-09-10 23:59:59 UTC (inclus) ; évaluation = strictement après. */
export const CUT_TS = Math.floor(Date.UTC(2026, 8, 10, 23, 59, 59) / 1000);

export interface ToolResult {
  id: string;
  sessionId: string;
  callId: string;
  tool: string | null;
  content: string;
  ts: number;
  args: string;
  outcome: Outcome;
  signature: string | null;
}

/** Résultats d'outils de la COPIE, avec l'appel correspondant (arguments) ; `train` = jusqu'à la coupe incluse. Lecture seule. */
export function loadResults(which: "train" | "test"): ToolResult[] {
  const db = new Database(join(WORK_DIR, "state.db"), { readonly: true });
  try {
    const cmp = which === "train" ? "<=" : ">";
    const calls = new Map<string, { name: string; args: string }>();
    for (const r of db.prepare("SELECT tool_calls FROM messages WHERE tool_calls IS NOT NULL AND tool_calls <> ''").all() as { tool_calls: string }[]) {
      try {
        for (const c of JSON.parse(r.tool_calls) as { id?: string; call_id?: string; function?: { name?: string; arguments?: string } }[]) {
          const entry = { name: c.function?.name ?? "", args: c.function?.arguments ?? "" };
          if (c.id) calls.set(c.id, entry);
          if (c.call_id) calls.set(c.call_id, entry);
        }
      } catch {
        /* appel illisible : ignoré */
      }
    }
    const rows = db
      .prepare(`SELECT id, session_id, tool_call_id, tool_name, content, timestamp FROM messages WHERE role = 'tool' AND timestamp ${cmp} ? ORDER BY timestamp, id`)
      .all(CUT_TS) as { id: string; session_id: string; tool_call_id: string; tool_name: string | null; content: string; timestamp: number }[];
    return rows.map((r) => {
      const call = calls.get(r.tool_call_id);
      const tool = r.tool_name ?? (call?.name || null);
      const outcome = classifyResult(tool, r.content);
      return {
        id: r.id,
        sessionId: r.session_id,
        callId: r.tool_call_id,
        tool,
        content: r.content,
        ts: r.timestamp,
        args: call?.args ?? "",
        outcome,
        signature: outcome.kind === "echec" ? signatureOf(tool, outcome) : null,
      };
    });
  } finally {
    db.close();
  }
}

const show = (s: string, n = 170): string => redactText(s).replace(/\s+/g, " ").trim().slice(0, n).replace(/\|/g, "\\|");

/** Tirage sans remise déterministe (Fisher-Yates partiel). */
function draw<T>(items: T[], k: number, rng: () => number): T[] {
  const a = items.slice();
  const out: T[] = [];
  for (let i = 0; i < Math.min(k, a.length); i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
    out.push(a[i]!);
  }
  return out;
}

const tokens = (s: string) => new Set(normalizeText(s).split(/[^a-zà-ÿ<>#]+/).filter((w) => w.length > 1));
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/** 40 résultats tirés au hasard + 40 paires de signatures, UNIQUEMENT dans l'apprentissage (le jeu d'évaluation n'est pas regardé). */
function samples(): void {
  const train = loadResults("train");
  const stats = new Map<string, { n: number; echec: number; succes: number; indet: number }>();
  for (const r of train) {
    const k = r.tool ?? "?";
    const s = stats.get(k) ?? { n: 0, echec: 0, succes: 0, indet: 0 };
    s.n++;
    if (r.outcome.kind === "echec") s.echec++;
    else if (r.outcome.kind === "succes") s.succes++;
    else s.indet++;
    stats.set(k, s);
  }
  const tot = {
    n: train.length,
    echec: train.filter((r) => r.outcome.kind === "echec").length,
    succes: train.filter((r) => r.outcome.kind === "succes").length,
    indet: train.filter((r) => r.outcome.kind === "indetermine").length,
  };
  const fails = train.filter((r) => r.outcome.kind === "echec");
  const bySig = new Map<string, ToolResult[]>();
  for (const r of fails) bySig.set(r.signature!, [...(bySig.get(r.signature!) ?? []), r]);
  // Limite structurelle : succès (code 0) dont le texte contient pourtant une trace d'erreur — information donnée à l'utilisateur, pas une règle.
  const suspect = train.filter((r) => r.outcome.kind === "succes" && /traceback|# fail [1-9]|\bFAIL\b|command not found|no such file/i.test(r.content)).length;

  const rng = mulberry32(20261002);
  const sample = draw(train, 40, rng);

  const sameCandidates = [...bySig.entries()].filter(([, v]) => v.length >= 2);
  const samePairs = draw(sameCandidates, 20, rng).map(([sig, v]) => {
    const [a, b] = draw(v, 2, rng) as [ToolResult, ToolResult];
    return { kind: "meme-signature" as const, sig, a, b };
  });
  const diffPairs: { kind: "signature-differente"; sig: string; a: ToolResult; b: ToolResult }[] = [];
  for (const a of draw(fails.filter((r) => r.outcome.text !== ""), 20, rng)) {
    const pool = draw(fails.filter((r) => r.tool === a.tool && r.signature !== a.signature && r.outcome.text !== ""), 300, rng);
    const ta = tokens(a.outcome.text);
    const best = pool.map((b) => ({ b, j: jaccard(ta, tokens(b.outcome.text)) })).sort((x, y) => y.j - x.j)[0];
    if (best) diffPairs.push({ kind: "signature-differente", sig: `${a.signature} ≠ ${best.b.signature}`, a, b: best.b });
  }
  const pairs = draw([...samePairs, ...diffPairs], 40, rng);

  const md: string[] = [];
  md.push("# Validation 40 + 40 — mémoire causale (SPECS-P5-CAUSAL.md §4)", "");
  md.push("Données : apprentissage seulement (horodatage ≤ 2026-09-10 23:59:59 UTC), copie de `state.db` au hash vérifié. Le jeu d'évaluation n'a pas été regardé. Tirage : graine 20261002.", "");
  md.push("## Règle d'échec proposée (R1) — signaux STRUCTURELS seulement", "");
  md.push(
    "- **échec** : `exit_code` ≠ 0, ou champ `error` non vide, ou `success: false`, ou `status` ∈ {error, failed, timeout} ;",
    "- **succès** : tout autre objet JSON (code 0, `success: true`, ou simplement aucun signal d'échec : lecture, écriture, recherche, liste de tâches ne signalent que leurs échecs) ;",
    "- **indéterminé (EXCLU de la mesure)** : ce qui n'est pas un objet JSON (texte libre, tableaux, page web) et `status: killed` (arrêt peut-être voulu).",
    "",
  );
  md.push(
    `**Limite assumée** : un test qui échoue derrière un tube (\`| tail\`) rend le code 0, donc « succès ». Sur l'apprentissage, ${suspect} résultats classés « succès » contiennent pourtant une trace du type Traceback / « # fail » / FAIL / « command not found » / « no such file ».`,
    "",
  );
  md.push(`Répartition dans l'apprentissage : ${tot.n} résultats d'outils → ${tot.echec} échecs, ${tot.succes} succès, ${tot.indet} indéterminés ; ${bySig.size} signatures d'échec distinctes, dont ${sameCandidates.length} vues au moins deux fois.`, "");
  md.push(
    "## Règle de signature proposée",
    "",
    "Signature = nom de l'outil + 60 premiers caractères du texte d'échec NORMALISÉ (texte d'échec = champ `error`, sinon première ligne non vide de `output`). Normalisation : minuscules, URL → `<url>`, chemins → `<chemin>`, hexadécimaux ≥ 8 → `<hex>`, nombres → `#`, espaces repliés ; texte vide → `outil|exit=N` (ou `<vide>`).",
    "",
  );
  md.push("## Partie 1 — 40 résultats d'outils tirés au hasard", "", "Pour chacun : la règle R1 a-t-elle raison ? Répondre `ok` ou la classe correcte (échec / succès / indéterminé).", "");
  md.push("| n | outil | verdict R1 | signal | contenu (tronqué, expurgé) |", "|---|---|---|---|---|");
  sample.forEach((r, i) => { md.push(`| ${i + 1} | ${r.tool ?? "?"} | **${r.outcome.kind}** | ${r.outcome.reason} | ${show(r.content)} |`); });
  md.push("", "## Partie 2 — 40 paires de signatures (20 « même » et 20 « différente » choisies parmi les plus proches, mélangées)", "", "Pour chacune : même CAUSE d'échec (oui/non) ? La règle de signature a-t-elle raison ? Répondre `ok` ou `faux`.", "");
  md.push("| n | outil | verdict signature | texte A (normalisé) | texte B (normalisé) |", "|---|---|---|---|---|");
  const shownText = (r: ToolResult) => show(normalizeText(r.outcome.text) || `(vide, exit ${String(r.outcome.exit)})`, 90);
  pairs.forEach((p, i) => { md.push(`| ${i + 1} | ${p.a.tool ?? "?"} | **${p.kind === "meme-signature" ? "même" : "différente"}** | ${shownText(p.a)} | ${shownText(p.b)} |`); });
  md.push("", "## Annexe — répartition par outil (apprentissage, 12 premiers)", "", "| outil | résultats | échecs | succès | indéterminés |", "|---|---|---|---|---|");
  for (const [k, s] of [...stats.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) md.push(`| ${k} | ${s.n} | ${s.echec} | ${s.succes} | ${s.indet} |`);
  writeFileSync(join(WORK_DIR, "validation-40-40.md"), `${md.join("\n")}\n`);
  writeFileSync(
    join(WORK_DIR, "validation-40-40.json"),
    JSON.stringify({ seed: 20261002, cutTs: CUT_TS, sample: sample.map((r) => ({ id: r.id, kind: r.outcome.kind })), pairs: pairs.map((p) => ({ kind: p.kind, a: p.a.id, b: p.b.id, sig: p.sig })) }, null, 1),
  );
  console.log(`apprentissage : ${tot.n} résultats (${tot.echec} échecs, ${tot.succes} succès, ${tot.indet} indéterminés) ; ${bySig.size} signatures distinctes, ${sameCandidates.length} vues ≥ 2 fois ; succès « suspects » : ${suspect}`);
  console.log(`écrit : ${join(WORK_DIR, "validation-40-40.md")}`);
}

interface Round1 {
  seed: number;
  cutTs: number;
  sample: { id: string; kind: string }[];
  pairs: { kind: "meme-signature" | "signature-differente"; a: string; b: string; sig: string }[];
}

/** Rejoue avec les règles ACTUELLES les 40 + 40 déjà validés (`round1/validation-40-40.json`) : mêmes ids, nouveaux verdicts ; liste ce qui a changé. */
function replay(): void {
  const r1: Round1 = JSON.parse(readFileSync(join(WORK_DIR, "round1", "validation-40-40.json"), "utf8"));
  const byId = new Map(loadResults("train").map((r) => [r.id, r]));
  const md: string[] = ["# Revalidation — règles corrigées (bugs de normalisation et d'extraction)", ""];
  const kindChanged = r1.sample.flatMap((s, i) => {
    const now = byId.get(s.id)!.outcome.kind;
    return now === s.kind ? [] : [`partie 1, n° ${i + 1} : ${s.kind} → ${now}`];
  });
  md.push(`Partie 1 : ${r1.sample.length - kindChanged.length}/${r1.sample.length} verdicts INCHANGÉS${kindChanged.length ? ` ; changés : ${kindChanged.join(" ; ")}` : ""}.`, "");
  const rows: string[] = [];
  const changed: number[] = [];
  r1.pairs.forEach((p, i) => {
    const a = byId.get(p.a)!;
    const b = byId.get(p.b)!;
    const before = p.kind === "meme-signature" ? "même" : "différente";
    const nowSame = a.signature !== null && a.signature === b.signature;
    const now = nowSame ? "même" : "différente";
    if (before !== now) changed.push(i + 1);
    const text = (r: ToolResult) => show(normalizeText(r.outcome.text) || `(vide, exit ${String(r.outcome.exit)})`, 90);
    rows.push(`| ${i + 1} | ${a.tool ?? "?"} | ${before} | **${now}** | ${text(a)} | ${text(b)} |`);
  });
  md.push(`Partie 2 : verdicts de signature CHANGÉS pour les paires : ${changed.length ? changed.join(", ") : "aucune"}. Les paires attendues par vos corrections : 12, 13, 20, 23, 33.`, "");
  md.push("### Les 5 paires à revalider", "", "| n | outil | avant | maintenant | texte A (normalisé) | texte B (normalisé) |", "|---|---|---|---|---|---|");
  for (const n of [12, 13, 20, 23, 33]) md.push(rows[n - 1]!);
  md.push("", "### Toutes les paires dont le verdict a changé", "", "| n | outil | avant | maintenant | texte A (normalisé) | texte B (normalisé) |", "|---|---|---|---|---|---|");
  for (const n of changed) md.push(rows[n - 1]!);
  // Deux informations pour deux décisions de qualification (non tranchées ici) : échecs SANS texte, et récurrences dans la MÊME conversation (déjà en contexte).
  const fails = [...byId.values()].filter((r) => r.outcome.kind === "echec");
  const withText = fails.filter((r) => r.outcome.text !== "");
  const sessionsBySig = new Map<string, Set<string>>();
  let anyEarlier = 0;
  let otherConversation = 0;
  for (const r of withText) {
    const seen = sessionsBySig.get(r.signature!) ?? new Set<string>();
    if (seen.size > 0) anyEarlier++;
    if ([...seen].some((s) => s !== r.sessionId)) otherConversation++;
    seen.add(r.sessionId);
    sessionsBySig.set(r.signature!, seen);
  }
  md.push("", "### Informations pour deux décisions (apprentissage)", "", `- échecs : ${fails.length}, dont **sans texte d'échec** (signature = code de sortie seul) : ${fails.length - withText.length} ; avec texte : ${withText.length}.`, `- parmi les échecs AVEC texte : ${anyEarlier} ont une signature déjà vue plus tôt, dont **${otherConversation} dans une AUTRE conversation** (les ${anyEarlier - otherConversation} autres ne répètent qu'un échec de la même conversation, déjà dans le contexte de l'agent).`);
  console.log(`échecs ${fails.length} (sans texte ${fails.length - withText.length}) ; avec texte ${withText.length} ; signature déjà vue ${anyEarlier}, autre conversation ${otherConversation}`);
  writeFileSync(join(WORK_DIR, "revalidation.md"), `${md.join("\n")}\n`);
  console.log(md.slice(0, 4).join("\n"));
  console.log(`paires changées : ${changed.join(", ") || "aucune"} ; écrit ${join(WORK_DIR, "revalidation.md")}`);
}

/** Volume et validité du signal préexistant « [Tool loop warning: …] » (APPRENTISSAGE seulement ; l'évaluation n'est pas regardée). */
function loopWarn(): void {
  const train = loadResults("train");
  const WARN = /\[Tool loop warning:\s*([A-Za-z_]+)/;
  const warned = train.filter((r) => WARN.test(r.content));
  const byType = new Map<string, number>();
  for (const r of warned) byType.set(WARN.exec(r.content)![1]!, (byType.get(WARN.exec(r.content)![1]!) ?? 0) + 1);
  const byKind = { echec: 0, succes: 0, indetermine: 0 };
  for (const r of warned) byKind[r.outcome.kind]++;
  // Validité de la signature : parmi les résultats avertis qui sont des échecs, part de ceux dont une signature IDENTIQUE a déjà été vue plus tôt dans la même conversation.
  const seen = new Map<string, Set<string>>();
  let warnedFails = 0;
  let withEarlierSame = 0;
  let withEarlierSameTool = 0;
  const toolSeen = new Map<string, Set<string>>();
  for (const r of train) {
    if (r.outcome.kind !== "echec") continue;
    const s = seen.get(r.sessionId) ?? new Set<string>();
    const ts = toolSeen.get(r.sessionId) ?? new Set<string>();
    if (WARN.test(r.content)) {
      warnedFails++;
      if (s.has(r.signature!)) withEarlierSame++;
      if (ts.has(r.tool ?? "?")) withEarlierSameTool++;
    }
    s.add(r.signature!);
    ts.add(r.tool ?? "?");
    seen.set(r.sessionId, s);
    toolSeen.set(r.sessionId, ts);
  }
  const sampleSuffix = warned.slice(0, 3).map((r) => show(r.content.slice(Math.max(0, r.content.search(WARN) - 10)), 260));
  const out = {
    apprentissage: { resultats: train.length, avertis: warned.length, partDesResultats: +(warned.length / train.length * 100).toFixed(2) },
    types: Object.fromEntries(byType),
    classeParLaRegle: byKind,
    echecsAvertis: warnedFails,
    avecMemeSignatureDejaVueDansLaConversation: withEarlierSame,
    avecMemeOutilDejaEnEchecDansLaConversation: withEarlierSameTool,
    exemplesDeSuffixe: sampleSuffix,
  };
  writeFileSync(join(WORK_DIR, "loop-warning.json"), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

const cmd = process.argv[2];
if (process.argv[1]?.endsWith("causal-prep.ts")) {
  if (cmd === "replay") replay();
  if (cmd === "loopwarn") loopWarn();
  if (cmd === "copy")
    copy().catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
  else if (cmd === "samples") samples();
}
