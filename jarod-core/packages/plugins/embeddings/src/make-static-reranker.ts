/**
 * Fige les formes de l'IR du reranker (SPECS-P5-RERANKER.md §2.6, Q5) : le NPU ne compile le modèle qu'à formes STATIQUES (« Upper bounds
 * are not specified »), et `TextRerankPipeline` pousse tous les candidats d'un appel dans un seul tenseur `lot × longueur`. Cet outil
 * produit, depuis l'export `optimum-cli` (formes dynamiques), l'IR à `lot × longueur` fixes — en Node pur : ni Python, ni téléchargement.
 *
 * Depuis packages/plugins/embeddings (là où `openvino-node` se résout) :
 *   ../../../node_modules/.bin/tsx src/make-static-reranker.ts <source> <destination>                 → SIMULATION (rien n'est écrit)
 *   ../../../node_modules/.bin/tsx src/make-static-reranker.ts <source> <destination> --apply         → écrit l'IR figée
 *   options : --batch <n> (défaut 8)   --max-length <n> (défaut 512)
 *
 * Leçon mesurée le 2026-10-01 : `Model.reshape` ne prend les formes que sous forme de CHAÎNES dans une `Map` (« 8,512 ») ; un objet simple ou
 * des tableaux sont ignorés SANS erreur. D'où la vérification, après le reshape, que chaque entrée est bien figée. Refuse d'écraser.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface FreezeOptions {
  source: string;
  dest: string;
  batch: number;
  maxLength: number;
}

/** Fichiers annexes recopiés tels quels (tokenizers, configuration) quand ils existent dans la source. */
const SIDE_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "openvino_tokenizer.xml", "openvino_tokenizer.bin", "openvino_detokenizer.xml", "openvino_detokenizer.bin"];

export interface ModelLike {
  readonly inputs: { getAnyName(): string; getPartialShape(): { toString(): string } | string }[];
  reshape(shapes: Map<string, string>): unknown;
}
/** Ce que l'outil demande à OpenVINO — remplaçable en test. */
export interface OvLike {
  createCore(): { readModelSync(xmlPath: string): ModelLike };
  saveModelSync(model: ModelLike, path: string, compressToFp16: boolean): void;
}

function loadOv(): OvLike {
  const ov = createRequire(import.meta.url)("openvino-node") as { addon: { Core: new () => { readModelSync(p: string): ModelLike }; saveModelSync(m: ModelLike, p: string, c: boolean): void } };
  return { createCore: () => new ov.addon.Core(), saveModelSync: (m, p, c) => ov.addon.saveModelSync(m, p, c) };
}

function check(o: FreezeOptions): void {
  if (!Number.isInteger(o.batch) || o.batch < 1) throw new Error(`batch invalide : ${o.batch} (entier positif attendu)`);
  if (!Number.isInteger(o.maxLength) || o.maxLength < 1) throw new Error(`maxLength invalide : ${o.maxLength} (entier positif attendu)`);
  if (resolve(o.source) === resolve(o.dest)) throw new Error("la destination est la source : refus d'écraser l'export d'origine");
  if (!existsSync(join(o.source, "openvino_model.xml"))) throw new Error(`openvino_model.xml absent de la source ${o.source} (export optimum-cli attendu)`);
  if (existsSync(o.dest) && readdirSync(o.dest).length > 0) throw new Error(`la destination existe déjà et n'est pas vide : ${o.dest} (refus d'écraser)`);
}

/** Noms et formes des paramètres lus dans l'XML (sans charger les poids). */
function parameters(xmlPath: string): { name: string; shape: string }[] {
  const xml = readFileSync(xmlPath, "utf8");
  const out: { name: string; shape: string }[] = [];
  for (const m of xml.matchAll(/<layer\b[^>]*\bname="([^"]+)"[^>]*\btype="Parameter"[^>]*>[\s\S]*?<data\b[^>]*\bshape="([^"]*)"/g)) out.push({ name: m[1]!, shape: m[2]! });
  return out;
}

/** La simulation : valide tout, lit les noms d'entrée, ne crée rien. */
export function planRerankerFreeze(o: FreezeOptions): { inputs: string[]; shape: string; copy: string[] } {
  check(o);
  const params = parameters(join(o.source, "openvino_model.xml"));
  if (params.length === 0) throw new Error("aucun paramètre d'entrée trouvé dans openvino_model.xml");
  if (params.every((p) => !p.shape.includes("?") && !p.shape.includes("-1"))) throw new Error("toutes les entrées sont déjà figées (formes statiques) : rien à faire sur cette source");
  return { inputs: params.map((p) => p.name), shape: `${o.batch},${o.maxLength}`, copy: SIDE_FILES.filter((f) => existsSync(join(o.source, f))) };
}

/** Fige les formes et écrit l'IR dans `dest`. Rend les entrées avec leur forme vérifiée. */
export function freezeRerankerShapes(o: FreezeOptions, ov: OvLike = loadOv()): { dest: string; inputs: { name: string; shape: string }[]; copied: string[] } {
  const plan = planRerankerFreeze(o);
  const core = ov.createCore();
  const model = core.readModelSync(join(o.source, "openvino_model.xml"));
  const shapes = new Map(model.inputs.map((i) => [i.getAnyName(), plan.shape] as const));
  model.reshape(shapes);
  // OpenVINO écrit une forme « [8,512] » : on compare sans crochets ni espaces.
  const frozen = model.inputs.map((i) => ({ name: i.getAnyName(), shape: String(i.getPartialShape()).replace(/[[\]\s]/g, "") }));
  const bad = frozen.filter((f) => f.shape !== plan.shape);
  if (bad.length) throw new Error(`les formes ne sont pas figées après reshape (${bad.map((b) => `${b.name} = ${b.shape}`).join(", ")}) : formes attendues « ${plan.shape} »`);
  mkdirSync(o.dest, { recursive: true });
  ov.saveModelSync(model, join(o.dest, "openvino_model.xml"), false);
  for (const f of plan.copy) copyFileSync(join(o.source, f), join(o.dest, f));
  return { dest: o.dest, inputs: frozen, copied: plan.copy };
}

function main(): void {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && a !== "--apply"));
  const [source, dest] = pos;
  if (!source || !dest) throw new Error("usage : make-static-reranker <source> <destination> [--batch 8] [--max-length 512] [--apply]");
  const o: FreezeOptions = { source: resolve(source), dest: resolve(dest), batch: Number(opt("--batch") ?? 8), maxLength: Number(opt("--max-length") ?? 512) };
  const plan = planRerankerFreeze(o);
  console.log(`Source : ${o.source}\nDestination : ${o.dest}\nEntrées : ${plan.inputs.join(", ")} → forme ${plan.shape}\nAnnexes recopiées : ${plan.copy.join(", ")}`);
  if (!apply) return void console.log("\nSIMULATION : rien n'a été écrit. Relancez avec --apply.");
  const r = freezeRerankerShapes(o);
  console.log(`\nÉCRIT : ${r.dest}\n${r.inputs.map((i) => `  ${i.name} ${i.shape}`).join("\n")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
    process.exit(0);
  } catch (e) {
    console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
