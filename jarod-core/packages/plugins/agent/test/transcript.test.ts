// §3.6-7 : `transcript` ne doit pas couper la tête de l'historique (l'instruction de départ, et le
// « RÉSUMÉ PRÉCÉDENT » que `history()` place en tête). Ce qui tombe en premier, ce sont les échanges
// les plus anciens : le milieu. La coupe doit être dite, et ne jamais dépasser la limite.
import { describe, expect, it } from "vitest";
import type { Message } from "@jarod/contracts";
import { transcript } from "../src/agent.js";

function msg(over: Pick<Message, "role" | "content"> & Partial<Message>): Message {
  return { id: `m-${over.role}-${over.content.length}`, sessionId: "s1", createdAt: 1, ...over };
}

/** Un historique bien plus long que la limite : la tête porte l'instruction, la fin le dernier mot. */
function longHistory(): Message[] {
  return [
    msg({ role: "user", content: "INSTRUCTION DE DÉPART : construis la passerelle." }),
    msg({ role: "assistant", content: "b".repeat(400_000) }),
    msg({ role: "user", content: "DERNIER ÉCHANGE" }),
  ];
}

describe("transcript (coupe du contexte)", () => {
  it("garde la tête (instruction de départ) et la fin, et ne retire que le milieu", () => {
    const out = transcript(longHistory(), 10_000, (text) => text);
    expect(out).toContain("INSTRUCTION DE DÉPART");
    expect(out).toContain("DERNIER ÉCHANGE");
    expect(out).toContain("caractères omis : les échanges les plus anciens");
    expect(out.length).toBeLessThanOrEqual(10_000);
  });

  it("garde aussi le résumé précédent, que `history()` place en tête", () => {
    const messages = [msg({ role: "user", content: "RÉSUMÉ UTILE", kind: "summary" }), ...longHistory()];
    const out = transcript(messages, 5_000, (text) => text);
    expect(out).toContain("RÉSUMÉ PRÉCÉDENT : RÉSUMÉ UTILE");
    expect(out.length).toBeLessThanOrEqual(5_000);
  });

  it("ne dépasse jamais la limite, même quand elle est plus petite que la place réservée au marqueur", () => {
    const out = transcript(longHistory(), 100, (text) => text);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("INSTRUCTION DE DÉPART");
  });

  it("rend l'historique tel quel quand il tient sous la limite", () => {
    const messages = [msg({ role: "user", content: "bonjour" })];
    expect(transcript(messages, 10_000, (text) => text)).toBe("UTILISATEUR : bonjour");
  });
});
