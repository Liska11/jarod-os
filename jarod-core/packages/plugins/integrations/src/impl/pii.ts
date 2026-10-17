/**
 * C3 (presidio) — détection et masquage de données personnelles AVANT tout envoi vers un fournisseur distant.
 *
 * Presidio (Python) est un moteur plus complet ; ce module est la couche de base, locale et déterministe, qui s'applique
 * même sans lui : courriel, carte bancaire (clé de Luhn), IBAN (modulo 97), numéro de sécurité sociale français (clé),
 * téléphone, adresse IP. C'est une COUCHE SUPPLÉMENTAIRE, pas une garantie : un nom propre ou une adresse postale ne
 * sont pas détectés ici (voir les limites dans le test de mesure). Le masquage est irréversible dans la sortie ; seule la
 * catégorie et le nombre sont journalisés, jamais la valeur.
 */
export type PiiCategory = "email" | "card" | "iban" | "nir" | "phone" | "ip";

export interface PiiFinding {
  category: PiiCategory;
  start: number;
  end: number;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function nirValid(raw: string): boolean {
  const s = raw.replace(/\s/g, "");
  if (!/^[12]\d{12}\d{2}$/.test(s)) return false;
  const body = BigInt(s.slice(0, 13));
  return 97n - (body % 97n) === BigInt(s.slice(13));
}

const PATTERNS: { category: PiiCategory; re: RegExp; valid?: (m: string) => boolean }[] = [
  { category: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { category: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  { category: "nir", re: /\b[12] ?\d{2} ?\d{2} ?\d{2} ?\d{3} ?\d{3} ?\d{2}\b/g, valid: nirValid },
  { category: "card", re: /\b(?:\d[ -]?){13,19}\b/g, valid: (m) => { const d = m.replace(/[ -]/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { category: "phone", re: /(?<!\d)(?:\+33|0033|0)[ .-]?[1-9](?:[ .-]?\d{2}){4}(?!\d)/g },
  { category: "ip", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

export function detectPii(text: string): PiiFinding[] {
  const found: PiiFinding[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      if (p.valid && !p.valid(m[0])) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue; // déjà couvert par une catégorie plus précise
      found.push({ category: p.category, start, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export interface MaskResult {
  text: string;
  counts: Record<string, number>;
}

export function maskPii(text: string): MaskResult {
  const findings = detectPii(text);
  const counts: Record<string, number> = {};
  let out = "";
  let at = 0;
  for (const f of findings) {
    out += `${text.slice(at, f.start)}[${f.category.toUpperCase()}]`;
    at = f.end;
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  }
  return { text: out + text.slice(at), counts };
}

/** Garde d'envoi : rend le texte masqué et les comptes ; ne dit jamais la valeur masquée. */
export function guardCloudSend(text: string, opts: { enabled?: boolean } = {}): MaskResult {
  return opts.enabled === false ? { text, counts: {} } : maskPii(text);
}

/** Entité trouvée par un moteur externe (Presidio) : type, bornes, score. Jamais le texte. */
export interface ExternalFinding {
  entity: string;
  start: number;
  end: number;
  score: number;
}

const EXTERNAL_LABEL = /^[A-Z_]{2,30}$/;

/**
 * Union de la couche locale et d'un moteur externe : ce que Presidio trouve en plus (noms, lieux, organisations…) est masqué
 * sous son type ; un recouvrement garde la zone la plus large. Les bornes invalides sont ignorées, jamais appliquées.
 */
export function maskPiiWith(text: string, external: ExternalFinding[], minScore = 0.6): MaskResult {
  type Span = { start: number; end: number; label: string };
  const spans: Span[] = detectPii(text).map((f) => ({ start: f.start, end: f.end, label: f.category.toUpperCase() }));
  for (const e of external) {
    if (e.score < minScore || !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end > text.length || e.start >= e.end || !EXTERNAL_LABEL.test(e.entity)) continue;
    spans.push({ start: e.start, end: e.end, label: e.entity });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else merged.push({ ...s });
  }
  const counts: Record<string, number> = {};
  let out = "";
  let at = 0;
  for (const s of merged) {
    out += `${text.slice(at, s.start)}[${s.label}]`;
    at = s.end;
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }
  return { text: out + text.slice(at), counts };
}
