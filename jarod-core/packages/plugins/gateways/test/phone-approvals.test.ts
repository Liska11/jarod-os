// The approval broker: requests from runs the phone did not start, offered to every app device.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ApprovalDevices, type PhoneApproval, PhoneApprovalBroker } from "../src/phone-approvals.js";

/** Two phones, as the broker sees them: what each was shown, what was taken back. */
function fakeDevices(paired = true) {
  const shown: PhoneApproval[] = [];
  const withdrawn: string[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  const devices: ApprovalDevices = {
    paired: () => paired,
    offer: (request, answer) => {
      shown.push(request);
      answers.set(request.id, answer);
    },
    withdraw: (id) => withdrawn.push(id),
  };
  return { devices, shown, withdrawn, answer: (id: string, ok: unknown) => answers.get(id)!(ok as boolean) };
}

const call = { id: "c1", name: "write_file", args: { path: "note.txt" } };

afterEach(() => {
  vi.useRealTimers();
});

describe("phone approval broker", () => {
  it("offers the request to the phones and resolves on the first answer", async () => {
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices });
    const h = broker.offer("s1", call, "Écrire un fichier", "pc")!;
    expect(d.shown).toEqual([
      expect.objectContaining({ id: h.id, sessionId: "s1", call, description: "Écrire un fichier", origin: "pc" }),
    ]);
    expect(broker.pending().map((p) => p.id)).toEqual([h.id]);
    d.answer(h.id, true);
    // A second answer (another phone, a late tap) changes nothing.
    d.answer(h.id, false);
    expect(await h.decision).toBe(true);
    expect(h.answered()).toBe(true);
    // The other phones are told to drop the card; nothing stays pending.
    expect(d.withdrawn).toEqual([h.id]);
    expect(broker.pending()).toEqual([]);
  });

  it("reads nothing but a boolean true as a yes", async () => {
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices });
    const h = broker.offer("s1", call, "x", "background")!;
    d.answer(h.id, "always");
    expect(await h.decision).toBe(false);
  });

  it("cancel (the PC answered first, the run stopped) takes the card back from the phones and refuses", async () => {
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices });
    const h = broker.offer("s1", call, "x", "pc")!;
    h.cancel();
    expect(await h.decision).toBe(false);
    expect(h.answered()).toBe(false);
    expect(d.withdrawn).toEqual([h.id]);
    // A phone answering afterwards decides nothing.
    d.answer(h.id, true);
    expect(await h.decision).toBe(false);
    expect(d.withdrawn).toEqual([h.id]);
  });

  it("refuses when nobody answers in time, and takes the card back", async () => {
    vi.useFakeTimers();
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices, timeoutMs: 1000 });
    const h = broker.offer("s1", call, "x", "background")!;
    expect(d.shown[0]!.expiresAt).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(1001);
    expect(await h.decision).toBe(false);
    expect(h.answered()).toBe(false);
    expect(d.withdrawn).toEqual([h.id]);
    expect(broker.pending()).toEqual([]);
  });

  it("setting off: nothing is offered and nothing changes", () => {
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => false, devices: () => d.devices });
    expect(broker.offer("s1", call, "x", "pc")).toBeNull();
    expect(d.shown).toEqual([]);
    expect(broker.pending()).toEqual([]);
  });

  it("no paired phone: nothing is offered (nobody could ever answer)", () => {
    const d = fakeDevices(false);
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices });
    expect(broker.offer("s1", call, "x", "pc")).toBeNull();
    expect(d.shown).toEqual([]);
  });

  it("cancelAll refuses everything still open", async () => {
    const d = fakeDevices();
    const broker = new PhoneApprovalBroker({ enabled: () => true, devices: () => d.devices });
    const a = broker.offer("s1", call, "x", "pc")!;
    const b = broker.offer("s2", call, "y", "background")!;
    broker.cancelAll();
    expect(await a.decision).toBe(false);
    expect(await b.decision).toBe(false);
    expect(d.withdrawn.sort()).toEqual([a.id, b.id].sort());
  });
});
