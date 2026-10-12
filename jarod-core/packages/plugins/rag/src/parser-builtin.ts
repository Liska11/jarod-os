/**
 * `DocumentParser` `builtin` : la lecture texte actuelle de plugin-rag mise sous le contrat de
 * `@jarod/contracts` (PLAN §10 phase 2, lot A). Repli PERMANENT de tout autre parseur (Docling, lot B).
 *
 * Refactor pur : le texte rendu est exactement celui de `readFileSync(chemin, "utf8")` (BOM et caractères de
 * remplacement compris), aucun chunk ne change. Le manifeste est déterministe — même octets, même manifeste,
 * aucune date ni chemin — et ne décrit que ce que le parseur sait : hash, taille, type, et les titres d'un
 * document Markdown. Pages, tableaux, images, langue : vides (`null` = « inconnu », jamais deviné).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import {
  type DocumentInput,
  DocumentManifest,
  type DocumentParser,
  type EngineInfo,
  type ParsedDocument,
} from "@jarod/contracts";

export const BUILTIN_PARSER_NAME = "builtin";
/** À changer si la forme du manifeste ou le repérage des titres change : les manifestes gardés en dépendent. */
export const BUILTIN_PARSER_VERSION = "1";

/** Extensions dont le contenu vaut d'être indexé comme texte (liste d'origine de `rag.ts`). */
export const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".html",
  ".py",
  ".rs",
  ".go",
  ".sql",
  ".sh",
  ".ps1",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".toml": "application/toml",
};
const TEXT_MIMES = new Set(["application/json", "application/yaml", "application/toml", "application/x-yaml"]);

const baseMime = (mime: string | undefined): string | undefined => mime?.split(";")[0]?.trim().toLowerCase() || undefined;
const isMarkdown = (name: string, mime: string): boolean => extname(name).toLowerCase() === ".md" || mime === "text/markdown";

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * Titres ATX (`# …` à `###### …`) d'un texte Markdown, hors blocs de code balisés. La section d'un titre va de
 * son début jusqu'au prochain titre de niveau égal ou supérieur (ses sous-sections en font partie), ou à la fin
 * du texte. Les titres soulignés (`===`, `---`) ne sont pas reconnus : limite assumée de la v1.
 */
export function markdownSections(text: string): DocumentManifest["sections"] {
  const found: { start: number; level: number; title: string }[] = [];
  let inFence = false;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) {
      const m = HEADING.exec(line);
      if (m) found.push({ start: pos, level: m[1]!.length, title: (m[2] ?? "").trim() });
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return found.map((h, i) => {
    const next = found.slice(i + 1).find((n) => n.level <= h.level);
    return { start: h.start, end: next ? next.start : text.length, page: null, level: h.level, title: h.title };
  });
}

export class BuiltinParser implements DocumentParser {
  readonly available = true;

  info(): EngineInfo {
    return { name: BUILTIN_PARSER_NAME, version: BUILTIN_PARSER_VERSION, device: "CPU" };
  }

  accepts(name: string, mime?: string): boolean {
    if (TEXT_EXT.has(extname(name).toLowerCase())) return true;
    const m = baseMime(mime);
    return m !== undefined && (m.startsWith("text/") || TEXT_MIMES.has(m));
  }

  async parse(input: DocumentInput, signal?: AbortSignal): Promise<ParsedDocument> {
    signal?.throwIfAborted();
    const bytes = "path" in input ? readFileSync(input.path) : Buffer.from(input.bytes);
    const name = "path" in input ? input.path : input.name;
    const mime = baseMime("path" in input ? undefined : input.mime) ?? MIME_BY_EXT[extname(name).toLowerCase()] ?? "text/plain";
    // Même décodage que l'ancien `readFileSync(path, "utf8")` : le BOM et les octets invalides ne sont pas « corrigés ».
    const text = bytes.toString("utf8");
    signal?.throwIfAborted();
    const manifest = DocumentManifest.parse({
      manifestVersion: 1,
      parser: { name: BUILTIN_PARSER_NAME, version: BUILTIN_PARSER_VERSION },
      source: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mime },
      language: null,
      pages: null,
      sections: isMarkdown(name, mime) ? markdownSections(text) : [],
      tables: [],
      images: [],
      errors: text.includes("\u0000") ? [{ code: "NUL_CHARACTER", page: null }] : [],
    });
    return { manifest, text };
  }
}
