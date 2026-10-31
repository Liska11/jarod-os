// Un PDF (A4) écrit à la main à partir du Markdown de documents : polices standard du format (Helvetica, Courier), pas de police embarquée, pas d'image,
// pas de JavaScript, pas de lien. Le texte est encodé en WinAnsi (le français passe ; ce qui n'y est pas devient « ? »).
import { type Block, parseMarkdown, type Run } from "./markdown.js";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const BOTTOM = 64;
export const PDF_MAX_PAGES = 200;

// Largeurs Helvetica (1/1000 d'em) de U+0020 à U+007E.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

type Face = "F1" | "F2" | "F3" | "F4" | "F5";
const faceOf = (r: Run, forceBold = false): Face => (r.code ? "F5" : (r.bold || forceBold) && r.italic ? "F4" : r.bold || forceBold ? "F2" : r.italic ? "F3" : "F1");

const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

/** L'octet WinAnsi d'un caractère ; l'espace insécable devient une espace, ce qui n'existe pas devient « ? ». */
function winAnsi(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp === 0xa0 || cp === 0x202f) return 0x20;
  if (cp === 0x09) return 0x20;
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa1 && cp <= 0xff) return cp;
  return CP1252[cp] ?? 0x3f;
}

function charWidth(ch: string, face: Face): number {
  if (face === "F5") return 600;
  const b = winAnsi(ch);
  let w: number;
  if (b >= 0x20 && b <= 0x7e) w = HELV[b - 0x20]!;
  else {
    const base = ch.normalize("NFD")[0] ?? "?";
    const cp = base.codePointAt(0)!;
    w = cp >= 0x20 && cp <= 0x7e ? HELV[cp - 0x20]! : 556;
  }
  return face === "F2" || face === "F4" ? w * 1.07 : w;
}

const widthOf = (text: string, face: Face, size: number): number => {
  let w = 0;
  for (const ch of text) w += charWidth(ch, face);
  return (w * size) / 1000;
};

const hex = (text: string): string => {
  let out = "";
  for (const ch of text) out += winAnsi(ch).toString(16).padStart(2, "0");
  return `<${out}>`;
};

interface Word {
  text: string;
  face: Face;
}

/** Découpe des segments en mots, chaque mot gardant sa police ; l'espace qui suit un mot est portée par le mot. */
function words(runs: readonly Run[], forceBold = false): Word[] {
  const out: Word[] = [];
  for (const r of runs) {
    const face = faceOf(r, forceBold);
    for (const part of r.text.split(/(?<=\s)/)) {
      if (part) out.push({ text: part.replace(/\s+/g, " "), face });
    }
  }
  return out;
}

interface Line {
  segs: Array<{ text: string; face: Face; x: number }>;
}

function wrap(ws: readonly Word[], size: number, width: number): Line[] {
  const lines: Line[] = [];
  let line: Line = { segs: [] };
  let x = 0;
  for (const w of ws) {
    const trimmed = w.text.replace(/\s+$/, "");
    const need = widthOf(trimmed, w.face, size);
    if (x > 0 && x + need > width) {
      lines.push(line);
      line = { segs: [] };
      x = 0;
    }
    // Un mot plus long qu'une ligne est coupé là où il déborde.
    let rest = w.text;
    while (rest && widthOf(rest.replace(/\s+$/, ""), w.face, size) > width) {
      let n = 1;
      while (n < rest.length && widthOf(rest.slice(0, n + 1), w.face, size) <= width) n++;
      line.segs.push({ text: rest.slice(0, n), face: w.face, x });
      lines.push(line);
      line = { segs: [] };
      x = 0;
      rest = rest.slice(n);
    }
    if (rest) {
      line.segs.push({ text: rest, face: w.face, x });
      x += widthOf(rest, w.face, size);
    }
  }
  if (line.segs.length) lines.push(line);
  return lines.length ? lines : [{ segs: [] }];
}

class Pages {
  readonly streams: string[] = [];
  private ops: string[] = [];
  y = PAGE_H - MARGIN;

  constructor() {
    this.streams.length = 0;
  }

  private newPage(): void {
    this.streams.push(this.ops.join("\n"));
    this.ops = [];
    this.y = PAGE_H - MARGIN;
    if (this.streams.length >= PDF_MAX_PAGES) throw new Error(`Document trop long (${PDF_MAX_PAGES} pages au plus).`);
  }

  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }

  text(segs: Line["segs"], x0: number, size: number): void {
    for (const s of segs) if (s.text.trim()) this.ops.push(`BT /${s.face} ${size} Tf 1 0 0 1 ${(x0 + s.x).toFixed(2)} ${this.y.toFixed(2)} Tm ${hex(s.text.replace(/\s+$/, ""))} Tj ET`);
  }

  raw(op: string): void {
    this.ops.push(op);
  }

  finish(): string[] {
    this.streams.push(this.ops.join("\n"));
    return this.streams;
  }
}

