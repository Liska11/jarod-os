/**
 * Dossier de travail PAR DÉFAUT (SPECS-P5-WORKSPACE.md) : canaux PROPRES à Jarod (`JAROD_INVOKE_CHANNELS`, absents de hermesAPI).
 * Le renderer ne tape jamais de chemin : il appelle `select-folder` (boîte native, qui rend le chemin et l'enregistre comme choisi pour
 * ce lancement) puis `set-default-workspace` avec ce chemin. La garde `FileGate.pickedOnly` est plus stricte que celle du bouton du
 * Chat : le dossier doit avoir été choisi dans la boîte native pendant ce lancement (la valeur déjà enregistrée redonnée est
 * acceptée). Seul le réglage global `workspace` change : le dossier d'une conversation déjà épinglée ne bouge pas (`settingsFor`).
 */
import type { FileGate } from "../file-gate.js";
import type { HandlerContext } from "./context.js";

export function createWorkspaceHandlers(ctx: HandlerContext, gate: FileGate) {
  const settings = () => ctx.kernel().agent.settings;
  return {
    "get-default-workspace": (): string | null => settings().get("workspace") ?? null,
    /** `null` ou texte vide : efface le réglage. Sinon rend le chemin réel enregistré. */
    "set-default-workspace": (folder: unknown): string | null => {
      if (folder === null || folder === undefined || folder === "") {
        settings().set("workspace", null);
        gate.log({ op: "default-workspace-set", channel: "set-default-workspace", reason: "effacé" });
        return null;
      }
      const real = gate.pickedOnly("set-default-workspace", folder, settings().get("workspace") ?? null);
      settings().set("workspace", real);
      gate.log({ op: "default-workspace-set", channel: "set-default-workspace", path: real });
      return real;
    },
  };
}
