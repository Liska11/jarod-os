/**
 * Jarod-OS — réglage `voice` de `set-jarod-settings` : fournisseur de transcription (liste fermée), modèle, voix et débit de la synthèse. VRAI kernel, VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("réglage voice", () => {
  it("se lit avec les valeurs par défaut et s'écrit : fournisseur local sans confirmation, modèle, voix, débit", async () => {
    const { call, app, confirms } = await setupKernel();
    expect(((await call("get-jarod-settings")) as { voice: unknown }).voice).toEqual({ sttProvider: "openai", sttModel: "whisper-1", ttsVoice: "", ttsRate: 1 });
    await call("set-jarod-settings", { voice: { sttProvider: "lmstudio", sttModel: "whisper-large", ttsVoice: "Microsoft Hortense Desktop", ttsRate: 1.25 } });
    expect(app.agent.settings.get("voice")).toMatchObject({ sttProvider: "lmstudio", sttModel: "whisper-large", ttsVoice: "Microsoft Hortense Desktop", ttsRate: 1.25 });
    expect(confirms).toHaveLength(0);
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