function paragraph(pages: Pages, ws: readonly Word[], size: number, x0: number, width: number, gapAfter: number, leading = 1.35): void {
  for (const line of wrap(ws, size, width)) {
    pages.ensure(size * leading);
    pages.y -= size * leading;
    pages.text(line.segs, x0, size);
  }
  pages.y -= gapAfter;
}

function table(pages: Pages, rows: Run[][][]): void {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const colW = (PAGE_W - 2 * MARGIN) / cols;
  const size = 9.5;
  const pad = 4;
  for (const [ri, row] of rows.entries()) {
    const cells = Array.from({ length: cols }, (_, ci) => wrap(words(row[ci] ?? [{ text: "" }], ri === 0), size, colW - 2 * pad));
    const lineCount = Math.max(...cells.map((c) => c.length));
    const h = lineCount * size * 1.3 + 2 * pad;
    pages.ensure(h);
    const top = pages.y;
    pages.raw("0.6 w 0.5 G");
    for (let ci = 0; ci < cols; ci++) pages.raw(`${(MARGIN + ci * colW).toFixed(2)} ${(top - h).toFixed(2)} ${colW.toFixed(2)} ${h.toFixed(2)} re S`);
    for (let ci = 0; ci < cols; ci++) {
      pages.y = top - pad;
      for (const line of cells[ci]!) {
        pages.y -= size * 1.3;
        pages.text(line.segs, MARGIN + ci * colW + pad, size);
      }
    }
    pages.y = top - h;
  }
  pages.y -= 10;
}

function blockTo(pages: Pages, b: Block): void {
  const full = PAGE_W - 2 * MARGIN;
  switch (b.t) {
    case "h": {
      const size = b.level === 1 ? 20 : b.level === 2 ? 15 : 12.5;
      pages.y -= b.level === 1 ? 10 : 6;
      pages.ensure(size * 3);
      paragraph(pages, words(b.runs, true), size, MARGIN, full, 5);
      return;
    }
    case "p":
      paragraph(pages, words(b.runs), 11, MARGIN, full, 6);
      return;
    case "li": {
      const mark = b.ordered ? `${b.n}.` : "•";
      pages.ensure(11 * 1.35);
      const lines = wrap(words(b.runs), 11, full - 18);
      for (const [i, line] of lines.entries()) {
        pages.ensure(11 * 1.35);
        pages.y -= 11 * 1.35;
        if (i === 0) pages.text([{ text: mark, face: "F1", x: 0 }], MARGIN + 4, 11);
        pages.text(line.segs, MARGIN + 18, 11);
      }
      pages.y -= 2;
      return;
    }
    case "table":
      table(pages, b.rows);
      return;
    case "code":
      for (const l of b.lines) paragraph(pages, [{ text: l.replace(/\t/g, "  ") || " ", face: "F5" }], 9, MARGIN + 6, full - 12, 0, 1.25);
      pages.y -= 6;
  }
}

export function buildPdf(opts: { title?: string; markdown: string; now?: Date }): Buffer {
  const pages = new Pages();
  if (opts.title) {
    paragraph(pages, words([{ text: opts.title }], true), 24, MARGIN, PAGE_W - 2 * MARGIN, 12);
  }
  for (const b of parseMarkdown(opts.markdown)) blockTo(pages, b);
  const streams = pages.finish();
  const total = streams.length;
  const footed = streams.map((s, i) => `${s}\nBT /F1 9 Tf 1 0 0 1 ${(PAGE_W / 2 - 14).toFixed(2)} 34 Tm ${hex(`${i + 1} / ${total}`)} Tj ET`);

  // Objets : 1 catalogue, 2 pages, 3 à 7 polices, 8 informations, puis (contenu = 9 + 2i, page = 10 + 2i) par page.
  const objs: string[] = [];
  const add = (body: string): number => objs.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${footed.map((_, i) => `${10 + i * 2} 0 R`).join(" ")}] /Count ${total} >>`);
  for (const base of ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Courier"]) {
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  }
  const date = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const title = [...(opts.title ?? "")].map((ch) => ch.codePointAt(0)! .toString(16).padStart(4, "0")).join("");
  add(`<< /Producer <004a00610072006f0064> /CreationDate (D:${date}) ${opts.title ? `/Title <feff${title}>` : ""} >>`);
  for (const [i, s] of footed.entries()) {
    add(`<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> >> /Contents ${9 + i * 2} 0 R >>`);
  }
  const out: Buffer[] = [Buffer.from("%PDF-1.4\n%âãÏÓ\n", "latin1")];
  const offsets: number[] = [];
  let pos = out[0]!.length;
  for (const [i, body] of objs.entries()) {
    offsets.push(pos);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    out.push(chunk);
    pos += chunk.length;
  }
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  out.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
  return Buffer.concat(out);
}
