// V-07 — un fichier venu d'une messagerie ou du téléphone ne devient une pièce jointe que si la quarantaine l'admet (vrai kernel, analyseur
// déterministe ; Defender réel : plugins/quarantine/test/admit.test.ts).
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore, type TestCore as JarodCore, tempDir } from "./helpers.js";

function script(core: JarodCore, replies: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => [],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r = { text: "", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...(replies.shift() ?? { text: "fin" }) };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

const file = (name: string, text: string) => ({ name, mime: "application/pdf", size: text.length, download: async () => Buffer.from(text) });

/** La quarantaine du kernel, lue par sa forme (ce paquet ne dépend pas de plugin-quarantine). */
const traces = (core: JarodCore) => (core.app as unknown as { quarantine: { list(): { label: string; status: string; provenance: { source: string } }[] } }).quarantine.list();

const lastUser = (requests: ChatRequest[]) => JSON.stringify(requests.at(-1)?.messages.filter((m) => m.role === "user").at(-1) ?? null);

describe("V-07 — quarantaine des pièces jointes des passerelles", () => {
  it("propre : la pièce jointe arrive dans la conversation, et la quarantaine garde la trace de sa provenance", async () => {
    const core = await makeCore({ dataDir: tempDir() });
    script(core, [{ text: "lu" }]);
    expect(await core.handleGatewayMessage("telegram", "42", "regarde", "ana", [file("devis.pdf", "contenu propre")])).toBe("lu");

    const session = core.sessions.list()[0]!;
    const user = core.messages.list(session.id).find((m) => m.role === "user");
    expect(user?.attachments?.map((a) => a.name)).toEqual(["devis.pdf"]);
    expect(traces(core)).toEqual([expect.objectContaining({ label: "devis.pdf", status: "promoted", provenance: { source: "telegram" } })]);
  });

  it("infecté : aucune pièce jointe, le modèle et la personne lisent pourquoi", async () => {
    const core = await makeCore({ dataDir: tempDir(), scan: "infected" });
    const requests = script(core, [{ text: "vu" }]);
    await core.handleGatewayMessage("discord", "C1", "ouvre ça", "ana", [file("facture.pdf", "charge")]);

    const session = core.sessions.list()[0]!;
    const user = core.messages.list(session.id).find((m) => m.role === "user");
    expect(user?.attachments ?? []).toEqual([]);
    expect(lastUser(requests)).toMatch(/facture\.pdf.*refusé par la quarantaine : menace détectée/);
    expect(traces(core)).toEqual([expect.objectContaining({ status: "infected", provenance: { source: "discord" } })]);
  });

  it("sans analyse possible : refusé aussi — un fichier non analysé n'entre pas", async () => {
    const core = await makeCore({ dataDir: tempDir(), scan: "unavailable" });
    expect(() => core.admitAttachment("photo.png", "image/png", Buffer.from("png"), "phone")).toThrow(/non analysé n'entre pas/);
    expect(traces(core)).toEqual([expect.objectContaining({ status: "unscanned", provenance: { source: "phone" } })]);
  });
});
