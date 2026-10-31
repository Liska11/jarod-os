// B2 : `document_create` — un seul outil pour créer un document Word, Excel, PowerPoint ou PDF dans le dossier de travail (idée de Brahma Evo, code propre à Jarod,
// aucune dépendance ajoutée). Un seul outil, pas quatre : le registre est déjà au plafond des fournisseurs (voir tool-search).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative } from "node:path";
import { pathTarget, resolveInWorkspace } from "../builtin.js";
import type { Proof, ToolContext, ToolDef } from "../registry.js";
import { buildDocx } from "./docx.js";
import { MARKDOWN_MAX_CHARS } from "./markdown.js";
import { buildPdf } from "./pdf.js";
import { buildPptx, type Slide } from "./pptx.js";
import { buildXlsx, type Sheet } from "./xlsx.js";
import { listZip } from "./zip.js";

export type OfficeFormat = "docx" | "xlsx" | "pptx" | "pdf";
const FORMATS: Record<string, { format: OfficeFormat; label: string }> = {
  ".docx": { format: "docx", label: "Word" },
  ".xlsx": { format: "xlsx", label: "Excel" },
  ".pptx": { format: "pptx", label: "PowerPoint" },
  ".pdf": { format: "pdf", label: "PDF" },
};
/** Au-delà, le fichier est un symptôme (boucle du modèle) et pas un document. */
export const OFFICE_MAX_BYTES = 32 * 1024 * 1024;

export function formatOf(path: unknown): { format: OfficeFormat; label: string } {
  const ext = extname(String(path ?? "")).toLowerCase();
  const f = FORMATS[ext];
  if (!f) throw new Error("L'extension du fichier doit être .docx, .xlsx, .pptx ou .pdf.");
  return f;
}

/** Fabrique les octets du document, ou lève avec une phrase que le modèle peut corriger. */
export function buildDocument(args: Record<string, unknown>, now?: Date): { bytes: Buffer; format: OfficeFormat; label: string } {
  const { format, label } = formatOf(args.path);
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
  let bytes: Buffer;
  if (format === "docx" || format === "pdf") {
    if (typeof args.markdown !== "string" || !args.markdown.trim()) throw new Error(`Un ${label} se crée avec « markdown » (titres #, listes -, tableaux |, **gras**).`);
    if (args.markdown.length > MARKDOWN_MAX_CHARS) throw new Error(`« markdown » est trop long (${MARKDOWN_MAX_CHARS} caractères au plus).`);
    bytes = (format === "docx" ? buildDocx : buildPdf)({ ...(title ? { title } : {}), markdown: args.markdown, ...(now ? { now } : {}) });
  } else if (format === "xlsx") {
    if (!Array.isArray(args.sheets) || !args.sheets.length) throw new Error("Un classeur Excel se crée avec « sheets » : [{ name, rows: [[…], …] }].");
    bytes = buildXlsx({ sheets: args.sheets as Sheet[], header: args.header !== false });
  } else {
    if (!Array.isArray(args.slides) || !args.slides.length) throw new Error("Une présentation se crée avec « slides » : [{ title, bullets: […] }].");
    bytes = buildPptx({ ...(title ? { title } : {}), slides: args.slides as Slide[] });
  }
  if (bytes.length > OFFICE_MAX_BYTES) throw new Error("Le document dépasse la taille permise.");
  return { bytes, format, label };
}

async function verifyFile(file: string, format: OfficeFormat, expected: number): Promise<Proof> {
  const got = await readFile(file).catch(() => null);
  if (!got) return { status: "failed", evidence: "le fichier n'existe pas après l'écriture" };
  if (got.length !== expected) return { status: "failed", evidence: `relu : ${got.length} octets, ${expected} attendus` };
  try {
    if (format === "pdf") {
      if (!got.subarray(0, 5).equals(Buffer.from("%PDF-")) || !got.toString("latin1", Math.max(0, got.length - 8)).includes("%%EOF")) throw new Error("en-tête ou fin de PDF absents");
      return { status: "verified", evidence: `PDF relu : ${got.length} octets, en-tête et fin valides` };
    }
    const parts = listZip(got);
    return { status: "verified", evidence: `archive relue : ${got.length} octets, ${parts.length} parties (${parts.slice(0, 3).join(", ")}…)` };
  } catch (e) {
    return { status: "failed", evidence: `fichier relu mais illisible : ${(e as Error).message}` };
  }
}

export function officeTools(): ToolDef[] {
  return [
    {
      name: "document_create",
      description:
        "Crée un document Word (.docx), Excel (.xlsx), PowerPoint (.pptx) ou PDF (.pdf) dans le dossier de travail ; le format vient de l'extension de `path`. " +
        "Word et PDF : `markdown` (titres #, listes -, tableaux |, **gras**). Excel : `sheets` = [{name, rows}], une cellule est un texte, un nombre, ou {formula:\"SUM(B2:B9)\"} ; la 1re ligne est l'en-tête. " +
        "PowerPoint : `slides` = [{title, bullets}]. Ne remplace jamais un fichier existant : choisis un autre nom.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Chemin dans le dossier de travail, ex. « Budget mars.xlsx »" },
          title: { type: "string", description: "Titre du document (Word, PDF, PowerPoint)" },
          markdown: { type: "string", description: "Contenu pour .docx et .pdf" },
          sheets: {
            type: "array",
            description: "Contenu pour .xlsx",
            items: {
              type: "object",
              properties: { name: { type: "string" }, rows: { type: "array", items: { type: "array", items: {} } } },
              required: ["name", "rows"],
            },
          },
          header: { type: "boolean", description: "Excel : 1re ligne en gras et figée (défaut : oui)" },
          slides: {
            type: "array",
            description: "Contenu pour .pptx",
            items: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title"] },
          },
        },
        required: ["path"],
      },
      dangerous: true,
      source: "builtin",
      targetOf: (args) => pathTarget(args.path),
      // Refuse avant toute demande d'accord ce qui est mal formé ou hors du dossier ; la demande d'accord nomme le fichier.
      precheck(args, ctx) {
        const { bytes, label } = buildDocument(args);
        const file = resolveInWorkspace(ctx, args.path);
        if (existsSync(file)) throw new Error(`${relative(ctx.workspace ?? "", file)} existe déjà : je ne remplace pas un fichier. Choisis un autre nom.`);
        return `Créer le document ${label} « ${ctx.workspace ? relative(ctx.workspace, file) : String(args.path)} » (${Math.ceil(bytes.length / 1024)} Ko)`;
      },
      async run(args, ctx: ToolContext) {
        const { bytes, label } = buildDocument(args);
        const file = resolveInWorkspace(ctx, args.path);
        await mkdir(dirname(file), { recursive: true });
        try {
          // « wx » : échoue si le fichier existe, même s'il est apparu entre le contrôle et l'écriture.
          await writeFile(file, bytes, { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${relative(ctx.workspace ?? "", file)} existe déjà : je ne remplace pas un fichier. Choisis un autre nom.`);
          throw e;
        }
        return `Document ${label} créé : ${relative(ctx.workspace ?? "", file)} (${bytes.length} octets)`;
      },
      async verify(args, out, ctx) {
        const file = resolveInWorkspace(ctx, args.path);
        const written = /\((\d+) octets\)/.exec(out);
        if (!written) return { status: "unverifiable", evidence: "la taille écrite n'est pas dans la réponse de l'outil" };
        return verifyFile(file, formatOf(args.path).format, Number(written[1]));
      },
    },
  ];
}
