// Un classeur Excel (.xlsx) : des feuilles de lignes, nombres et textes, formules permises, première ligne en gras.
import { xmlAttr, xmlText } from "./xml.js";
import { zip } from "./zip.js";

export type Cell = string | number | boolean | null | { formula: string };
export interface Sheet {
  name: string;
  rows: Cell[][];
}

export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 20_000;
export const XLSX_MAX_COLS = 100;
export const XLSX_MAX_CELLS = 200_000;
export const XLSX_MAX_TEXT = 8_000;

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * Les fonctions qui sortent du classeur (adresse web, programme, fichier d'un autre classeur) : une formule écrite par un modèle ne doit jamais en contenir.
 * Les crochets (références à un autre classeur) et les guillemets non fermés sont refusés aussi.
 */
const FORBIDDEN_FUNCTIONS = /\b(HYPERLINK|WEBSERVICE|FILTERXML|RTD|DDE|DDEAUTO|EXEC|CALL|REGISTER|REGISTER\.ID|SHELL|IMPORTDATA|IMPORTXML|IMPORTHTML|IMPORTRANGE|INFO|CELL|FORMULATEXT|EUROCONVERT|SQL\.REQUEST)\s*\(/i;
const FORMULA_CHARS = /^[A-Za-z0-9_.,:;()+\-*/^&<>=" $!%'?À-ſ]+$/;

export function checkFormula(raw: string): string {
  const f = raw.trim().replace(/^=/, "");
  if (!f) throw new Error("Formule vide.");
  if (f.length > 1_000) throw new Error("Formule trop longue (1 000 caractères au plus).");
  if (!FORMULA_CHARS.test(f)) throw new Error(`Formule refusée (caractère non permis) : ${f.slice(0, 60)}`);
  if (FORBIDDEN_FUNCTIONS.test(f)) throw new Error(`Formule refusée (fonction qui sort du classeur) : ${f.slice(0, 60)}`);
  if ((f.match(/"/g)?.length ?? 0) % 2) throw new Error(`Formule refusée (guillemets non fermés) : ${f.slice(0, 60)}`);
  let depth = 0;
  for (const ch of f.replace(/"[^"]*"/g, "")) {
    depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    if (depth < 0) break;
  }
  if (depth !== 0) throw new Error(`Formule refusée (parenthèses non appariées) : ${f.slice(0, 60)}`);
  return f;
}

export function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetName(raw: string, used: Set<string>, index: number): string {
  let name = raw.replace(/[\][:*?/\\]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Feuille${index + 1}`;
  let k = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${k++})`;
    name = `${name.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function cellXml(ref: string, cell: Cell, bold: boolean): string {
  const s = bold ? ' s="1"' : "";
  if (cell === null || cell === undefined || cell === "") return bold ? `<c r="${ref}"${s}/>` : "";
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) throw new Error(`Nombre invalide en ${ref}.`);
    return `<c r="${ref}"${s}><v>${cell}</v></c>`;
  }
  if (typeof cell === "boolean") return `<c r="${ref}"${s} t="b"><v>${cell ? 1 : 0}</v></c>`;
  if (typeof cell === "object") {
    if (typeof cell.formula !== "string") throw new Error(`Cellule ${ref} : {formula: "…"} attendu.`);
    return `<c r="${ref}"${s}><f>${xmlText(checkFormula(cell.formula))}</f></c>`;
  }
  // Un texte reste un texte, même s'il commence par « = », « + », « - » ou « @ » : écrit en chaîne en ligne, Excel ne l'évalue jamais.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(String(cell).slice(0, XLSX_MAX_TEXT))}</t></is></c>`;
}

function sheetXml(rows: Cell[][], header: boolean): string {
  const widths: number[] = [];
  const body = rows
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          const len = cell === null || cell === undefined ? 0 : typeof cell === "object" ? 10 : String(cell).length;
          widths[ci] = Math.max(widths[ci] ?? 0, Math.min(len, 60));
          return cellXml(`${columnName(ci)}${ri + 1}`, cell, header && ri === 0);
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w + 2)}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = header && rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

export function buildXlsx(opts: { sheets: Sheet[]; header?: boolean }): Buffer {
  const { sheets } = opts;
  if (!sheets.length) throw new Error("Au moins une feuille est nécessaire.");
  if (sheets.length > XLSX_MAX_SHEETS) throw new Error(`Trop de feuilles (${XLSX_MAX_SHEETS} au plus).`);
  let cells = 0;
  for (const s of sheets) {
    if (!Array.isArray(s.rows)) throw new Error(`Feuille « ${s.name} » : « rows » doit être une liste de lignes.`);
    if (s.rows.length > XLSX_MAX_ROWS) throw new Error(`Feuille « ${s.name} » : trop de lignes (${XLSX_MAX_ROWS} au plus).`);
    for (const r of s.rows) {
      if (!Array.isArray(r)) throw new Error(`Feuille « ${s.name} » : chaque ligne doit être une liste.`);
      if (r.length > XLSX_MAX_COLS) throw new Error(`Feuille « ${s.name} » : trop de colonnes (${XLSX_MAX_COLS} au plus).`);
      cells += r.length;
    }
  }
  if (cells > XLSX_MAX_CELLS) throw new Error(`Trop de cellules (${XLSX_MAX_CELLS} au plus).`);
  const header = opts.header !== false;
  const used = new Set<string>();
  const names = sheets.map((s, i) => sheetName(String(s.name ?? ""), used, i));
  return zip([
    {
      name: "[Content_Types].xml",
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlAttr(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, header) })),
  ]);
}
