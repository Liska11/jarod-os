/**
 * Écran « Artefacts » (cockpit, lot 5) : ce que l'agent a produit — diagrammes, vidéos, analyses, rapports — avec l'état du fichier
 * maintenant (intact, modifié, disparu). Le renderer ne désigne qu'un identifiant ; il ne fournit jamais un chemin.
 *  - aperçu : le texte d'un HTML/SVG (affiché dans un cadre SANS script) ou une image en data URL, bornés, et seulement si intact ;
 *  - ouvrir : avec l'application associée, jamais un programme ni un script ;
 *  - oublier : retire de la liste, le fichier reste à sa place.
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Artifact } from "@jarod/plugin-agent";
import type { HandlerContext } from "./context.js";

const ID = /^[0-9a-f-]{36}$/i;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const NEVER_OPEN = new Set([".exe", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".js", ".msi", ".lnk", ".hta", ".scr", ".reg", ".jar", ".py"]);

export type ArtifactRow = Artifact & { state: "intact" | "modified" | "missing" | "unknown" };
export type ArtifactPreview = { kind: "html" | "svg" | "text"; text: string } | { kind: "image"; dataUrl: string } | { kind: "none"; reason: string };

export function createArtifactHandlers(ctx: HandlerContext) {
  const store = () => ctx.kernel().agent.artifacts;
  const find = (id: unknown) => (typeof id === "string" && ID.test(id) ? store().get(id) : undefined);
  return {
    "artifacts-list": (): ArtifactRow[] => store().list({ limit: 200 }).map((a) => ({ ...a, state: store().check(a.id) })),
    "artifact-preview": (id: unknown): ArtifactPreview => {
      const a = find(id);
      if (!a) return { kind: "none", reason: "artefact inconnu" };
      const state = store().check(a.id);
      if (state !== "intact") return { kind: "none", reason: state === "missing" ? "le fichier a disparu" : "le fichier a changé depuis son enregistrement" };
      const size = statSync(a.path).size;
      if (a.mime === "text/html" || a.mime === "image/svg+xml" || a.mime.startsWith("text/") || a.mime === "application/json") {
        if (size > MAX_TEXT) return { kind: "none", reason: "trop volumineux pour un aperçu" };
        const text = readFileSync(a.path, "utf8");
        return { kind: a.mime === "text/html" ? "html" : a.mime === "image/svg+xml" ? "svg" : "text", text };
      }
      if (a.mime.startsWith("image/")) {
        if (size > MAX_IMAGE) return { kind: "none", reason: "trop volumineux pour un aperçu" };
        return { kind: "image", dataUrl: `data:${a.mime};base64,${readFileSync(a.path).toString("base64")}` };
      }
      return { kind: "none", reason: "pas d'aperçu pour ce type : l'ouvrir" };
    },
    "artifact-open": async (id: unknown): Promise<{ success: boolean; error?: string }> => {
      const a = find(id);
      if (!a) return { success: false, error: "artefact inconnu" };
      if (NEVER_OPEN.has(extname(a.path).toLowerCase())) return { success: false, error: "un programme ou un script ne s'ouvre pas d'ici" };
      if (store().check(a.id) === "missing") return { success: false, error: "le fichier a disparu" };
      const err = await ctx.shell.openPath(a.path);
      return err ? { success: false, error: err } : { success: true };
    },
    "artifact-forget": (id: unknown): { success: boolean } => {
      const a = find(id);
      return { success: Boolean(a && store().forget(a.id)) };
    },
  };
}
