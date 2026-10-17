// L'échange de code contre des jetons est borné : un point d'accès qui ne répond pas n'attend pas indéfiniment, et rien n'est déposé dans le coffre.
import { describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization } from "../src/impl/oauth.js";

describe("completeAuthorization : délai", () => {
  it("passe un signal à l'échange, et un point d'accès muet fait échouer l'échange sans rien déposer", async () => {
    const req = { authorizationEndpoint: "https://a.example/auth", tokenEndpoint: "https://a.example/token", redirectUri: "http://127.0.0.1:9/cb", clientId: "c", scopes: ["s"] } as never;
    const pending = beginAuthorization(req);
    const stored: string[] = [];
    let seen: AbortSignal | undefined;
    const mute = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        seen = init.signal ?? undefined;
        init.signal?.addEventListener("abort", () => reject(new Error("délai dépassé")));
      })) as never;

    const done = completeAuthorization(pending, `http://127.0.0.1:9/cb?state=${pending.state}&code=abc`, "p", { fetch: mute, vault: { put: (n: string) => void stored.push(n) }, timeoutMs: 100 } as never);

    await expect(done).rejects.toThrow("délai dépassé");
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(stored).toEqual([]);
  });
});
