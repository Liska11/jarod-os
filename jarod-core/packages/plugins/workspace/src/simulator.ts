/**
 * Simulateurs et émulateurs pour les agents (repris de PandaCode) : iOS via `xcrun simctl`, Android via `adb`.
 * Le listage ne modifie rien. La capture d'écran écrit un fichier PNG à l'emplacement donné.
 */
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { execArgs } from "./exec.js";
import { WorkspaceError } from "./git.js";

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Device {
  platform: Platform;
  name: string;
  /** UDID iOS ou numéro de série Android : c'est ce qui sert à viser un appareil. */
  id: string;
  state: string;
}

/** Sortie JSON de `xcrun simctl list devices available --json`. Seuls les appareils disponibles comptent. */
export function parseSimctl(json: string): Device[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, { name?: string; udid?: string; state?: string; isAvailable?: boolean }[]> };
  const devices: Device[] = [];
  for (const list of Object.values(parsed.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false || !d.udid) continue;
      devices.push({ platform: "ios", name: d.name ?? d.udid, id: d.udid, state: d.state ?? "inconnu" });
    }
  }
  return devices;
}

/** Sortie de `adb devices -l` : une ligne par appareil, « <série> <état> … », après un en-tête. */
export function parseAdb(output: string): Device[] {
  const devices: Device[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state || serial === "List" || serial === "*") continue;
    const model = rest.find((t) => t.startsWith("model:"))?.slice("model:".length) ?? serial;
    devices.push({ platform: "android", name: model.replace(/_/g, " "), id: serial, state });
  }
  return devices;
}

export interface Listing {
  devices: Device[];
  /** Raison pour laquelle la plateforme n'a pas pu être listée (outil absent, par exemple). */
  error?: string;
}

export async function listSimulators(): Promise<{ ios: Listing; android: Listing }> {
  const ios = await execArgs("xcrun", ["simctl", "list", "devices", "available", "--json"], { timeoutMs: 30_000 });
  const android = await execArgs("adb", ["devices", "-l"], { timeoutMs: 30_000 });
  return {
    ios: ios.error || ios.code !== 0 ? { devices: [], error: ios.error ?? ios.stderr } : listing(() => parseSimctl(ios.stdout.toString("utf8"))),
    android: android.error || android.code !== 0 ? { devices: [], error: android.error ?? android.stderr } : listing(() => parseAdb(android.stdout.toString("utf8"))),
  };
}

function listing(parse: () => Device[]): Listing {
  try {
    return { devices: parse() };
  } catch (error) {
    return { devices: [], error: `sortie illisible : ${(error as Error).message}` };
  }
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface ScreenshotOptions {
  platform: Platform;
  /** Appareil visé. Sans lui : l'appareil démarré (iOS) ou l'unique appareil connecté (Android). */
  device?: string;
  /** Chemin absolu du fichier PNG à écrire. */
  out: string;
}

export async function screenshot(options: ScreenshotOptions): Promise<string> {
  if (!PLATFORMS.includes(options.platform)) throw new WorkspaceError(`plateforme inconnue : « ${options.platform} »`);
  if (!isAbsolute(options.out) || !options.out.toLowerCase().endsWith(".png")) throw new WorkspaceError("la capture doit être un chemin absolu se terminant par .png");
  if (options.device !== undefined && !ID_RE.test(options.device)) throw new WorkspaceError(`identifiant d'appareil refusé : « ${options.device} »`);

  if (options.platform === "ios") {
    const target = options.device ?? "booted";
    const result = await execArgs("xcrun", ["simctl", "io", target, "screenshot", options.out], { timeoutMs: 60_000 });
    if (result.error || result.code !== 0) throw new WorkspaceError(`capture iOS : ${result.stderr || result.error}`);
    return options.out;
  }

  const args = [...(options.device ? ["-s", options.device] : []), "exec-out", "screencap", "-p"];
  const result = await execArgs("adb", args, { timeoutMs: 60_000 });
  if (result.error || result.code !== 0) throw new WorkspaceError(`capture Android : ${result.stderr || result.error}`);
  if (!result.stdout.subarray(0, 4).equals(PNG_SIGNATURE)) throw new WorkspaceError("la sortie d'adb n'est pas un PNG");
  await writeFile(options.out, result.stdout);
  return options.out;
}
