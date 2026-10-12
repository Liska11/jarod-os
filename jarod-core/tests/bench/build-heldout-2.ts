/**
 * Provenance du jeu hors échantillon n° 2 (SPECS-P5-HYBRID-V2.md §4) : 24 questions écrites À LA MAIN par Claude le 2026-10-02 (14 ordinaires, 10 à
 * terme rare), chacune avec une CHAÎNE-PREUVE tirée du passage qui répond. La cible est l'ensemble des passages du document visé qui contiennent
 * cette chaîne (insensible à la casse, aux accents et aux espaces) — jamais un rang choisi à la main. Refuse si une cible tombe dans un passage déjà
 * utilisé (A' ou jeu n° 1). Écrit `hybrid-heldout-2.json` avec `"validated": false` : à relire par l'utilisateur AVANT toute mesure de V2.
 *     tsx bench/build-heldout-2.ts <dossier-profil-copie>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/\s+/g, " ");

type Kind = "ordinaire" | "rare";
const Q: { kind: Kind; doc: string; q: string; ev: string }[] = [
  { kind: "ordinaire", doc: "RMP", q: "Quelles zones confinées sont couvertes par le RMP dans la région PAK ?", ev: "Marseille Chartreux, Avignon" },
  { kind: "ordinaire", doc: "RMP", q: "Combien de répéteurs et d'antennes diffusent les émissions RMP ?", ev: "567 répéteurs" },
  { kind: "ordinaire", doc: "RMP", q: "Qui choisit les tunnels à couvrir en émissions RMP ?", ev: "en concertation avec les 4 opérateurs publics" },
  { kind: "ordinaire", doc: "RMP", q: "L'alimentation électrique des sites RMP est-elle secourue ?", ev: "n'est pas secourue" },
  { kind: "ordinaire", doc: "RMP", q: "Pourquoi réalise-t-on des mesures de non-régression GSM-R à la fin des travaux ?", ev: "mesures de non-régression GSM-R" },
  { kind: "ordinaire", doc: "GTB", q: "Où le webservice récupère-t-il les alarmes historiques ?", ev: "unité d'archivage de PcVue" },
  { kind: "ordinaire", doc: "FORM", q: "À quoi sert la BTS dans le réseau ?", ev: "liaison entre le mobile (Radio) et le BSC" },
  { kind: "ordinaire", doc: "FORM", q: "Quel équipement gère la carte SIM des abonnés ?", ev: "gestion de la carte SIM" },
  { kind: "ordinaire", doc: "FORM", q: "Quelles fonctionnalités permettent les appels prioritaires et l'alerte ?", ev: "appels prioritaires et des appels de groupe" },
  { kind: "ordinaire", doc: "FORM", q: "De quoi se compose l'ERTMS ?", ev: "ERTMS = ETCS + GSM-R" },
  { kind: "ordinaire", doc: "PROC", q: "Par combien d'étapes passe le traitement d'une demande de rapport d'alerte radio ?", ev: "passe par 4 étapes" },
  { kind: "ordinaire", doc: "PROC", q: "Que faire si le PCTF demande une coupure avant l'heure planifiée ?", ev: "coupure en amont de l'heure planifiée" },
  { kind: "ordinaire", doc: "PROC", q: "Que faire si le délai d'intervention dépasse huit heures ?", ev: "excèderai 8h" },
  { kind: "ordinaire", doc: "MATRICE", q: "Quels types de TowerCo apparaissent dans la matrice d'escalade ?", ev: "TowerCo Cellnex/Hivory/OnTower" },
  { kind: "rare", doc: "RMP", q: "Comment les antennes mutualisées sont-elles notées dans les outils de l'ANFR ?", ev: "notées comme leader SNCF" },
  { kind: "rare", doc: "FORM", q: "À quoi correspond le code court 1300 ?", ev: "1300 appel gare par défaut" },
  { kind: "rare", doc: "FORM", q: "À quoi servent les champs TI, GCA et GID de la numérotation en CT5 ?", ev: "5 + TI + GCA + GID" },
  { kind: "rare", doc: "FORM", q: "Qu'est-ce qu'un appel ZAL et quelle est sa priorité ?", ev: "Appel ZAL (Priorité 3)" },
  { kind: "rare", doc: "FORM", q: "Combien de serveurs C-NMS sont en redondance et sur quels sites ?", ev: "2 Serveurs C-NMS en redondance" },
  { kind: "rare", doc: "PROC", q: "Comment s'appelle un GOP côté SNCF ?", ev: "AT (Avis travaux)" },
  { kind: "rare", doc: "MATRICE", q: "Quel site porte le numéro 359301 ?", ev: "359301" },
  { kind: "rare", doc: "MATRICE", q: "Qui est le Directeur Adjoint Infrastructure de l'escalade niveau 4 ?", ev: "Directeur Adjoint Infrastructure" },
  { kind: "rare", doc: "FORM", q: "À quoi sert le jeton dans un appel de groupe ?", ev: "libération du jeton" },
  { kind: "rare", doc: "PROC", q: "Que faut-il identifier d'abord en cas d'alarme RF/FO ?", ev: "Identifier l'équipement RFFO ou IANA" },
];

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage : tsx bench/build-heldout-2.ts <dossier-profil-copie>");
  const a1 = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: { answer: string[]; partial: string[] }[] };
  const h1 = JSON.parse(readFileSync(join(HERE, "hybrid-heldout.json"), "utf8")) as { docs: Record<string, string>; questions: { answer: string[]; partial: string[] }[] };
  const DOCS: Record<string, string> = { ...a1.docs, ...h1.docs };
  const used = new Set<string>();
  for (const s of [a1, h1]) for (const q of s.questions) for (const id of [...q.answer, ...q.partial]) used.add(`${DOCS[id.split("#")[0]!]}#${id.split("#")[1]}`);

  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) } } } as never);
  const started = await start(app);
  try {
    const db = (app as unknown as { storage: { db: { all<T>(s: string): T[] } } }).storage.db;
    const rows = db.all<{ doc_id: string; ord: number; text: string }>("SELECT doc_id, ord, text FROM rag_chunks ORDER BY doc_id, ord");
    const short = (id: string) => Object.entries(DOCS).find(([, v]) => v === id)?.[0] ?? id;
    const questions = [];
    let problems = 0;
    for (const [i, x] of Q.entries()) {
      const hits = rows.filter((r) => r.doc_id === DOCS[x.doc] && fold(r.text).includes(fold(x.ev)));
      const elsewhere = rows.filter((r) => r.doc_id !== DOCS[x.doc] && fold(r.text).includes(fold(x.ev))).length;
      const clash = hits.filter((h) => used.has(`${h.doc_id}#${h.ord}`));
      const status = hits.length === 0 ? "AUCUN PASSAGE" : clash.length ? `DÉJÀ UTILISÉ (${clash.map((c) => c.ord).join(",")})` : hits.length > 3 ? "TROP DE PASSAGES" : "ok";
      if (status !== "ok") problems++;
      console.log(`Q${i + 1} [${x.kind}] ${x.doc} → ${hits.map((h) => `#${h.ord}`).join(" ") || "-"}${elsewhere ? ` (+${elsewhere} ailleurs, ignorés)` : ""} : ${status}`);
      questions.push({ n: i + 1, kind: x.kind, q: x.q, evidence: x.ev, answer: hits.map((h) => `${x.doc}#${h.ord}`), partial: [] as string[] });
    }
    if (problems) throw new Error(`${problems} question(s) à corriger : jeu non écrit`);
    const out = {
      status: "ÉCRIT PAR CLAUDE LE 2026-10-02, NON VALIDÉ : les cibles doivent être relues par l'utilisateur avant toute mesure de V2 (SPECS-P5-HYBRID-V2.md §4). Cible = passages du document visé contenant la chaîne-preuve ; aucun passage commun avec A' ni avec le jeu n° 1.",
      validated: false,
      docs: { RMP: DOCS.RMP, GTB: DOCS.GTB, FORM: DOCS.FORM, PROC: DOCS.PROC, MATRICE: DOCS.MATRICE },
      composition: { ordinaire: Q.filter((x) => x.kind === "ordinaire").length, rare: Q.filter((x) => x.kind === "rare").length },
      questions,
    };
    const text = JSON.stringify(out, null, 1);
    writeFileSync(join(HERE, "hybrid-heldout-2.json"), text);
    console.log(`écrit : ${questions.length} questions (${out.composition.ordinaire} ordinaires, ${out.composition.rare} à terme rare) ; SHA-256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}`);
    void short;
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
