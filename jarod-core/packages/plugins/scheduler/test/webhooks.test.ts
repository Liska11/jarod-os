// Portage de packages/core/test/webhooks.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { sign, WebhookService } from "../src/webhooks.js";
import { makeCore } from "./helpers.js";

async function setup() {
  const core = await makeCore();
  const received: { hookId: string; payload: unknown }[] = [];
  const webhooks = new WebhookService({
    db: core.db,
    port: 0,
    onHook: (hookId, payload) => {
      received.push({ hookId, payload });
    },
  });
  return { core, webhooks, received };
}

describe("déclencheurs entrants signés", () => {
  it("accepte une requête correctement signée, et passe la charge utile", async () => {
    const { webhooks, received } = await setup();
    webhooks.secret("build");
    const status = await webhooks.start();
    const body = JSON.stringify({ branche: "main" });

    const answer = await fetch(webhooks.url("build"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-jarod-signature": sign(body, webhooks.secret("build")) },
      body,
    });

    expect(answer.status).toBe(202);
    expect(received).toEqual([{ hookId: "build", payload: { branche: "main" } }]);
    await webhooks.stop();
    expect(status.running).toBe(true);
  });

  it("refuse une signature fausse, et n'exécute rien", async () => {
    const { webhooks, received } = await setup();
    webhooks.secret("build");
    await webhooks.start();
    const body = JSON.stringify({ malveillant: true });

    const answer = await fetch(webhooks.url("build"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-jarod-signature": sign(body, "mauvais-secret") },
      body,
    });

    expect(answer.status).toBe(401);
    expect(received).toHaveLength(0);
    // Le refus est journalisé : une porte qui ne dit que ses entrées ne dit rien.
    expect(webhooks.journal().at(-1)).toMatchObject({ accepted: false, reason: "signature invalide" });
    await webhooks.stop();
  });

  it("refuse une requête sans signature du tout", async () => {
    const { webhooks, received } = await setup();
    webhooks.secret("build");
    await webhooks.start();
    const answer = await fetch(webhooks.url("build"), { method: "POST", body: "{}" });
    expect(answer.status).toBe(401);
    expect(received).toHaveLength(0);
    await webhooks.stop();
  });

  it("refuse un déclencheur inconnu, même bien signé", async () => {
    const { webhooks } = await setup();
    await webhooks.start();
    const body = "{}";
    const answer = await fetch(webhooks.url("inconnu"), {
      method: "POST",
      headers: { "x-jarod-signature": sign(body, "peu-importe") },
      body,
    });
    expect(answer.status).toBe(404);
    expect(webhooks.journal().at(-1)?.reason).toBe("déclencheur inconnu");
    await webhooks.stop();
  });

  it("refuse une charge utile trop grande au lieu de la lire indéfiniment", async () => {
    const { webhooks, received } = await setup();
    webhooks.secret("build");
    await webhooks.start();
    const body = JSON.stringify({ trop: "x".repeat(300 * 1024) });
    const answer = await fetch(webhooks.url("build"), {
      method: "POST",
      headers: { "x-jarod-signature": sign(body, webhooks.secret("build")) },
      body,
    });
    expect(answer.status).toBe(413);
    expect(received).toHaveLength(0);
    expect(webhooks.journal().at(-1)?.reason).toMatch(/trop grande/);
    await webhooks.stop();
  });

  it("le secret vit dans la table chiffrée, pas dans les réglages qui s'exportent", async () => {
    const { webhooks, core } = await setup();
    const secret = webhooks.secret("build");
    expect(secret).toHaveLength(64);
    expect(webhooks.hooks()).toContain("build");
    // Même secret tant qu'on ne tourne pas la clé, et il n'apparaît nulle part dans les réglages.
    expect(webhooks.secret("build")).toBe(secret);
    expect(webhooks.secret("build", true)).not.toBe(secret);
    expect(JSON.stringify(core.settings.getAll())).not.toContain(secret);
  });

  it("l'adresse donnée à un appelant ne contient jamais le secret", async () => {
    const { webhooks } = await setup();
    webhooks.secret("build");
    await webhooks.start();
    expect(webhooks.url("build")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/build$/);
    expect(webhooks.url("build")).not.toContain(webhooks.secret("build"));
    await webhooks.stop();
  });
});
