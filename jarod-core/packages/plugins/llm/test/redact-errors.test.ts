// AV2-009 — une clé citée dans le corps d'erreur d'un fournisseur ne doit ni s'afficher ni entrer dans le journal.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleClient, describeStreamError } from "../src/openai.js";

const CLE = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

function serveur(status: number, body: string): Promise<{ url: string; close: () => void }> {
  const s = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  });
  return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, close: () => s.close() })));
}

describe("AV2-009 : secrets dans les erreurs fournisseur", () => {
  it("listModels : le corps d'une erreur 401 qui cite la clé est masqué", async () => {
    const s = await serveur(401, `Incorrect API key provided: ${CLE}.`);
    try {
      const err = await new OpenAICompatibleClient(s.url, CLE).listModels().then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).not.toContain(CLE);
      expect(err!.message).toContain("401");
    } finally {
      s.close();
    }
  });

  it("chat : une erreur HTTP non rejouable est masquée (et bornée)", async () => {
    const s = await serveur(400, `bad request, header Authorization: Bearer ${CLE}${"x".repeat(5000)}`);
    try {
      const err = await new OpenAICompatibleClient(s.url, CLE)
        .chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] } as never, {})
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).not.toContain(CLE);
      expect(err!.message.length).toBeLessThan(900);
    } finally {
      s.close();
    }
  });

  it("erreur citée dans le flux : masquée", () => {
    expect(describeStreamError({ message: `invalid key ${CLE}` }, 100, 0)).not.toContain(CLE);
  });
});
