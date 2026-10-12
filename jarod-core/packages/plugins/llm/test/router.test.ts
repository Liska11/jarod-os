// Portage de packages/core/test/router.test.ts (rév. 2e180305).
import { describe, expect, it, vi } from "vitest";
import { Router } from "../src/router.js";

function request(method: string, path: string) {
  return { method, path, params: {}, query: {}, headers: {}, body: "" };
}

describe("routes de plugin", () => {
  it("relie un chemin à une fonction, et rend ce qu'elle répond", async () => {
    const router = new Router();
    router.register("documents", "GET", "/documents", () => ({ body: { liste: [] } }));
    const reply = await router.handle(request("GET", "/documents"));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ liste: [] });
  });

  it("extrait les paramètres du chemin au lieu de les laisser deviner", async () => {
    const router = new Router();
    router.register("documents", "GET", "/documents/:id/pdf", ({ params }) => ({ body: { id: params.id } }));
    const reply = await router.handle(request("GET", "/documents/42/pdf"));
    expect(reply.body).toEqual({ id: "42" });
  });

  it("désactiver un plugin retire ses routes : une porte qu'on croit fermée doit l'être", async () => {
    const router = new Router();
    router.register("ssh", "POST", "/ssh/run", () => ({ body: {} }));
    router.register("autre", "GET", "/autre", () => ({ body: {} }));
    expect(router.unmount("ssh")).toBe(1);
    expect((await router.handle(request("POST", "/ssh/run"))).status).toBe(404);
    // Le voisin n'est pas emporté au passage.
    expect((await router.handle(request("GET", "/autre"))).status).toBe(200);
    expect(router.list()).toEqual([{ owner: "autre", method: "GET", path: "/autre" }]);
  });

  it("refuse qu'un plugin réclame le chemin réservé aux déclencheurs", () => {
    const router = new Router();
    expect(() => router.register("curieux", "POST", "/hook/build", () => ({}))).toThrow(/ROUTE_RESERVED/);
    expect(() => router.register("curieux", "POST", "/hook", () => ({}))).toThrow(/ROUTE_RESERVED/);
  });

  it("refuse deux propriétaires sur le même chemin, verbe par verbe", () => {
    const router = new Router();
    router.register("un", "GET", "/x", () => ({}));
    expect(() => router.register("deux", "GET", "/x", () => ({}))).toThrow(/ROUTE_TAKEN/);
    // Un autre verbe reste libre : GET et POST ne se marchent pas dessus.
    expect(() => router.register("deux", "POST", "/x", () => ({}))).not.toThrow();
  });

  it("un chemin inconnu rend un 404 honnête", async () => {
    const router = new Router();
    const reply = await router.handle(request("GET", "/rien"));
    expect(reply).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("une route qui casse ne fait pas tomber le serveur qui écoute", async () => {
    const router = new Router();
    const survivor = vi.fn(() => ({ body: "toujours là" }));
    router.register("casse", "GET", "/casse", () => {
      throw new Error("boum");
    });
    router.register("sain", "GET", "/sain", survivor);
    const broken = await router.handle(request("GET", "/casse"));
    expect(broken.status).toBe(500);
    expect(JSON.stringify(broken.body)).toContain("boum");
    // La route voisine répond encore : une seule fonction fautive ne condamne pas le serveur.
    expect((await router.handle(request("GET", "/sain"))).body).toBe("toujours là");
    expect(survivor).toHaveBeenCalled();
  });
});
