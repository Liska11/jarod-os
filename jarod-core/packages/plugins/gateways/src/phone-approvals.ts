import { randomBytes } from "node:crypto";
import { APPROVAL_TIMEOUT_MS } from "@jarod/plugin-agent";

/** Where a request offered to the phones was started. Runs started from a phone keep their own path. */
export type ApprovalOrigin = "pc" | "background";

/** What a phone is shown: enough to decide, nothing more. */
export interface PhoneApproval {
  id: string;
  sessionId: string;
  call: { id: string; name: string; args: unknown };
  description: string;
  expiresAt: number;
  origin: ApprovalOrigin;
}

/** The app devices, as the broker sees them (`RemoteHost` implements it). */
export interface ApprovalDevices {
  /** Whether any app device is paired at all: with none, nobody could ever answer. */
  paired(): boolean;
  /**
   * Shows the request to every connected app device and bumps the content-free wake counter, so a
   * closed app is told something waits. A device's answer comes back through `answer`.
   */
  offer(request: PhoneApproval, answer: (ok: boolean) => void): void;
  /** Takes the request back from every device that was shown it (`approval-cancelled`). */
  withdraw(id: string): void;
}

export interface PhoneApprovalHandle {
  id: string;
  /** The first answer from a phone; false on timeout or cancel. Never "always": one decision, one request. */
  decision: Promise<boolean>;
  /** The PC decided first, or the run stopped: the phones drop the card. `decision` settles to false if still open. */
  cancel(): void;
  /** Whether `decision` came from a phone (not from a timeout or `cancel`). */
  answered(): boolean;
}

export interface PhoneApprovalDeps {
  /** The `phoneApprovals` setting. Off: `offer` returns null and nothing reaches a phone. */
  enabled(): boolean;
  devices(): ApprovalDevices | null;
  timeoutMs?: number;
}

/**
 * Offers approval requests from runs the phone did not start (desktop chat, schedules, gateways) to
 * every paired app device. The first boolean answer wins, the other phones are told to drop the card,
 * and no answer in time is a refusal.
 */
export class PhoneApprovalBroker {
  private readonly open = new Map<string, { request: PhoneApproval; settle(ok: boolean): void }>();

  constructor(private readonly deps: PhoneApprovalDeps) {}

  offer(
    sessionId: string,
    call: { id: string; name: string; args?: unknown },
    description: string,
    origin: ApprovalOrigin,
  ): PhoneApprovalHandle | null {
    if (!this.deps.enabled()) return null;
    const devices = this.deps.devices();
    if (!devices?.paired()) return null;
    const timeoutMs = this.deps.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    const id = randomBytes(12).toString("base64url");
    const request: PhoneApproval = {
      id,
      sessionId,
      call: { id: call.id, name: call.name, args: call.args ?? {} },
      description,
      expiresAt: Date.now() + timeoutMs,
      origin,
    };
    let byPhone = false;
    let settle: (ok: boolean) => void = () => {};
    const decision = new Promise<boolean>((resolve) => {
      settle = (ok) => {
        if (!this.open.delete(id)) return;
        clearTimeout(timer);
        devices.withdraw(id);
        resolve(ok);
      };
    });
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    this.open.set(id, { request, settle });
    devices.offer(request, (ok) => {
      if (this.open.has(id)) byPhone = true;
      settle(ok === true);
    });
    return { id, decision, cancel: () => settle(false), answered: () => byPhone };
  }

  /** Requests still waiting: a phone that connects later asks for them (`approvals.pending`). */
  pending(): PhoneApproval[] {
    return [...this.open.values()].map((o) => o.request);
  }

  /** Refuses everything still open (shutdown). */
  cancelAll(): void {
    for (const o of [...this.open.values()]) o.settle(false);
  }
}
