// Portage de packages/core/src/tools/android.ts (rév. 2e180305).
import type { AndroidService } from "./android.js";
import { redactText } from "@jarod/kernel/redact";
import type { ToolDef } from "@jarod/plugin-tools";

/**
 * The Android tools. Running a command on a phone is marked dangerous: it goes through the same
 * approval gate as every other side effect, and one command means one approval.
 */
export function androidTools(android: AndroidService): ToolDef[] {
  return [
    {
      name: "android_devices",
      description:
        "Liste les appareils Android connectés à cet ordinateur (adb). À consulter avant de lancer " +
        "une commande, pour connaître les numéros de série disponibles.",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      run: async () => {
        if (!android.available()) {
          return "adb est introuvable sur cet ordinateur : les appareils Android ne sont pas accessibles.";
        }
        const devices = await android.devices();
        if (!devices.length) return "aucun appareil connecté (adb est là, mais la liste est vide).";
        return devices.map((d) => `${d.serial} — ${d.state}${d.model ? ` (${d.model})` : ""}`).join("\n");
      },
    },
    {
      name: "android_shell",
      description:
        "Exécute UNE commande sur un appareil Android connecté. Les enchaînements (; && | ` $ < >) sont " +
        "refusés : une seule commande par approbation, sinon l'approbation ne veut rien dire.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "La commande à exécuter sur l'appareil." },
          serial: { type: "string", description: "Numéro de série (défaut : le seul appareil connecté)." },
        },
        required: ["command"],
      },
      source: "builtin",
      dangerous: true,
      run: async (args) => {
        const serial = args.serial === undefined ? undefined : String(args.serial);
        const result = await android.shell(String(args.command ?? ""), serial);
        const head = `${result.ok ? "ok" : "échec"} (code ${result.code}, ${result.ms} ms)`;
        if (!result.ok) return `${head}\n${redactText(result.error ?? "")}`;
        return `${head}\n${result.out.trim().slice(0, 4000) || "(aucune sortie)"}`;
      },
    },
  ];
}
