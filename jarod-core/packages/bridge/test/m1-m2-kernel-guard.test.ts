/**
 * M1/M2/M3 (audit v4 § 1) — le cycle de vie du kernel dans le main.
 *
 * M1 : `createHandlers` recevait `kernel: () => kernel!`. À la fermeture, `kernel` passait à `null` AVANT que
 * la fenêtre ne disparaisse et avant `dispose()` : pendant tout ce temps, les ~270 handlers levaient
 * (`Cannot read properties of null`) — seule la garde du commit `1b5d4612` (`profiles.ts`) protégeait son
 * écran. Et la désinscription rendue par `registerOneaiHandlers` était JETÉE : aucun canal n'était retiré.
 *
 * M2 : pendant une bascule de profil, le kernel RETENU est celui qu'on vient de fermer — il existe encore,
 * donc un `!` le rendait tel quel : les handlers lisaient une base close.
 *
 * M3 : `second-instance` appelait `showWindow()`, qui CRÉAIT une fenêtre si `win` était null. Pendant
 * l'ouverture du kernel (jusqu'à 20 s), cela donnait deux fenêtres : la première orpheline, dont les appels
 * IPC étaient refusés (expéditeur inconnu).
 */
import { describe, expect, it, vi } from "vitest";
import { kernelAccessor } from "../src/main/kernel-access.js";
import { registerOneaiHandlers } from "../src/main/ipc.js";

describe("M1/M2 — la garde unique des handlers dit POURQUOI le kernel n'est pas servable", () => {
  it("rend le kernel quand il est servable", () => {
    const k = { profile: "default" };
    expect(kernelAccessor({ kernel: () => k, unavailable: () => null })()).toBe(k);
  });

  it("sans kernel, l'erreur est explicite (jamais un accès à null)", () => {
    const access = kernelAccessor({ kernel: () => null, unavailable: () => null });
    expect(() => access()).toThrow(/kernel non disponible/);
  });

  it("PENDANT UNE BASCULE, refuse même si un kernel est encore retenu (c'est celui qu'on vient de fermer)", () => {
    const closed = { profile: "ancien" }; // l'objet existe : c'est justement le piège de M2
    const access = kernelAccessor({ kernel: () => closed, unavailable: () => "profil en cours de bascule" });
    expect(() => access()).toThrow(/profil en cours de bascule/);
  });

  it("PENDANT LA FERMETURE, refuse avec sa propre raison", () => {
    const access = kernelAccessor({ kernel: () => ({ profile: "default" }), unavailable: () => "application en cours de fermeture" });
    expect(() => access()).toThrow(/application en cours de fermeture/);
  });

  it("la raison est relue à CHAQUE appel (l'état change en cours de vie)", () => {
    let why: string | null = null;
    const k = { profile: "default" };
    const access = kernelAccessor({ kernel: () => k, unavailable: () => why });
    expect(access()).toBe(k);
    why = "application en cours de fermeture";
    expect(() => access()).toThrow(/fermeture/);
    why = null;
    expect(access()).toBe(k);
  });
});

describe("M1 — la désinscription des canaux IPC est réelle et complète", () => {
  /** Un `ipcMain` minimal qui retient ce qui est branché. */
  function fakeIpcMain() {
    const handled = new Map<string, unknown>();
    return {
      handled,
      handle: (channel: string, listener: unknown) => {
        handled.set(channel, listener);
      },
      removeHandler: (channel: string) => {
        handled.delete(channel);
      },
    };
  }

  it("branche les canaux fournis, puis les retire TOUS (aucun handler ne survit à la fermeture)", () => {
    const ipc = fakeIpcMain();
    const handlers = {
      "list-profiles": () => [],
      "get-jarod-settings": () => ({}),
    };
    const off = registerOneaiHandlers(ipc, handlers, () => true);
    expect(ipc.handled.has("list-profiles")).toBe(true);
    expect(ipc.handled.has("get-jarod-settings")).toBe(true);
    // Les canaux autorisés sans handler répondent « non porté » : ils sont branchés quand même (le message
    // explicite est préférable à « no handler registered »).
    expect(ipc.handled.size).toBeGreaterThan(2);

    off();

    expect(ipc.handled.size, "plus aucun canal branché").toBe(0);
  });

  it("un canal non autorisé fait échouer l'enregistrement (l'allowlist reste la référence)", () => {
    const ipc = fakeIpcMain();
    expect(() => registerOneaiHandlers(ipc, { "canal-invente": () => 1 }, () => true)).toThrow();
  });

  it("l'expéditeur non fiable est refusé avant le handler", () => {
    const ipc = fakeIpcMain();
    const spy = vi.fn(() => "ok");
    registerOneaiHandlers(ipc, { "list-profiles": spy }, () => false);
    const listener = ipc.handled.get("list-profiles") as (event: unknown, ...a: unknown[]) => unknown;
    expect(() => listener({})).toThrow(/Unauthorized sender/);
    expect(spy).not.toHaveBeenCalled();
  });
});