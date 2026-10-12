// Portage de packages/core/src/tools/rag.ts (rév. 2e180305).
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { RagService } from "@jarod/plugin-rag";
import { resolveInWorkspace } from "./builtin.js";
import type { ToolDef } from "./registry.js";

/** Fichiers refusés d'une indexation de dossier : les cinq premiers avec leur code, puis « … et N autre(s) » (DECISIONS 2026-10-01). */
export function describeRefused(refused: readonly { file: string; code: string }[]): string {
  if (!refused.length) return "";
  const shown = refused.slice(0, 5).map((x) => `${x.file} (${x.code})`).join(", ");
  const more = refused.length > 5 ? ` … et ${refused.length - 5} autre(s)` : "";
  return `, ${refused.length} refusé(s) : ${shown}${more}`;
}

/**
 * The retrieval tools. Without them the index would only be reachable from the settings screen, and
 * the model could not use what it has been given. They are OFFERED to the model only while the RAG switch is on (`available`, read at
 * each step : switching on needs no restart); running one while it is off still answers with the service's refusal (§ 19).
 */
export function ragTools(rag: RagService): ToolDef[] {
  return [
    {
      name: "rag_search",
      description:
        "Recherche sémantique dans les documents indexés localement (RAG). Renvoie les passages les " +
        "plus proches, avec leur source et leur score. À utiliser avant de répondre sur un projet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Ce que l'on cherche, en langage naturel." },
          k: { type: "integer", description: "Nombre de passages à renvoyer (défaut : réglage RAG)." },
        },
        required: ["query"],
      },
      source: "builtin",
      available: () => rag.isEnabled(),
      run: async (args) => {
        const hits = await rag.search(String(args.query ?? ""), args.k === undefined ? undefined : Number(args.k));
        if (!hits.length) return "Aucun passage trouvé : l'index est peut-être vide (outil rag_index).";
        return hits
          .map((h) => `[${h.score.toFixed(3)}] ${h.source ?? h.docId} — ${h.text.replace(/\s+/g, " ").slice(0, 600)}`)
          .join("\n\n");
      },
    },
    {
      name: "rag_index",
      description:
        "Indexe pour la recherche (RAG) un fichier ou un dossier du dossier de travail : texte, PDF, Office. " +
        "C'est l'outil à appeler quand l'utilisateur demande d'indexer un document : inutile d'écrire un script. " +
        "À relancer après avoir modifié un fichier : un contenu inchangé n'est pas réindexé, un contenu modifié remplace l'ancien.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Fichier ou dossier, relatif au dossier de travail." },
        },
        required: ["path"],
      },
      source: "builtin",
      available: () => rag.isEnabled(),
      run: async (args, ctx) => {
        try {
          // Through the workspace guard, so indexing cannot reach outside the working folder.
          const target = resolveInWorkspace(ctx, args.path);
          if (statSync(target).isDirectory()) {
            const r = await rag.indexFolder(target);
            const docs = r.documents === undefined ? "" : ` PDF/Office : ${r.documents} lu(s)${describeRefused(r.refused ?? [])}.`;
            return `Dossier indexé : ${r.files} fichier(s), ${r.chunks} passage(s) ajouté(s), ${r.deduped} déjà à jour.${docs}`;
          }
          if (rag.documentExtensions().has(extname(target).toLowerCase())) {
            // PDF / Office : lu par son worker (texte extrait + octets d'origine), jamais décodé comme du texte.
            const d = await rag.indexDocument(target, String(args.path));
            return d.deduped ? `Déjà indexé, contenu inchangé : ${d.docId}.` : `Indexé : ${d.docId}, ${d.chunks} passage(s).`;
          }
          const bytes = readFileSync(target);
          const r = await rag.ingest(bytes.toString("utf8"), {
            docId: String(args.path),
            source: String(args.path),
            bytes,
          });
          return r.deduped
            ? `Déjà indexé, contenu inchangé : ${r.docId}.`
            : `Indexé : ${r.docId}, ${r.chunks} passage(s).`;
        } catch (e) {
          return `Indexation impossible : ${(e as Error).message}`;
        }
      },
    },
  ];
}
