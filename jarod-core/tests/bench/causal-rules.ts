/**
 * SPECS-P5-CAUSAL.md §4 — règles PROPOSÉES (non gelées) : classement échec / succès d'un résultat d'outil, signature d'échec. Fonctions PURES.
 * La règle ne regarde que des signaux STRUCTURELS du résultat (code de sortie, champ d'erreur, `success`, `status`) : un objet JSON porteur d'un signal
 * d'échec est un échec, sans signal d'échec un succès. Ce qu'elle ne sait pas décider (texte libre, tableau, `status: killed`) est « indéterminé » et sera
 * EXCLU de la mesure (jamais deviné). Limite assumée : un test qui échoue derrière un tube (`| tail`) rend le code 0 → succès.
 *
 * Historique de mise au point (sur l'APPRENTISSAGE seulement, avant tout gel, dit à l'utilisateur) : le premier jet rangeait en « indéterminé » les résultats
 * JSON suivis d'un avertissement de l'outil (« [Tool loop warning…] ») et prenait la PREMIÈRE ligne de sortie comme texte d'échec (souvent une bannière
 * `=== titre ===`). Corrigé : lecture de l'objet JSON en tête de contenu ; texte d'échec = première ligne qui ressemble à une erreur, sinon la dernière.
 * Deuxième correction (revalidation de 5 paires par l'utilisateur, 2026-10-02) : chemins RELATIFS entre guillemets et globs non neutralisés (paires 12, 20, 23) ;
 * lignes de TITRE (`=== … ===`, `---`, `##`, `> bannière`) prises pour le texte d'échec (paires 13, 33). Les deux sont des bugs, pas des choix de règle.
 */
export type OutcomeKind = "succes" | "echec" | "indetermine";
export interface Outcome {
  kind: OutcomeKind;
  /** Signal qui a décidé (pour montrer la règle à l'utilisateur). */
  reason: string;
  /** Texte d'échec : champ d'erreur, sinon ligne de sortie la plus parlante (voir `failureLine`), sinon "". */
  text: string;
  exit: number | null;
}

const ERROR_LINE = /error|erreur|fail|échec|not found|introuvable|cannot|can't|couldn't|no such|denied|refus|invalid|unexpected|timed? ?out|exception|traceback|fatal|unknown|missing|blocked|interrupted/i;

/** Ligne de titre ou de bannière (`=== … ===`, `--- … ---`, `## …`, `> paquet@1.0 build …` d'un gestionnaire de paquets) : ne dit rien de la cause. */
const BANNER_LINE = /^(?:={2,}|-{3,}|#{2,}\s|>\s)/;

/** Ligne de sortie la plus parlante : la première (hors titres) qui ressemble à une erreur, sinon la dernière hors titres, sinon "". */
export function failureLine(output: unknown): string {
  if (typeof output !== "string") return "";
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BANNER_LINE.test(l));
  return lines.find((l) => ERROR_LINE.test(l)) ?? lines.at(-1) ?? "";
}

/** Objet JSON en tête du contenu (l'outil peut ajouter un avertissement après l'objet). Null si le contenu ne commence pas par un objet complet. */
export function leadingJsonObject(content: string): Record<string, unknown> | null {
  const s = content.trimStart();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    // Objet suivi de texte : on cherche l'accolade fermante qui équilibre la première (chaînes JSON respectées).
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v = JSON.parse(s.slice(0, i + 1));
          return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

export function classifyResult(_toolName: string | null, content: string): Outcome {
  const o = leadingJsonObject(content);
  if (!o) return { kind: "indetermine", reason: "pas un objet JSON", text: "", exit: null };
  const exit = typeof o.exit_code === "number" ? o.exit_code : null;
  const err = typeof o.error === "string" && o.error.trim() !== "" ? o.error.trim() : "";
  const text = err || failureLine(o.output) || failureLine(o.message) || "";
  const fail = (reason: string): Outcome => ({ kind: "echec", reason, text, exit });

  if (exit !== null && exit !== 0) return fail(`exit_code ${exit}`);
  if (err) return fail("champ error renseigné");
  if (o.success === false) return fail("success: false");
  if (typeof o.status === "string" && ["error", "failed", "timeout"].includes(o.status)) return fail(`status ${o.status}`);

  const ok = (reason: string): Outcome => ({ kind: "succes", reason, text: "", exit });
  if (exit === 0) return ok("exit_code 0, pas d'erreur");
  if (o.success === true) return ok("success: true");
  // `status: killed` (processus arrêté, peut être voulu) : on ne devine pas.
  if (o.status === "killed") return { kind: "indetermine", reason: "status killed", text: "", exit };
  // Un résultat JSON (objet) SANS aucun signal d'échec est un succès : les outils (lecture, écriture, recherche, liste de tâches) ne signalent que leurs échecs.
  return ok("objet JSON sans signal d'échec");
}

/** Un fragment ressemble à un chemin ou un glob : séparateur, joker, ou nom de fichier à extension. */
const looksLikePath = (s: string): boolean => /[/\\*?]/.test(s) || /^[\w.\-~]+\.\w{1,6}$/.test(s);

/** Texte comparable d'une exécution à l'autre : minuscules, URL / chemins (absolus, relatifs, entre guillemets, globs) / hexadécimaux / nombres neutralisés. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    // Fragment entre guillemets, collé à un début de mot (l'apostrophe de « can't » n'ouvre pas un guillemet), sans espace : chemin ou glob → <chemin>.
    .replace(/(^|[\s([:=,])(['"`‘“])([^\s'"`’”]{1,200})(['"`’”])/g, (m, pre: string, q1: string, body: string, q2: string) => (looksLikePath(body) ? `${pre}${q1}<chemin>${q2}` : m))
    .replace(/\b[a-z]:[\\/][^\s'"<>|]*/g, "<chemin>")
    .replace(/\.{1,2}\\[^\s'"<>|]*/g, "<chemin>")
    .replace(/\/[\w.-]+(?:\/[\w.-]+)+/g, "<chemin>")
    // Chemin relatif nu : au moins deux segments, une barre finale, un joker ou une extension (« and/or » n'en est pas un).
    .replace(/(?<![\w<>@#:.\-/\\])[\w.\-~*?]+(?:\/[\w.\-*?]*)+/g, (m) => (m.split("/").length > 2 || m.endsWith("/") || /[*?]|\.\w{1,6}$/.test(m) ? "<chemin>" : m))
    .replace(/\.{1,2}<chemin>/g, "<chemin>")
    .replace(/<chemin>:/g, "<chemin>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export const SIGNATURE_CHARS = 60;

/** Signature d'échec = outil + début normalisé du texte d'échec ; texte vide → code de sortie, sinon `<vide>`. */
export function signatureOf(toolName: string | null, o: Outcome): string {
  const tool = toolName ?? "?";
  const text = normalizeText(o.text).slice(0, SIGNATURE_CHARS).trim();
  if (text) return `${tool}|${text}`;
  return `${tool}|${o.exit !== null ? `exit=${o.exit}` : "<vide>"}`;
}

/** Générateur pseudo-aléatoire déterministe (échantillons reproductibles, graine fixe). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
