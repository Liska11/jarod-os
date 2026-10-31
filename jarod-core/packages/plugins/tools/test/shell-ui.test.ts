// L'interface de Jarod-OS vue par l'agent : catalogue filtrable (os_ui_list) et exécution par identifiant (os_ui_run), sans vrai shell.
import { describe, expect, it, vi } from "vitest";
import { commandLine, filterCommands, shellUiTools } from "../src/shell-ui.js";

const rows = [
  { id: "web.open", title: "Open a web page", description: "Open a URL in a window inside Jarod-OS.", tier: "act", args: [{ name: "url", required: true }, { name: "title" }] },
  { id: "audio.volume", title: "Set volume", description: "Change the output volume.", tier: "mutate", args: [{ name: "percent", required: true }] },
  { id: "pinokio.start", title: "Start the Pinokio engine", description: "internal", tier: "act", args: [], hidden: true },
];
const env = { JAROD_OS_CONTROL_SOCKET: "pipe://x", JAROD_OS_CONTROL_TOKEN: "t" };
const ctx = {} as never;

describe("catalogue des commandes de l'interface", () => {
  it("une ligne par commande, arguments obligatoires marqués d'une étoile ; les commandes cachées sont absentes", () => {
    expect(commandLine(rows[0]!)).toBe("web.open [act] Open a web page — Open a URL in a window inside Jarod-OS. (url*, title)");
    expect(filterCommands(rows, "").map((c) => c.id)).toEqual(["web.open", "audio.volume"]);
  });

  it("tous les mots demandés doivent correspondre (identifiant, titre ou description), sans accents ni casse", () => {
    expect(filterCommands(rows, "WEB page").map((c) => c.id)).toEqual(["web.open"]);
    expect(filterCommands(rows, "volume").map((c) => c.id)).toEqual(["audio.volume"]);
    expect(filterCommands(rows, "zzz")).toEqual([]);
  });
});

describe("outils os_ui_list et os_ui_run", () => {
  it("n'existent pour l'agent que si un shell est joignable", () => {
    const [list, run] = shellUiTools({ env: {} });
    expect(list!.available!()).toBe(false);
    expect(run!.available!()).toBe(false);
    const [l2] = shellUiTools({ env });
    expect(l2!.available!()).toBe(true);
  });

  it("os_ui_list : lecture sans accord, demande ui-list, filtre, dit quand rien ne correspond", async () => {
    const ask = vi.fn().mockResolvedValue({ ok: true, result: rows });
    const [list] = shellUiTools({ env, ask });
    expect(list!.dangerous).toBe(false);
    const out = await list!.run({ filter: "web" }, ctx);
    expect(ask).toHaveBeenCalledWith({ cmd: "ui-list" });
    expect(out).toContain("1 commande(s)");
    expect(out).toContain("web.open [act]");
    expect(out).not.toContain("audio.volume");
    expect(await list!.run({ filter: "zzz" }, ctx)).toMatch(/Aucune commande ne correspond à « zzz »/);
  });

  it("os_ui_run : accord demandé (dangerous), exécute par identifiant avec la source « agent », rend le résumé du shell", async () => {
    const ask = vi.fn().mockResolvedValue({ ok: true, summary: "Opened https://example.com", data: { url: "https://example.com" } });
    const [, run] = shellUiTools({ env, ask });
    expect(run!.dangerous).toBe(true);
    expect(run!.targetOf!({ command: "web.open" })).toBe("web.open");
    const out = JSON.parse(await run!.run({ command: "web.open", args: { url: "example.com" } }, ctx));
    expect(ask).toHaveBeenCalledWith({ cmd: "ui", command: "web.open", args: { url: "example.com" }, source: "agent" });
    expect(out).toMatchObject({ command: "web.open", ok: true, summary: "Opened https://example.com" });
  });

  it("os_ui_run : le refus du shell est dit tel quel ; un identifiant invalide n'est jamais envoyé", async () => {
    const ask = vi.fn().mockResolvedValue({ ok: false, error: "audio.volume : réservé à l'utilisateur" });
    const [, run] = shellUiTools({ env, ask });
    await expect(run!.run({ command: "audio.volume", args: { percent: 0 } }, ctx)).rejects.toThrow(/réservé à l'utilisateur/);
    ask.mockClear();
    await expect(run!.run({ command: "web.open; rm -rf" }, ctx)).rejects.toThrow(/identifiant/);
    expect(ask).not.toHaveBeenCalled();
  });
});
