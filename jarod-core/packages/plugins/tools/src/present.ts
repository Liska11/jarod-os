// Portage de packages/core/src/tools/present.ts (rév. 2e180305).
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { EventStoreService } from "@jarod/plugin-storage";
import type { ScheduleDelivery } from "@jarod/plugin-scheduler";
import { resolveInWorkspace } from "./builtin.js";
import type { ToolDef } from "./registry.js";

/** Below every gateway's bot limit (Discord's 25 MB is the smallest). */
export const MAX_PRESENT_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5;

export interface PresentDeps {
  events?: EventStoreService | null;
  /** The messaging chat the conversation comes from, if any. */
  originOf(sessionId: string): ScheduleDelivery | null;
  sendFile(target: ScheduleDelivery, name: string, data: Buffer, caption?: string): Promise<void>;
}

/**
 * `present` (DeepSeek Harness' deliverables, Hermes' deliverable mode): the agent hands over the files
 * it produced — a report, a spreadsheet, a chart. In a Telegram, Discord or Slack conversation they
 * are sent there as attachments; in the app they are listed with their full path. Only files of the
 * working folder, and each hand-over is logged with the conversation.
 */
export function presentTools(d: PresentDeps): ToolDef[] {
  return [
    {
      name: "present",
      description:
        "Remet à l'utilisateur les fichiers que tu as produits (rapport, tableur, image, PDF…). Dans une conversation Telegram, Discord ou Slack, ils sont envoyés en pièces jointes ; dans l'application, leur chemin est affiché. Chemins relatifs au dossier de travail, 5 fichiers de 20 Mo au plus.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          caption: { type: "string", description: "Une phrase qui accompagne l'envoi." },
        },
        required: ["paths"],
      },
      source: "builtin",
      async run(args, ctx) {
        const paths = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean) : [];
        if (!paths.length) throw new Error("Aucun fichier.");
        if (paths.length > MAX_FILES) throw new Error(`Au plus ${MAX_FILES} fichiers à la fois.`);
        const files = paths.map((p) => {
          const full = resolveInWorkspace(ctx, p);
          const info = statSync(full, { throwIfNoEntry: false });
          if (!info?.isFile()) throw new Error(`Fichier introuvable : ${p}`);
          if (info.size > MAX_PRESENT_BYTES)
            throw new Error(`Fichier trop gros pour un envoi (${info.size} octets) : ${p}`);
          return { full, name: basename(full), size: info.size };
        });
        const caption = typeof args.caption === "string" && args.caption.trim() ? args.caption.trim() : undefined;
        const origin = d.originOf(ctx.sessionId);
        d.events?.append(`session:${ctx.sessionId}`, "deliverable", {
          files: files.map((f) => ({ path: f.full, size: f.size })),
          to: origin ? `${origin.gateway}:${origin.chatId}` : "app",
        });
        if (!origin) {
          return `Fichiers remis :\n${files.map((f) => `- ${f.full} (${f.size} o)`).join("\n")}`;
        }
        const sent: string[] = [];
        for (const [i, f] of files.entries()) {
          await d.sendFile(origin, f.name, readFileSync(f.full), i === 0 ? caption : undefined);
          sent.push(f.name);
        }
        return `Envoyés sur ${origin.gateway} : ${sent.join(", ")}`;
      },
    },
  ];
}
