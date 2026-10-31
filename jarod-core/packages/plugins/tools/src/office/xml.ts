// Échappement XML : tout texte venu du modèle passe ici avant d'entrer dans un document. Un texte ne doit jamais pouvoir fermer une balise.

/** Un point de code permis en XML 1.0 : tabulation, retour, saut de ligne, puis tout sauf contrôles, substituts isolés et U+FFFE/FFFF. */
function allowed(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp < 0x20) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false; // substitut isolé (une paire valide arrive ici déjà réunie en un point de code)
  return cp !== 0xfffe && cp !== 0xffff;
}

export function xmlText(s: unknown): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    if (!allowed(ch.codePointAt(0)!)) continue;
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
  }
  return out;
}

export function xmlAttr(s: unknown): string {
  return xmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\r|\n|\t/g, " ");
}
