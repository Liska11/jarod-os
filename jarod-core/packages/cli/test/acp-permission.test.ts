// SPECS-P5-ACP.md §3-§4 (b) : l'autorisation d'un outil via l'éditeur est FAIL-CLOSED. Délai 300 s (Q2 approuvé).
// Chaque issue autre qu'un « oui » explicite sur une option autorisante proposée = refus : l'outil ne s'exécute pas.
import type { ToolCall } from "@jarod/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askPermission, DEFAULT_PERMISSION_OPTIONS, PERMISSION_TIMEOUT_MS, verdictOfResponse } from "../src/acp-permission.js";

// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-PERM-0123456789abcdef0123"].join("-");
const call: ToolCall = { id: "c9", name: "run_shell", args: { command: "rm -rf build" } };
const OPTS = DEFAULT_PERMISSION_OPTIONS;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

describe("verdictOfResponse : seul « sélectionné » sur une option autorisante proposée autorise", () => {
  it("allow_once → allowed ; reject_once → denied ; annulé → cancelled", () => {
    expect(verdictOfResponse(selected("allow_once"), OPTS)).toBe("allowed");
    expect(verdictOfResponse(selected("reject_once"), OPTS)).toBe("denied");
    expect(verdictOfResponse({ outcome: { outcome: "cancelled" } }, OPTS)).toBe("cancelled");
  });
  it("option inconnue (jamais proposée, même « allow_always »), forme invalide, null, réponse vide → denied", () => {
    for (const bad of [selected("allow_always"), selected("allow_session"), selected(""), { outcome: { outcome: "selected" } }, { outcome: { outcome: "selected", optionId: 7 } }, { outcome: "selected" }, {}, null, undefined, "oui", 1, { outcome: { outcome: "autre", optionId: "allow_once" } }])
      expect(verdictOfResponse(bad, OPTS), JSON.stringify(bad)).toBe("denied");
  });
  it("une option dont le genre n'est pas autorisant ne peut pas autoriser, même avec un identifiant d'apparence autorisante", () => {
    const odd = [{ optionId: "allow_once", name: "piège", kind: "reject_once" as never }];
    expect(verdictOfResponse(selected("allow_once"), odd)).toBe("denied");
  });
});

describe("askPermission", () => {
  it("la requête envoyée : session, appel (id, titre, genre, arguments EXPURGÉS), deux options seulement (allow_once / reject_once)", async () => {
    let sent: any;
    const r = await askPermission({
      request: async (p) => ((sent = p), selected("allow_once")),
      sessionId: "S",
      call: { ...call, args: { command: "echo", token: KEY } },
      description: `Exécute une commande ${KEY}`,
    });
    expect(r).toEqual({ allowed: true, verdict: "allowed" });
    expect(sent.sessionId).toBe("S");
    expect(sent.toolCall).toMatchObject({ toolCallId: "c9", kind: "execute", status: "pending" });
    expect(sent.options.map((o: { kind: string }) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(JSON.stringify(sent)).not.toContain("CANARI-PERM");
  });

  it("refus explicite → non autorisé ; annulation de l'éditeur → non autorisé", async () => {
    expect((await askPermission({ request: async () => selected("reject_once"), sessionId: "S", call, description: "" })).allowed).toBe(false);
    expect(await askPermission({ request: async () => ({ outcome: { outcome: "cancelled" } }), sessionId: "S", call, description: "" })).toEqual({ allowed: false, verdict: "cancelled" });
  });

  it("l'éditeur ne répond jamais : après 300 s exactement → refus (timeout), pas avant", async () => {
    expect(PERMISSION_TIMEOUT_MS).toBe(300_000);
    let done = false;
    const p = askPermission({ request: () => new Promise(() => {}), sessionId: "S", call, description: "" }).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ allowed: false, verdict: "timeout" });
  });

  it("le délai est paramétrable (tests, réglage futur) ; une réponse tardive après le délai ne change rien", async () => {
    let answer!: (v: unknown) => void;
    const p = askPermission({ request: () => new Promise((r) => (answer = r)), sessionId: "S", call, description: "", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).verdict).toBe("timeout");
    answer(selected("allow_once")); // trop tard
    await vi.advanceTimersByTimeAsync(0);
  });

  it("erreur de connexion (rejet ou exception synchrone) → refus", async () => {
    expect(await askPermission({ request: () => Promise.reject(new Error("pipe cassé")), sessionId: "S", call, description: "" })).toEqual({ allowed: false, verdict: "error" });
    expect(
      await askPermission({
        request: () => {
          throw new Error("boum");
        },
        sessionId: "S",
        call,
        description: "",
      }),
    ).toEqual({ allowed: false, verdict: "error" });
  });

  it("annulation de session (signal) pendant la demande → refus immédiat ; signal déjà annulé → refus sans même interroger l'éditeur", async () => {
    const ctl = new AbortController();
    const p = askPermission({ request: () => new Promise(() => {}), sessionId: "S", call, description: "", signal: ctl.signal });
    ctl.abort();
    expect(await p).toEqual({ allowed: false, verdict: "cancelled" });
    let asked = false;
    const pre = new AbortController();
    pre.abort();
    expect(await askPermission({ request: async () => ((asked = true), selected("allow_once")), sessionId: "S", call, description: "", signal: pre.signal })).toEqual({ allowed: false, verdict: "cancelled" });
    expect(asked).toBe(false);
  });

  it("aucune minuterie ne reste après une réponse (pas de fuite)", async () => {
    await askPermission({ request: async () => selected("allow_once"), sessionId: "S", call, description: "" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
