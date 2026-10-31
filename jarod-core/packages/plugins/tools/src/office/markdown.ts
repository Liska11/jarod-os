// Un Markdown de documents, assez petit pour être sûr : titres (#, ##, ###), paragraphes, listes à puces ou numérotées, tableaux à barres, blocs de code,
// gras (**x**), italique (*x*) et code (`x`). Rien d'autre n'est interprété : un lien reste du texte, une image n'est pas chargée.

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}
export type Block =
  | { t: "h"; level: 1 | 2 | 3; runs: Run[] }
  | { t: "p"; runs: Run[] }
  | { t: "li"; ordered: boolean; n: number; runs: Run[] }
  | { t: "table"; rows: Run[][][] }
  | { t: "code"; lines: string[] };

export const MARKDOWN_MAX_CHARS = 400_000;

export function parseInline(src: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) runs.push({ text: src.slice(last, i) });
    const tok = m[0];
    if (tok.startsWith("**")) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) runs.push({ text: tok.slice(1, -1), code: true });
    else runs.push({ text: tok.slice(1, -1), italic: true });
    last = i + tok.length;
  }
  if (last < src.length) runs.push({ text: src.slice(last) });
  return runs.length ? runs : [{ text: "" }];
}

const isRule = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  if (src.length > MARKDOWN_MAX_CHARS) throw new Error(`Texte trop long (${MARKDOWN_MAX_CHARS} caractères au plus).`);
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", runs: parseInline(para.join(" ").trim()) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ t: "code", lines: code });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3, runs: parseInline(h[2]!.trim()) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      blocks.push({ t: "li", ordered: Boolean(numbered), n: numbered ? Number(numbered[1]) : 0, runs: parseInline((bullet ? bullet[1]! : numbered![2]!).trim()) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isRule(cellsOf(lines[i + 1]!))) {
      flush();
      const rows: Run[][][] = [cellsOf(line).map(parseInline)];
      for (i += 2; i < lines.length && lines[i]!.includes("|") && lines[i]!.trim(); i++) rows.push(cellsOf(lines[i]!).map(parseInline));
      i--;
      blocks.push({ t: "table", rows });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export const plain = (runs: readonly Run[]): string => runs.map((r) => r.text).join("");
