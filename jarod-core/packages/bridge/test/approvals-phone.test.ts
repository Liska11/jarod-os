/**
 * Desktop chat approvals offered to the paired phones too (setting `phoneApprovals`): the first answer, window or phone, wins.
 * The phone side is the real broker of plugin-gateways with fake devices; the window is a recording `shell.send`.
 */
import { type ApprovalDevices, type PhoneApproval, PhoneApprovalBroker } from "@jarod/plugin-gateways";
import { describe, expect, it } from "vitest";
import { createApprovalBroker } from "../src/main/handlers/approvals.js";
import type { HandlerContext } from "../src/main/handlers/context.js";

function rig(opts: { enabled?: boolean; windowAlive?: boolean } = {}) {
  const sent: [string, unknown][] = [];
  const shown: PhoneApproval[] = [];
  const withdrawn: string[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  const devices: ApprovalDevices = {
    paired: () => true,
    offer: (r, answer) => {
      shown.push(r);
      answers.set(r.id, answer);
    },
    withdraw: (id) => withdrawn.push(id),
  };
  const phoneApprovals = new PhoneApprovalBroker({ enabled: () => opts.enabled ?? true, devices: () => devices });
  const ctx = {
    shell: {
      send: (channel: string, payload: unknown) => {
        if (opts.windowAlive === false) throw new Error("window destroyed");
        sent.push([channel, payload]);
      },
    },
    // No agent tools here: eligibility fails closed (no "session"/"always"), which this test does not need.
    kernel: () => ({ gateways: { phoneApprovals } }),
  } as unknown as HandlerContext;
  const { broker, handlers } = createApprovalBroker(ctx, 60_000);
  const resolved = () => sent.filter(([c]) => c === "tool-approval-resolved").map(([, p]) => p);
  return { broker, handlers, shown, withdrawn, resolved, phoneAnswer: (id: string, ok: boolean) => answers.get(id)!(ok) };
}

const call = { id: "call-1", name: "write_file", args: { path: "note.txt" } };

describe("desktop approvals reach the phone", () => {
  it("the phone answers first: the run gets it, the window card closes", async () => {
    const r = rig();
    const decision = r.broker.request("owner", "run-a", "s1", call, "Écrire un fichier");
    expect(r.shown).toEqual([expect.objectContaining({ sessionId: "s1", origin: "pc", call })]);
    r.phoneAnswer(r.shown[0]!.id, true);
    expect(await decision).toBe(true);
    expect(r.resolved()).toEqual([expect.objectContaining({ runId: "run-a", allowed: true, reason: "phone" })]);
    expect(r.broker.list()).toEqual([]);
  });

  it("the window answers first: the phones are told to drop the card", async () => {
    const r = rig();
    const decision = r.broker.request("owner", "run-a", "s1", call, "Écrire");
    const [req] = r.broker.list();
    expect(await r.handlers["tool-approval-respond"](req!.id, false)).toBe(true);
    expect(await decision).toBe(false);
    expect(r.withdrawn).toEqual([r.shown[0]!.id]);
    // A late answer from the phone changes nothing.
    r.phoneAnswer(r.shown[0]!.id, true);
    expect(r.resolved()).toEqual([expect.objectContaining({ allowed: false, reason: "answered" })]);
  });

  it("a stopped run takes the request back from the phones", async () => {
    const r = rig();
    const decision = r.broker.request("owner", "run-a", "s1", call, "Écrire");
    r.broker.cancel("owner");
    expect(await decision).toBe(false);
    expect(r.withdrawn).toEqual([r.shown[0]!.id]);
  });

  it("with the window gone, the phone can still answer", async () => {
    const r = rig({ windowAlive: false });
    const decision = r.broker.request("owner", "run-a", "s1", call, "Écrire");
    r.phoneAnswer(r.shown[0]!.id, true);
    expect(await decision).toBe(true);
  });

  it("setting off: nothing reaches a phone, and a dead window still refuses at once", async () => {
    const off = rig({ enabled: false });
    const pending = off.broker.request("owner", "run-a", "s1", call, "Écrire");
    expect(off.shown).toEqual([]);
    off.broker.cancel("owner");
    expect(await pending).toBe(false);

    const dead = rig({ enabled: false, windowAlive: false });
    expect(await dead.broker.request("owner", "run-a", "s1", call, "Écrire")).toBe(false);
    expect(dead.shown).toEqual([]);
  });
});
