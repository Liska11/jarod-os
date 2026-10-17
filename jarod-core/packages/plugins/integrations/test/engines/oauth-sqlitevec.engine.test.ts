// Tests contre les VRAIS moteurs : oauth4webapi (B4) et sqlite-vec dans better-sqlite3-multiple-ciphers (B2).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import * as oauth from "oauth4webapi";
import * as sqliteVec from "sqlite-vec";
import { afterAll, describe, expect, it } from "vitest";
import { beginAuthorization, completeAuthorization, createPkce, openVecIndex, sqliteVecExtension } from "../../src/index.js";

describe("B4 contre oauth4webapi (moteur réel)", () => {
  it("notre défi PKCE est exactement celui que calcule oauth4webapi", async () => {
    const ours = createPkce();
    expect(await oauth.calculatePKCECodeChallenge(ours.verifier)).toBe(ours.challenge);
  });

  it("oauth4webapi valide la redirection de notre flux (state) et notre échange de code réussit contre un vrai serveur HTTP local", async () => {
    let received = "";
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = body;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "AT-engine", token_type: "Bearer", expires_in: 60, refresh_token: "RT-engine" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const pending = beginAuthorization(
        { authorizationEndpoint: `http://127.0.0.1:${port}/authorize`, tokenEndpoint: `http://127.0.0.1:${port}/token`, clientId: "cid", redirectUri: "http://127.0.0.1:8123/cb", scopes: ["mcp"] },
        { allowLoopbackEndpoints: true },
      );
      const callback = `http://127.0.0.1:8123/cb?code=abc&state=${pending.state}`;
      // oauth4webapi : même lecture de la redirection, avec l'état attendu
      const as = { issuer: `http://127.0.0.1:${port}` } as oauth.AuthorizationServer;
      const params = oauth.validateAuthResponse(as, { client_id: "cid" }, new URL(callback), pending.state);
      expect(params.get("code")).toBe("abc");
      expect(() => oauth.validateAuthResponse(as, { client_id: "cid" }, new URL(`http://127.0.0.1:8123/cb?code=abc&state=autre`), pending.state)).toThrow();

      const vault: Record<string, string> = {};
      const done = await completeAuthorization(pending, callback, "eng", { vault: { put: (n, v) => void (vault[n] = v) }, fetch });
      expect(done.accessName).toBe("eng_access_token");
      expect(vault.eng_access_token).toBe("AT-engine");
      expect(new URLSearchParams(received).get("code_verifier")).toBe(pending.verifier);
      expect(oauth.OperationProcessingError).toBeDefined();
    } finally {
      server.close();
    }
  });
});

describe("B2 contre sqlite-vec chargé dans better-sqlite3-multiple-ciphers (PoC d'ABI réel)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-vec-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const path = sqliteVec.getLoadablePath();

  function exercise(db: InstanceType<typeof Database>) {
    const { index, reason } = openVecIndex(3, sqliteVecExtension(db, path));
    expect(reason).toBeUndefined();
    expect(index.kind).toBe("sqlite-vec");
    index.add("a", [1, 0, 0]);
    index.add("b", [0, 1, 0]);
    index.add("c", [0.9, 0.1, 0]);
    expect(index.search([1, 0, 0], 2).map((h) => h.id)).toEqual(["a", "c"]);
    expect(index.search([1, 0, 0], 1)[0]!.score).toBeCloseTo(1, 5);
    index.add("a", [0, 0, 1]); // remplacement
    expect(index.size()).toBe(3);
    expect(index.search([0, 0, 1], 1)[0]!.id).toBe("a");
    index.remove("a");
    expect(index.size()).toBe(2);
    expect(() => index.add("x", [1, 2])).toThrow(/invalide/);
  }

  it("base en clair", () => {
    const db = new Database(join(dir, "plain.db"));
    try {
      exercise(db);
    } finally {
      db.close();
    }
  });

  it("base CHIFFRÉE : l'extension se charge et les recherches fonctionnent", () => {
    const db = new Database(join(dir, "enc.db"));
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma("key='cle-de-test-uniquement'");
      exercise(db);
    } finally {
      db.close();
    }
  });

  it("une extension introuvable fait retomber sur le repli exact avec la raison", () => {
    const db = new Database(":memory:");
    const r = openVecIndex(2, sqliteVecExtension(db, join(dir, "absent.dll")));
    expect(r.index.kind).toBe("memory");
    expect(r.reason).toMatch(/PoC d'ABI échoué/);
    db.close();
  });
});
