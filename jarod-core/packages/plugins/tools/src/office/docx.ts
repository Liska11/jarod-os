// Un document Word (.docx) à partir du Markdown de documents : styles de titre, listes, tableaux, code.
import { type Block, parseMarkdown, type Run } from "./markdown.js";
import { xmlAttr, xmlText } from "./xml.js";
import { zip } from "./zip.js";

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function runXml(r: Run): string {
  const props = `${r.bold ? "<w:b/>" : ""}${r.italic ? "<w:i/>" : ""}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlText(r.text)}</w:t></w:r>`;
}

const para = (runs: readonly Run[], style?: string, pPr = ""): string =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${pPr}</w:pPr>${runs.map(runXml).join("")}</w:p>`;

function table(rows: Run[][][]): string {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const width = Math.floor(9000 / cols);
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows
    .map((row, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => {
        const runs = (row[ci] ?? [{ text: "" }]).map((r) => (ri === 0 ? { ...r, bold: true } : r));
        return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(runs)}</w:tc>`;
      }).join("");
      return `<w:tr>${ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width * cols}" w:type="dxa"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

function blockXml(b: Block): string {
  switch (b.t) {
    case "h":
      return para(b.runs, `Heading${b.level}`);
    case "p":
      return para(b.runs);
    case "li": {
      const mark: Run = { text: b.ordered ? `${b.n}. ` : "• " };
      return para([mark, ...b.runs], undefined, '<w:spacing w:after="40"/><w:ind w:left="567" w:hanging="283"/>');
    }
    case "table":
      return table(b.rows);
    case "code":
      return b.lines.map((l) => para([{ text: l || " ", code: true }], "Code")).join("");
  }
}

const style = (id: string, name: string, ppr: string, rpr: string, extra = ""): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;

const BORDER = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;

const STYLES =
  `${XML_HEAD}<w:styles ${NS}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="fr-FR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  style("Title", "Title", '<w:spacing w:after="240"/>', '<w:b/><w:sz w:val="48"/><w:szCs w:val="48"/>', '<w:next w:val="Normal"/>') +
  style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>', '<w:next w:val="Normal"/>') +
  style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>', '<w:next w:val="Normal"/>') +
  style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>', '<w:next w:val="Normal"/>') +
  style("Code", "Code", '<w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>') +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(BORDER).join("")}</w:tblBorders></w:tblPr></w:style>` +
  "</w:styles>";

export function buildDocx(opts: { title?: string; markdown: string; now?: Date }): Buffer {
  const blocks = parseMarkdown(opts.markdown);
  const body = [opts.title ? para([{ text: opts.title }], "Title") : "", ...blocks.map(blockXml)].join("");
  const created = (opts.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  return zip([
    {
      name: "[Content_Types].xml",
      data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "word/styles.xml", data: STYLES },
    {
      name: "word/document.xml",
      data: `${XML_HEAD}<w:document ${NS}><w:body>${body || "<w:p/>"}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    },
    {
      name: "docProps/core.xml",
      data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlAttr(opts.title ?? "")}</dc:title><dc:creator>Jarod</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`,
    },
  ]);
}
