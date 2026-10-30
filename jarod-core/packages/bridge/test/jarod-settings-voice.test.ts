/**
 * Jarod-OS — réglage `voice` de `set-jarod-settings` : fournisseur de transcription (liste fermée), modèle, voix et débit de la synthèse. VRAI kernel, VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

// Le mode 100 % local vit dans qwen-flash.json : les essais l'écrivent dans un dossier temporaire, jamais dans la configuration réelle.
let configDir = "";
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "jarod-voice-cfg-"));
  process.env.JAROD_OS_CONFIG_DIR = configDir;
});
afterEach(() => {
  cleanup();
  delete process.env.JAROD_OS_CONFIG_DIR;
  rmSync(configDir, { recursive: true, force: true });
});

describe("réglage voice", () => {
  it("se lit avec les valeurs par défaut et s'écrit : fournisseur local sans confirmation, modèle, voix, débit", async () => {
    const { call, app, confirms } = await setupKernel();
    expect(((await call("get-jarod-settings")) as { voice: unknown }).voice).toEqual({ sttProvider: "openai", sttModel: "whisper-1", ttsVoice: "", ttsRate: 1, localOnly: false });
    await call("set-jarod-settings", { voice: { sttProvider: "lmstudio", sttModel: "whisper-large", ttsVoice: "Microsoft Hortense Desktop", ttsRate: 1.25 } });
    expect(app.agent.settings.get("voice")).toMatchObject({ sttProvider: "lmstudio", sttModel: "whisper-large", ttsVoice: "Microsoft Hortense Desktop", ttsRate: 1.25 });
    expect(confirms).toHaveLength(0);
  });

  it("le mode 100 % local s'écrit dans qwen-flash.json en gardant les autres champs, se relit, et refuse autre chose qu'un booléen", async () => {
    const { call, app } = await setupKernel();
    writeFileSync(join(configDir, "qwen-flash.json"), JSON.stringify({ autoStart: true, whisper: { port: 8090 } }));
    await call("set-jarod-settings", { voice: { localOnly: true } });
    expect(JSON.parse(readFileSync(join(configDir, "qwen-flash.json"), "utf8"))).toEqual({ autoStart: true, whisper: { port: 8090 }, localOnly: true });
    expect(((await call("get-jarod-settings")) as { voice: { localOnly: boolean } }).voice.localOnly).toBe(true);
    await call("set-jarod-settings", { voice: { localOnly: false } });
    expect(((await call("get-jarod-settings")) as { voice: { localOnly: boolean } }).voice.localOnly).toBe(false);
    await expect(call("set-jarod-settings", { voice: { localOnly: "oui" } })).rejects.toThrow(/vrai ou faux/);
    expect(app.agent.settings.get("voice").sttProvider).toBe("openai");
  });

  it("autoSpeak n'est pas écrit ici (le haut-parleur du noyau n'est pas celui de la fenêtre) et reste tel quel", async () => {
    const { call, app } = await setupKernel();
    await expect(call("set-jarod-settings", { voice: { autoSpeak: true } })).rejects.toThrow(/clé\(s\) inconnue\(s\) : autoSpeak/);
    expect(app.agent.settings.get("voice").autoSpeak).toBe(false);
  });

  it("refuse un fournisseur sans transcription, un inconnu, un débit hors bornes, un modèle trop long ; rien n'est écrit", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.get("voice");
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ voice: { sttProvider: "anthropic" } }, /un fournisseur de transcription parmi/],
      [{ voice: { sttProvider: "nimporte" } }, /un fournisseur de transcription parmi/],
      [{ voice: { sttProvider: 3 } }, /texte attendu/],
      [{ voice: { ttsRate: 0.1 } }, /entre 0,25 et 4/],
      [{ voice: { ttsRate: 5 } }, /entre 0,25 et 4/],
      [{ voice: { ttsRate: "vite" } }, /entre 0,25 et 4/],
      [{ voice: { sttModel: "x".repeat(201) } }, /au plus 200/],
      [{ voice: [] }, /objet/],
    ];
    for (const [patch, why] of refused) await expect(call("set-jarod-settings", patch), JSON.stringify(patch)).rejects.toThrow(why);
    expect(app.agent.settings.get("voice")).toEqual(before);
  });

  it("choisir un fournisseur qui sort de la machine demande une confirmation native qui le nomme ; refusée, rien ne change", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    app.agent.settings.patch({ voice: { ...app.agent.settings.get("voice"), sttProvider: "lmstudio" } });
    await expect(call("set-jarod-settings", { voice: { sttProvider: "groq" } })).rejects.toThrow(/refusé par l.utilisateur/);
    expect(app.agent.settings.get("voice").sttProvider).toBe("lmstudio");
    expect(confirms[0]!.message).toMatch(/enregistrements vocaux à Groq/);
    await call("set-jarod-settings", { voice: { sttProvider: "groq" } });
    expect(app.agent.settings.get("voice").sttProvider).toBe("groq");
    // Le même fournisseur : rien à confirmer.
    await call("set-jarod-settings", { voice: { sttProvider: "groq", ttsRate: 2 } });
    expect(confirms).toHaveLength(2);
  });

  it("get-jarod-options liste les fournisseurs de transcription (ceux de la liste fermée seulement) et les voix de la machine", async () => {
    const { call } = await setupKernel();
    const o = (await call("get-jarod-options")) as { sttProviders: { id: string; defaultModel: string; local: boolean }[]; voices: string[] };
    const ids = o.sttProviders.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["openai", "groq", "lmstudio"]));
    expect(ids).not.toContain("anthropic");
    expect(o.sttProviders.find((p) => p.id === "openai")).toMatchObject({ defaultModel: "whisper-1", local: false });
    expect(o.sttProviders.find((p) => p.id === "lmstudio")?.local).toBe(true);
    expect(Array.isArray(o.voices)).toBe(true);
  });
});
