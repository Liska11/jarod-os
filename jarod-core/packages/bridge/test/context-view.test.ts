/**
 * Cockpit, lots 3-4 : écran « Contexte » et réglage du proxy de compression, sur un VRAI kernel derrière les VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { proxyHealth } from "../src/main/handlers/context-view.js";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("context-status", () => {
  it("rend les économies de contexte du magasin réel et un proxy éteint par défaut", async () => {
    const { call, app } = await setupKernel();
    const s = app.agent.sessions.create();
    app.agent.outputs.keep(s.id, "run_shell", "x\n".repeat(10_000));
    const st = (await call("context-status")) as { outputs: { outputs: number; savedChars: number }; proxy: { enabled: boolean; health: string } };
    expect(st.outputs.outputs).toBe(1);
    expect(st.outputs.savedChars).toBeGreaterThan(15_000);
    expect(st.proxy).toMatchObject({ enabled: false, health: "off" });
  });
});

describe("contextProxy (billion-context)", () => {
  it("l'allumer demande la confirmation native ; refusé, rien n'est écrit ; une adresse hors bouclage est refusée", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { contextProxy: { enabled: true, providers: ["openai"] } }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(app.agent.settings.get("contextProxy").enabled).toBe(false);
    expect(confirms[0]!.detail).toMatch(/billion-context/);
    await call("set-jarod-settings", { contextProxy: { enabled: true, providers: ["openai"] } });
    expect(app.agent.settings.get("contextProxy")).toEqual({ enabled: true, url: "http://127.0.0.1:8787", providers: ["openai"] });
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { contextProxy: { url: "http://proxy.example.com:8787" } }))).rejects.toThrow(/bouclage/);
    // Le transport passe par le proxy ; l'adresse affichée du fournisseur, non.
    expect(app.agent.providers.def("openai").baseUrl).toBe("https://api.openai.com/v1");
  });

  it("santé : lue sur /__bili/health du bouclage seulement", async () => {
    const seen: string[] = [];
    const fake = (async (u: string) => (seen.push(String(u)), new Response(JSON.stringify({ ok: true, upstream: "https://api.openai.com" })))) as unknown as typeof fetch;
    expect(await proxyHealth("http://127.0.0.1:8787", fake)).toEqual({ health: "ok", upstream: "https://api.openai.com" });
    expect(seen).toEqual(["http://127.0.0.1:8787/__bili/health"]);
    expect((await proxyHealth("http://exemple.fr:8787", fake)).health).toBe("unreachable");
    expect(seen).toHaveLength(1);
  });
});
