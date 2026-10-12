// Portage de packages/core/test/webhook-routes.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { Router } from "@jarod/plugin-llm";
import { WebhookService } from "../src/webhooks.js";
import { makeCore } from "./helpers.js";

describe("le serveur d'écoute sert aussi les routes de plugin", () => {
  it("répond à une route de plugin en HTTP réel, et continue de refuser les déclencheurs non signés", async () => {
    const core = await makeCore();
    const router = new Router();
    router.register("documents", "GET", "/documents/:id", ({ params }) => ({
      body: { id: params.id, titre: "notes" },
    }));
    const webhooks = new WebhookService({ db: core.db, port: 0, router, onHook: () => {} });
    webhooks.secret("build");
    await webhooks.start();

    const route = await fetch(`http://127.0.0.1:${webhooks.status().port}/documents/7`);
    expect(route.status).toBe(200);
    expect(await route.json()).toEqual({ id: "7", titre: "notes" });

    // Le chemin réservé reste réservé : la signature exigée n'a pas bougé d'un pouce.
    const hook = await fetch(webhooks.url("build"), { method: "POST", body: "{}" });
    expect(hook.status).toBe(401);

    // Et un chemin que personne ne tient rend un 404, pas une page blanche.
    expect((await fetch(`http://127.0.0.1:${webhooks.status().port}/inconnu`)).status).toBe(404);
    await webhooks.stop();
  });

  it("sans routeur, un chemin inconnu rend 404 au lieu de faire semblant", async () => {
    const core = await makeCore();
    const webhooks = new WebhookService({ db: core.db, port: 0, onHook: () => {} });
    await webhooks.start();
    expect((await fetch(`http://127.0.0.1:${webhooks.status().port}/documents/7`)).status).toBe(404);
    await webhooks.stop();
  });
});

describe("une route de plugin ne se laisse pas appeler par une page web", () => {
  async function servi() {
    const core = await makeCore();
    const router = new Router();
    let appels = 0;
    router.register("agenda", "POST", "/api/agenda/events", () => {
      appels += 1;
      return { body: { ok: true } };
    });
    const webhooks = new WebhookService({ db: core.db, port: 0, router, onHook: () => {} });
    await webhooks.start();
    const base = `http://127.0.0.1:${webhooks.status().port}/api/agenda/events`;
    return { webhooks, base, appels: () => appels };
  }

  it("un outil local passe", async () => {
    const s = await servi();
    expect((await fetch(s.base, { method: "POST", body: "{}" })).status).toBe(200);
    expect(s.appels()).toBe(1);
    await s.webhooks.stop();
  });

  it("une page d'un autre site est refusée AVANT que le plugin ne soit appelé (CSRF)", async () => {
    const s = await servi();
    const res = await fetch(s.base, { method: "POST", body: "{}", headers: { origin: "https://pirate.example" } });
    expect(res.status).toBe(403);
    const cross = await fetch(s.base, { method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.status).toBe(403);
    expect(s.appels()).toBe(0);
    await s.webhooks.stop();
  });

  it("un nom de domaine qui se résout en 127.0.0.1 est refusé (DNS rebinding)", async () => {
    const s = await servi();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(s.base, { method: "POST", headers: { host: "pirate.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
    expect(s.appels()).toBe(0);
    await s.webhooks.stop();
  });

  it("les déclencheurs signés ne changent pas : leur signature les protège, même derrière un tunnel", async () => {
    const s = await servi();
    const hook = await fetch(s.base.replace("/api/agenda/events", "/hook/inconnu"), {
      method: "POST",
      body: "{}",
      headers: { origin: "https://pirate.example" },
    });
    // 404 « déclencheur inconnu », pas 403 : le chemin des déclencheurs n'est pas celui des plugins.
    expect(hook.status).toBe(404);
    await s.webhooks.stop();
  });
});
