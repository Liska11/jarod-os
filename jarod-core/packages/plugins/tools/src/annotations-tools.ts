// Portage de packages/core/src/tools/annotations.ts (rév. 2e180305).
import type { AnnotationService } from "@jarod/plugin-memory";
import { parseUnifiedDiff } from "@jarod/plugin-memory";
import type { ToolDef } from "./registry.js";

/**
 * The annotation tools. They only touch notes kept inside the app: reviewing a diff is not a side
 * effect on the world, so none of them asks for approval. What the notes do afterwards is the
 * caller's business — the coding loop reads them, it is not started from here.
 */
export function annotationTools(annotations: AnnotationService): ToolDef[] {
  return [
    {
      name: "diff_numbered",
      description:
        "Relit un diff unifié et le rend avec ses numéros de ligne (nouvelle ligne et ancienne), pour " +
        "choisir la ligne exacte dont on veut parler. À faire avant d'annoter.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Le nom de la revue (ex. le dossier ou la session)." },
          diff: { type: "string", description: "Le diff unifié à relire." },
        },
        required: ["ref", "diff"],
      },
      source: "builtin",
      run: async (args) => {
        const files = parseUnifiedDiff(String(args.diff ?? ""));
        if (!files.length) return "ce texte n'est pas un diff unifié (aucun fichier reconnu).";
        return files
          .map((file) => {
            const lines = file.hunks.flatMap((hunk) =>
              hunk.lines.map((line) => {
                const number = line.kind === "add" ? line.newLine : line.kind === "del" ? line.oldLine : line.newLine;
                return `${String(number ?? "-").padStart(5)} ${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`;
              }),
            );
            return `${file.path} (+${file.added}/-${file.removed})\n${lines.join("\n")}`;
          })
          .join("\n\n");
      },
    },
    {
      name: "annotate_line",
      description:
        "Attache une note à une ligne d'un diff. La ligne est mémorisée telle qu'elle était : si elle change, " +
        "la note est signalée comme détachée au lieu de disparaître ou de pointer ailleurs.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Le nom de la revue." },
          file: { type: "string", description: "Le fichier, tel que le diff le nomme." },
          line: { type: "number", description: "Le numéro de ligne (nouvelle ligne par défaut)." },
          text: { type: "string", description: "La note." },
          side: { type: "string", enum: ["new", "old"], description: "new (défaut) ou old." },
          diff: { type: "string", description: "Le diff, pour mémoriser la ligne au moment où la note est prise." },
        },
        required: ["ref", "file", "line", "text"],
      },
      source: "builtin",
      run: async (args) => {
        const side = args.side === "old" ? ("old" as const) : ("new" as const);
        const line = Number(args.line);
        const file = String(args.file ?? "");
        let anchor = "";
        if (typeof args.diff === "string") {
          const found = parseUnifiedDiff(args.diff)
            .find((candidate) => candidate.path === file)
            ?.hunks.flatMap((hunk) => hunk.lines)
            .find((candidate) => (side === "old" ? candidate.oldLine : candidate.newLine) === line);
          anchor = found?.text ?? "";
        }
        const entry = annotations.add(String(args.ref ?? ""), file, line, String(args.text ?? ""), { side, anchor });
        return `note ${entry.id} sur ${entry.file}:${entry.line}${anchor ? ` (« ${anchor.trim()} »)` : " (ligne inconnue de ce diff)"}`;
      },
    },
    {
      name: "annotations_list",
      description:
        "Les notes d'une revue. Avec le diff, chacune est marquée [détachée] quand la ligne visée ne lit plus la même chose.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Le nom de la revue." },
          diff: { type: "string", description: "Le diff actuel, pour vérifier que les lignes n'ont pas bougé." },
        },
        required: ["ref"],
      },
      source: "builtin",
      run: async (args) => {
        const ref = String(args.ref ?? "");
        const entries = typeof args.diff === "string" ? annotations.review(ref, args.diff) : annotations.list(ref);
        if (!entries.length) return "aucune note pour cette revue.";
        return entries
          .map((entry) => {
            const where = `${entry.id} — ${entry.file}:${entry.line}${entry.detached ? " [détachée]" : ""}`;
            return `${where}\n  ${entry.text}${entry.anchor ? `\n  > ${entry.anchor}` : ""}`;
          })
          .join("\n");
      },
    },
    {
      name: "annotation_remove",
      description: "Retire une note par son identifiant.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "L'identifiant rendu par annotate_line." } },
        required: ["id"],
      },
      source: "builtin",
      run: async (args) =>
        (await Promise.resolve(annotations.remove(String(args.id ?? "")))) ? "note retirée." : "aucune note de ce nom.",
    },
  ];
}
