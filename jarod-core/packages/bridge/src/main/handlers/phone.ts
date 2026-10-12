/**
 * Téléphone et Android (SPECS-P5-UI-PARITE.md §3.3) : canaux PROPRES à Jarod `phone-status`, `phone-bridge-set`, `phone-pairing`, `phone-revoke`,
 * `android-pick-adb`, `android-set-adb`. Le pont téléphone (page servie sur le réseau local, appairage par code) et les outils adb existaient dans
 * le kernel sans canal ni écran (STATE : « portés mais sans canal ni écran dans le desktop »).
 *
 * - le pont écoute sur TOUT le réseau local (`0.0.0.0`) : l'allumer demande une confirmation NATIVE qui le dit ; l'éteindre n'en demande aucune ;
 * - le code d'appairage est court et à usage unique ; il s'affiche à l'utilisateur, jamais dans un journal ; révoquer un téléphone coupe son jeton
 *   et ses flux tout de suite ;
 * - le programme `adb` est du CODE lancé par les outils de l'agent : son chemin ne se tape pas, il vient de la boîte « Ouvrir » NATIVE (valable pour
 *   CE lancement) ; vide = celui du PATH. Le jeton d'appareil et les sorties de commandes n'arrivent jamais ici.
 */
import { realpathSync } from "node:fs";
import type { HandlerContext } from "./context.js";

export interface PhoneStatus {
  mobile: { running: boolean; port: number; url: string; devices: { deviceId: string; name: string; pairedAt: number; lastSeen: number }[] };
  android: { adb: string | null; configured: string; state: "ready" | "unconfigured" | "missing"; devices: { serial: string; state: string; model: string; product: string }[] };
}

export function createPhoneHandlers(ctx: HandlerContext) {
  const hub = () => ctx.kernel().gateways;
  const settings = () => ctx.kernel().agent.settings;
  const pickedAdb = new Set<string>();
  const real = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };

  const status = async (): Promise<PhoneStatus> => {
    const m = hub().mobile.status();
    const android = hub().android;
    const devices = await android.devices().catch(() => []);
    return {
      mobile: { running: m.running, port: m.port, url: m.url, devices: m.devices },
      android: {
        adb: android.adb(),
        configured: settings().get("android").adbPath,
        // § 21 : hors de « ready » (rien de choisi ni sur le PATH, ou le fichier choisi n'existe plus) rien n'est lancé à l'affichage.
        state: android.state(),
        devices: devices.map((d) => ({ serial: d.serial, state: d.state, model: d.model, product: d.product })),
      },
    };
  };

  return {
    "phone-status": (): Promise<PhoneStatus> => status(),

    /** Allume (confirmation native : écoute sur le réseau local) ou éteint le pont. Rend l'état relu. */
    "phone-bridge-set": async (enabled: unknown): Promise<PhoneStatus> => {
      if (typeof enabled !== "boolean") throw new Error("[oneai] phone-bridge-set : booléen attendu");
      if (enabled && !hub().mobile.status().running) {
        const port = settings().get("mobile").port;
        if (!ctx.shell.confirm) throw new Error("[oneai] pont téléphone : confirmation native indisponible, refusé");
        const ok = await ctx.shell.confirm(
          "Allumer le pont téléphone ?",
          `Jarod va écouter sur le port ${port}, sur TOUT le réseau local (pas seulement cette machine). Un téléphone ne peut s'y connecter qu'après appairage par un code que vous lui donnez, et il ne peut pas approuver les outils sensibles.\n\nÀ n'allumer que sur un réseau de confiance.`,
          "Allumer",
        );
        if (!ok) throw new Error("[oneai] pont téléphone : refusé par l'utilisateur");
        await hub().mobile.start();
      } else if (!enabled) {
        await hub().mobile.stop();
      }
      return status();
    },

    /** Un code d'appairage neuf (court, à usage unique) et l'adresse à ouvrir sur le téléphone. */
    "phone-pairing": (): { url: string; secret: string; expiresAt: number } => {
      if (!hub().mobile.status().running) throw new Error("[oneai] pont téléphone éteint : allumez-le d'abord");
      return hub().mobile.pairing();
    },

    "phone-revoke": async (deviceId: unknown): Promise<PhoneStatus> => {
      if (typeof deviceId !== "string" || !deviceId) throw new Error("[oneai] phone-revoke : identifiant attendu");
      if (!hub().mobile.status().devices.some((d) => d.deviceId === deviceId)) throw new Error("[oneai] téléphone inconnu");
      hub().mobile.revoke(deviceId);
      return status();
    },

    /** Boîte « Ouvrir » native pour `adb` ; rend le chemin choisi (retenu pour ce lancement) ou null si annulée. */
    "android-pick-adb": async (): Promise<string | null> => {
      if (!ctx.shell.pickFile) throw new Error("[oneai] boîte « Ouvrir » native indisponible, refusé");
      const file = await ctx.shell.pickFile({ title: "Programme adb", filters: [{ name: "adb", extensions: ["exe", "*"] }] });
      if (!file) return null;
      pickedAdb.add(real(file));
      return file;
    },

    /** `path` : un chemin CHOISI dans la boîte (ce lancement) ; `null` ou vide : revenir à l'adb du PATH. */
    "android-set-adb": async (path: unknown): Promise<PhoneStatus> => {
      let value = "";
      if (path !== null && path !== undefined && path !== "") {
        if (typeof path !== "string") throw new Error("[oneai] android : chemin attendu");
        if (!pickedAdb.has(real(path))) throw new Error("[oneai] android : programme non choisi dans la boîte « Ouvrir » (le chemin d'un programme ne se tape pas)");
        value = path;
      }
      settings().set("android", { ...settings().get("android"), adbPath: value });
      hub().android.reset(); // l'adb en usage est détecté UNE fois : on lui fait relire le réglage
      return status();
    },
  };
}
