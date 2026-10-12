// Portage de packages/core/test/pairing.test.ts (rév. 2e180305).
import { describe, expect, it, vi } from "vitest";
import { PAIRING_TTL_MS } from "../src/pairing.js";
import { makeCore } from "./helpers.js";

const hooks = { emit: () => {}, approve: async () => true };

describe("gateway pairing", () => {
  it("gives an unknown sender one code, and approving it lets them in", async () => {
    const core = await makeCore();
    const send = vi.fn(async () => {});
    core.telegram = { send, stop: () => {} } as never;
    const reply = core.pairing.request("telegram", "4242", "Alice", "4242");
    const code = /code d'appairage : ([A-Z2-9]{6})/.exec(reply)?.[1];
    expect(code).toBeDefined();
    // Writing again gives the same code, and a single request for the owner.
    expect(core.pairing.request("telegram", "4242", "Alice", "4242")).toContain(code!);
    expect(core.pairing.list()).toHaveLength(1);
    expect(core.notifications.list()[0]).toMatchObject({ title: "Demande d'accès telegram" });

    const s = core.sessions.create();
    const res = await core.submit(s.id, `/pair approve ${code!.toLowerCase()}`, hooks);
    expect(res.kind === "command" && res.result.text).toBe("Accès accordé sur telegram à Alice (4242).");
    expect(core.settings.get("telegram").allowedChatIds).toEqual(["4242"]);
    expect(send).toHaveBeenCalledWith("4242", expect.stringContaining("Accès accordé"));
    expect(core.pairing.list()).toHaveLength(0);
  });

  it("adds Discord and Slack users to their own allowlists, and forgets expired or denied codes", async () => {
    const core = await makeCore();
    const d = /: ([A-Z2-9]{6})/.exec(core.pairing.request("discord", "u1", "bob", "dm1"))![1]!;
    const sl = /: ([A-Z2-9]{6})/.exec(core.pairing.request("slack", "U2", "U2", "C9"))![1]!;
    await core.pairing.approve(d);
    await core.pairing.approve(sl);
    expect(core.settings.get("discord").allowedUserIds).toEqual(["u1"]);
    expect(core.settings.get("slack").allowedUserIds).toEqual(["U2"]);

    const old = /: ([A-Z2-9]{6})/.exec(core.pairing.request("telegram", "1", "x", "1", 0))![1]!;
    await expect(core.pairing.approve(old, PAIRING_TTL_MS + 1)).rejects.toThrow(/inconnu ou expiré/);
    const denied = /: ([A-Z2-9]{6})/.exec(core.pairing.request("telegram", "2", "y", "2"))![1]!;
    expect(core.pairing.deny(denied)).toBe(true);
    await expect(core.pairing.approve(denied)).rejects.toThrow(/inconnu/);
  });

  it("refuses /pair from a messaging chat: only the app approves", async () => {
    const core = await makeCore();
    const code = /: ([A-Z2-9]{6})/.exec(core.pairing.request("telegram", "9", "Mallory", "9"))![1]!;
    const answer = await core.handleGatewayMessage("telegram", "1", `/pair approve ${code}`, "allowed user");
    expect(answer).toBe("Commande disponible uniquement dans l'application.");
    expect(core.settings.get("telegram").allowedChatIds).toEqual([]);
  });
});
