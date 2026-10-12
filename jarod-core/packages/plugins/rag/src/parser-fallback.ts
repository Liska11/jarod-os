/**
 * `withFallback(primaire, repli)` : un `DocumentParser` qui essaie le parseur primaire (worker Docling, lot B) et,
 * sur TOUT échec, se replie sur le suivant (`builtin`) — jamais en silence : le code de l'échec est ajouté à
 * `manifest.errors` (PLAN §7.3 : pas de repli silencieux). Jarod-cordis — nouveau.
 *
 * Si le repli ne sait pas lire le fichier (PDF, Office : `builtin` les décoderait en déchets), l'échec est net
 * (`PARSER_UNAVAILABLE:<code>`) et AUCUN texte n'est produit — la référence pour ces formats est « aucun résultat ».
 */
import { Code, type DocumentInput, type DocumentParser, type EngineInfo, type ParsedDocument } from "@jarod/contracts";

/** Aucun parseur n'a pu lire le fichier ; `code` dit pourquoi (jamais un texte de document). */
export class ParserError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ParserError";
  }
}

const inputName = (input: DocumentInput): string => ("path" in input ? input.path : input.name);
const inputMime = (input: DocumentInput): string | undefined => ("bytes" in input ? input.mime : undefined);

/** Le code machine d'une erreur de parseur, ou un code générique — jamais son message. */
function failureCode(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  return typeof code === "string" && Code.safeParse(code).success ? code : "PARSER_ERROR";
}

export function withFallback(primary: DocumentParser, fallback: DocumentParser): DocumentParser {
  return {
    get available() {
      return primary.available || fallback.available;
    },
    info(): EngineInfo {
      return primary.available ? primary.info() : fallback.info();
    },
    accepts: (name, mime) => primary.accepts(name, mime) || fallback.accepts(name, mime),
    async parse(input, signal): Promise<ParsedDocument> {
      const name = inputName(input);
      const mime = inputMime(input);
      let code: string | null = null;
      if (primary.accepts(name, mime)) {
        if (primary.available) {
          try {
            return await primary.parse(input, signal);
          } catch (e) {
            // L'arrêt demandé par l'appelant n'est pas un échec du parseur : on ne se replie pas.
            if (signal?.aborted) throw e;
            code = failureCode(e);
          }
        } else code = "WORKER_UNAVAILABLE";
      }
      if (code !== null && !fallback.accepts(name, mime)) throw new ParserError(`PARSER_UNAVAILABLE:${code}`);
      const parsed = await fallback.parse(input, signal);
      if (code === null) return parsed;
      const errors = parsed.manifest.errors.some((e) => e.code === code && e.page === null)
        ? parsed.manifest.errors
        : [...parsed.manifest.errors, { code, page: null }];
      return { text: parsed.text, manifest: { ...parsed.manifest, errors } };
    },
  };
}
