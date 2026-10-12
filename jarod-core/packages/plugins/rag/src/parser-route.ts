/**
 * `routeByExtension(a, b, …)` : un `DocumentParser` qui confie chaque fichier au PREMIER parseur qui l'accepte
 * (extension ou type MIME). Sert à mettre Docling sur les formats Office et pdfium sur les PDF (DECISIONS 2026-09-30,
 * option b). Aucun repli ici : `withFallback` l'enveloppe. Jarod-cordis — nouveau.
 */
import type { DocumentInput, DocumentParser, EngineInfo, ParsedDocument } from "@jarod/contracts";
import { ParserError } from "./parser-fallback.js";

const inputName = (input: DocumentInput): string => ("path" in input ? input.path : input.name);
const inputMime = (input: DocumentInput): string | undefined => ("bytes" in input ? input.mime : undefined);

export function routeByExtension(...parsers: DocumentParser[]): DocumentParser {
  return {
    get available() {
      return parsers.some((p) => p.available);
    },
    info(): EngineInfo {
      return (parsers.find((p) => p.available) ?? parsers[0]!).info();
    },
    accepts: (name, mime) => parsers.some((p) => p.accepts(name, mime)),
    async parse(input, signal): Promise<ParsedDocument> {
      const name = inputName(input);
      const mime = inputMime(input);
      const parser = parsers.find((p) => p.accepts(name, mime));
      if (!parser) throw new ParserError("PARSER_UNAVAILABLE:NO_PARSER");
      return parser.parse(input, signal);
    },
  };
}
