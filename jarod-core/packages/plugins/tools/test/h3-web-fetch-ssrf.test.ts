/**
 * H3 (audit v4 § 1) — `web_fetch` doit refuser la machine locale, et exiger l'accord de l'utilisateur.
 *
 * Avant correctif : aucun contrôle d'hôte, `fetch()` suivait les redirections par défaut et l'outil n'était
 * pas marqué `dangerous`. Un contenu non fiable (page, PDF indexé, corps de webhook, e-mail) pouvait donc
 * faire lire `http://127.0.0.1:8080/props` (llama-server) ou une interface d'admin locale, et surtout faire
 * partir la mémoire du prompt dans l'URL (`https://x/?d=…`) SANS aucune fenêtre d'accord.
 *
 * Les tests n'utilisent que la surface publique de l'outil (le vrai cœur) : `fetch` est remplacé, donc
 * aucun accès réseau réel — et « refusé » veut dire « `fetch` jamais appelé ».
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCore } from "./helpers.js";

const ctx = {} as never;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** L'outil, sur le cœur réel (storage + memory + llm + skills + rag + tools). */
async function webFetch() {
  const core = await makeCore();
  const tool = core.tools.get("web_fetch");
  expect(tool, "web_fetch doit être enregistré").toBeTruthy();
  return tool!;
}

/** Remplace `fetch` et rend l'espion, pour prouver qu'aucun accès réseau n'a eu lieu. */
function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response> = () => new Response("ok")) {
  const spy = vi.fn(impl);
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const PRIVES = [
  "http://127.0.0.1:8080/v1/models", // llama-server
  "http://127.1.2.3/", // toute la boucle locale, pas seulement .0.1
  "http://localhost:8920/v1/embeddings",
  "http://[::1]:8080/health",
  "http://169.254.169.254/latest/meta-data/", // métadonnées cloud
  "http://10.0.0.5/",
  "http://172.16.4.4/",
  "http://192.168.1.1/",
  "http://0.0.0.0/",
  "http://[::ffff:127.0.0.1]/", // boucle locale encapsulée en IPv6
  "http://[fd00::1]/", // ULA
];

describe("H3 — `web_fetch` refuse la boucle locale, les réseaux privés et les redirections qui y mènent", () => {
  it("aucun accès réseau n'est tenté, quel que soit l'hôte local visé", async () => {
    const tool = await webFetch();
    for (const url of PRIVES) {
      const spy = stubFetch();
      await expect(tool.run({ url }, ctx), url).rejects.toThrow(/locale|privée|interne|refus|autoris/i);
      expect(spy, `${url} ne doit pas atteindre le réseau`).not.toHaveBeenCalled();
    }
  });

  it("une redirection vers la boucle locale est refusée : le garde s'applique à CHAQUE saut", async () => {
    const tool = await webFetch();
    const spy = stubFetch(
      (url) =>
        String(url).startsWith("http://127.0.0.1")
          ? new Response("secret local")
          : new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/v1/models" } }),
    );
    await expect(tool.run({ url: "http://example.com/redir" }, ctx)).rejects.toThrow(/locale|privée|interne|refus/i);
    // Le premier saut a bien été tenté (l'URL publique), le second JAMAIS.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toBe("http://example.com/redir");
  });

  it("les redirections ne sont pas suivies automatiquement (`redirect: manual`)", async () => {
    const tool = await webFetch();
    const spy = stubFetch(() => new Response("texte public", { headers: { "content-type": "text/plain" } }));
    await tool.run({ url: "http://example.com/page" }, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("une redirection normale est suivie jusqu'au bout (l'outil reste utilisable)", async () => {
    const tool = await webFetch();
    const spy = stubFetch(
      (url) =>
        String(url) === "http://example.com/page"
          ? new Response(null, { status: 301, headers: { location: "https://example.com/final" } })
          : new Response("contenu final", { headers: { "content-type": "text/plain" } }),
    );
    const out = await tool.run({ url: "http://example.com/page" }, ctx);
    expect(out).toContain("contenu final");
    expect(String(spy.mock.calls.at(-1)![0])).toBe("https://example.com/final");
  });

  it("l'exfiltration demande un accord : l'outil est `dangerous`", async () => {
    expect((await webFetch()).dangerous).toBe(true);
  });

  it("http(s) seulement, et une URL illisible est refusée proprement", async () => {
    const tool = await webFetch();
    const spy = stubFetch();
    await expect(tool.run({ url: "file:///C:/Windows/win.ini" }, ctx)).rejects.toThrow(/http/i);
    await expect(tool.run({ url: "pas une url" }, ctx)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});