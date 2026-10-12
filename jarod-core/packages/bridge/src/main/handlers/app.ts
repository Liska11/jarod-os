/**
 * Application : version, quitter, relancer, presse-papiers, liens externes, apparence native, correcteur.
 * Sources : SANK-UI `src/main/ipc/register.ts:720,732,1765-1767,3160-3162`, `app/updater.ts:40`,
 * `app/start.ts:150-158` + `security.ts:4,11-23`, `register.ts:1943-1988` (apparence, correcteur)
 * (rév. 3aaadb0, MIT © github.com/fathah).
 */
import { existsSync, readFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { desktopConfigFile, readDesktopConfig, writeDesktopConfig } from "./config.js";
import type { HandlerContext } from "./context.js";

/** `installer.ts:1509-1511` : seuls ces fichiers se lisent (nom inconnu → `agent.log`). */
const LOG_FILES = ["agent.log", "errors.log", "gateway.log"];

/** `security.ts:4` : seuls ces protocoles sortent vers le système. */
const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

export function isAllowedExternalUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string") return false;
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/**
 * `GpuStatus` (SANK-UI `shared/gpu.ts:7-24`, `main/gpu-fallback.ts:96-106,225-239,297-302`). Jarod garde la
 * PRÉFÉRENCE de Réglages › Apparence (`desktop.json`, clé `gpuPreference`, lue au démarrage par `gpu.ts` : « off »
 * = `app.disableHardwareAcceleration()`), mais n'a ni repli automatique après plantage du GPU (pas de drapeau), ni
 * variable d'environnement : `reason` vaut « preference » ou null, `canReenable` est toujours faux (la relance en
 * un clic ne concerne que les replis après plantage) et `reenable-gpu` répond false, comme SANK-UI sans repli.
 */
export const GPU_PREFERENCES = ["auto", "on", "off"] as const;
export type GpuPreferenceMode = (typeof GPU_PREFERENCES)[number];

export function readGpuPreference(desktopJson: string): GpuPreferenceMode {
  const saved = readDesktopConfig(desktopJson)[GPU_KEY];
  return GPU_PREFERENCES.includes(saved as GpuPreferenceMode) ? (saved as GpuPreferenceMode) : "auto";
}

const GPU_KEY = "gpuPreference";

export function createAppHandlers(ctx: HandlerContext) {
  return {
    "get-gpu-status": () => {
      const boot = ctx.shell.gpuBootPreference?.() ?? "auto";
      return {
        disabled: boot === "off",
        reason: boot === "off" ? ("preference" as const) : null,
        flagWrittenAt: null,
        canReenable: false,
        preference: readGpuPreference(desktopConfigFile(ctx.kernel())),
        bootPreference: boot,
      };
    },
    // register.ts:728-731 : valeur contrôlée par le main ; écrite pour le PROCHAIN lancement (gpu-fallback.ts:96-106).
    "set-gpu-preference": (mode: unknown): boolean => {
      if (!GPU_PREFERENCES.includes(mode as GpuPreferenceMode)) return false;
      const file = desktopConfigFile(ctx.kernel());
      try {
        writeDesktopConfig(file, { ...readDesktopConfig(file), [GPU_KEY]: mode });
        return true;
      } catch (err) {
        console.error("[GPU] préférence non enregistrée :", err);
        return false;
      }
    },
    "reenable-gpu": () => false,
    /**
     * register.ts:1185 (`hermes dump`, texte de support copié par l'utilisateur). Jarod n'a pas de CLI Hermes : état
     * du système et du kernel servi — versions, plate-forme, profil, fournisseurs CONFIGURÉS (identifiants seuls,
     * jamais une clé), modèle actif, compte des skills, serveurs MCP et passerelles actives. Aucun chemin personnel.
     */
    "run-hermes-dump": (): string => {
      const k = ctx.kernel();
      const s = k.agent.settings;
      const configured = k.agent.providers.list().filter((p) => p.configured).map((p) => p.id);
      const gateways = (["telegram", "discord", "slack", "email", "whatsapp"] as const).filter((id) => s.get(id).enabled);
      const lines = [
        `Jarod-One ${ctx.shell.appVersion()}`,
        `Plate-forme : ${platform()} ${release()} (${arch()}), ${cpus().length} cœurs, ${Math.round(totalmem() / 2 ** 30)} Gio`,
        `Moteurs : node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ""}${process.versions.chrome ? `, chrome ${process.versions.chrome}` : ""}`,
        `Profil : ${k.profile}`,
        `Modèle actif : ${s.get("activeProvider") || "—"} / ${s.get("activeModel") || "—"}`,
        `Fournisseurs configurés : ${configured.join(", ") || "aucun"}`,
        `Skills : ${k.agent.skills.list().length}`,
        `Serveurs MCP : ${s.get("mcpServers").length}`,
        `Passerelles activées : ${gateways.join(", ") || "aucune"}`,
        `Accélération matérielle : ${ctx.shell.gpuBootPreference?.() ?? "auto"}`,
      ];
      return `${lines.join("\n")}\n`;
    },
    /**
     * D1(b) — `register.ts:3254-3259`, `installer.ts:1504-1526` (corps repris) : les N dernières lignes d'un journal
     * de la liste fermée, dans `<userData>/logs` (Hermes : `HERMES_HOME/logs`). Jarod n'écrit pas encore ces
     * journaux (plugin-observability, P4) : fichier absent → `{ content: "", path }`, la réponse SANK-UI.
     */
    "read-logs": (logFile?: unknown, lines?: unknown) => {
      const file = typeof logFile === "string" && LOG_FILES.includes(logFile) ? logFile : "agent.log";
      const n = typeof lines === "number" && lines > 0 ? Math.floor(lines) : 200;
      const fullPath = join(ctx.shell.logsDir(), file);
      if (!existsSync(fullPath)) return { content: "", path: fullPath };
      try {
        return { content: readFileSync(fullPath, "utf-8").split("\n").slice(-n).join("\n"), path: fullPath };
      } catch {
        return { content: "", path: fullPath };
      }
    },
    "get-app-version": () => ctx.shell.appVersion(),
    "quit-app": () => ctx.shell.quit(),
    "relaunch-app": () => ctx.shell.relaunch(),
    "copy-to-clipboard": (text: unknown) => ctx.shell.writeClipboard(typeof text === "string" ? text : ""),
    // Écart SANK-UI : une URL refusée lève (SANK journalisait et répondait « fait ») — jamais de succès apparent.
    "open-external": async (url: unknown) => {
      if (!isAllowedExternalUrl(url)) throw new Error("[oneai] URL externe refusée (http, https ou mailto seulement)");
      await ctx.shell.openExternal(url);
    },
    /**
     * register.ts:3163-3170 + `web-preview-inspector.ts:280-331` : inspection d'un aperçu web (`<webview>` de la
     * fenêtre). CSP L3 (`frame-src 'none'`) et pas de balise `<webview>` chez Jarod : aucun aperçu n'existe, tout
     * identifiant est donc celui que SANK-UI rejette (« Invalid web preview webContents ID »).
     */
    "web-preview-inspect": (): never => {
      throw new Error("[oneai] Invalid web preview webContents ID (aucun aperçu web : CSP L3)");
    },
    "web-preview-cancel-inspection": (): never => {
      throw new Error("[oneai] Invalid web preview webContents ID (aucun aperçu web : CSP L3)");
    },
    // register.ts:1943-1947 : seules ces trois valeurs changent l'apparence ; toute autre est ignorée.
    "set-native-appearance": (source: unknown) => {
      if (source === "dark" || source === "light" || source === "system") ctx.shell.setThemeSource(source);
    },
    // register.ts:1949-1970, corps verbatim ; la session est celle de NOTRE fenêtre (seul expéditeur admis).
    "get-spell-checker-info": () => {
      const { available, selected, preferredSystem } = ctx.shell.spellChecker();
      const availableByLowercase = new Map(available.map((language) => [language.toLowerCase(), language]));
      const system: string[] = [];
      for (const preferred of preferredSystem) {
        const normalized = preferred.toLowerCase();
        const exact = availableByLowercase.get(normalized);
        const base = normalized.split("-")[0];
        const regional = available.find((language) => language.toLowerCase().startsWith(`${base}-`));
        const match = exact || regional;
        if (match && !system.includes(match)) system.push(match);
      }
      return { available, selected, system };
    },
    // register.ts:1973-1988, corps verbatim : seules les langues disponibles, sans doublon ; tout autre argument
    // → liste vide (correcteur coupé), comme la source. Non persisté par Jarod (la session Chromium le garde).
    "set-spell-checker-languages": (value: unknown) => {
      const available = new Set(ctx.shell.spellChecker().available);
      const languages = Array.isArray(value)
        ? Array.from(new Set(value.filter((item): item is string => typeof item === "string" && available.has(item))))
        : [];
      ctx.shell.setSpellCheckerLanguages(languages);
      return languages;
    },
  };
}
