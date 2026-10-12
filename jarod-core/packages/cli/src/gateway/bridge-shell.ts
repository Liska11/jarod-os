// Le « shell » que les handlers de @jarod/bridge attendent (`DesktopShell`), tenu par la passerelle de Jarod-OS : il n'y a pas d'Electron ici, donc tout geste natif
// (boîte « Ouvrir », confirmation, presse-papiers, lien externe…) est une DEMANDE à la fenêtre de Jarod-OS (`ask`), qui l'exécute par son processus principal.
// Sans fenêtre connectée, la demande reste sans réponse (`null`) : un dialogue refusé, jamais un « oui » par défaut.
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopShell } from "@jarod/bridge";

export interface ShellLink {
  /** Pousse un événement (`ctx.shell.send`) à la fenêtre. */
  send(channel: string, args: unknown[]): void;
  /** Une demande de geste natif ; `null` = pas de fenêtre ou geste annulé. */
  ask(kind: string, params?: Record<string, unknown>): Promise<unknown>;
}

export function createBridgeShell(o: { version: string; dataDir: string; link: ShellLink }): DesktopShell {
  const { link } = o;
  const text = async (kind: string, params?: Record<string, unknown>): Promise<string | null> => {
    const v = await link.ask(kind, params);
    return typeof v === "string" && v ? v : null;
  };
  return {
    appVersion: () => o.version,
    quit: () => void link.ask("quit"),
    relaunch: () => void link.ask("relaunch"),
    writeClipboard: (t) => void link.ask("clipboard", { text: t }),
    openExternal: async (url) => void (await link.ask("openExternal", { url })),
    send: (channel, ...args) => link.send(channel, args),
    tempDir: () => tmpdir(),
    isInstalled: () => false,
    installSilently: () => {
      throw new Error("l'installation silencieuse d'une mise à jour passe par l'installeur de Jarod-OS, pas par le noyau");
    },
    openPath: async (path) => {
      const v = await link.ask("openPath", { path });
      return typeof v === "string" ? v : "fenêtre indisponible";
    },
    setThemeSource: (source) => void link.ask("themeSource", { source }),
    spellChecker: () => ({ available: [], selected: [], preferredSystem: [] }),
    setSpellCheckerLanguages: () => {},
    logsDir: () => join(o.dataDir, "logs"),
    userDataDir: () => o.dataDir,
    pickFolder: () => text("pickFolder"),
    pickFile: (options) => text("pickFile", { title: options.title, filters: options.filters }),
    pickSavePath: (defaultName) => text("pickSavePath", { defaultName }),
    pickDestinationFolder: (title, defaultPath) => text("pickDestinationFolder", { title, ...(defaultPath ? { defaultPath } : {}) }),
    showItemInFolder: (path) => void link.ask("showItemInFolder", { path }),
    notify: (message, detail) => void link.ask("notify", { message, ...(detail ? { detail } : {}) }),
    confirm: async (message, detail, action) => (await link.ask("confirm", { message, detail, ...(action ? { action } : {}) })) === true,
    confirmInstall: async (summary) => (await link.ask("confirmInstall", { summary })) === true,
  };
}
