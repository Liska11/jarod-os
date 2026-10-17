import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdapterRefused,
  AdapterUnavailable,
  beginAuthorization,
  cleanOutput,
  completeAuthorization,
  createPkce,
  DOCLING,
  Embeddings,
  MARKITDOWN,
  MemoryIndex,
  type ModelPin,
  openVecIndex,
  planParse,
  type VecIndex,
} from "../src/index.js";

const weights = new Uint8Array([1, 2, 3, 4]);
const pin: ModelPin = { id: "m", sha256: createHash("sha256").update(weights).digest("hex"), sizeBytes: 4, dimensions: 3 };

function backend(vectors: number[][] = [[1, 0, 0]]) {
  const loaded: string[] = [];
  return { loaded, b: { load: async (_w: Uint8Array, p: ModelPin) => void loaded.push(p.id), embed: async () => vectors } };
}

describe("B1 — embeddings, poids épinglés, accord avant téléchargement", () => {
  it("charge ce qui est installé sans rien demander", async () => {
    const { b, loaded } = backend();
    const e = new Embeddings(pin, { backend: b, fetchWeights: async (_p, mode) => (mode === "installed" ? weights : null) });
    expect(await e.ensureLoaded()).toBe("installed");
    expect(loaded).toEqual(["m"]);
    expect(await e.embed(["a"])).toEqual([[1, 0, 0]]);
  });

  it("sans poids installés, ne télécharge JAMAIS sans accord", async () => {
    const modes: string[] = [];
    const deps = { backend: backend().b, fetchWeights: async (_p: ModelPin, mode: "installed" | "download") => (modes.push(mode), mode === "download" ? weights : null) };
    await expect(new Embeddings(pin, { ...deps, consent: async () => false }).ensureLoaded()).rejects.toThrow(/non accordé/);
    await expect(new Embeddings(pin, deps).ensureLoaded()).rejects.toThrow(/non accordé/);
    expect(modes).not.toContain("download");
    expect(await new Embeddings(pin, { ...deps, consent: async () => true }).ensureLoaded()).toBe("downloaded");
  });

  it("refuse des poids dont la taille ou le SHA-256 ne correspondent pas, sans les charger", async () => {
    const { b, loaded } = backend();
    for (const bad of [new Uint8Array([9, 9, 9, 9]), new Uint8Array([1, 2, 3])]) {
      await expect(new Embeddings(pin, { backend: b, fetchWeights: async () => bad }).ensureLoaded()).rejects.toThrow(AdapterRefused);
    }
    expect(loaded).toEqual([]);
  });

  it("sans moteur ou sans chargement, indisponible ; des vecteurs invalides sont refusés", async () => {
    await expect(new Embeddings(pin, {}).ensureLoaded()).rejects.toThrow(AdapterUnavailable);
    const e = new Embeddings(pin, { backend: backend().b, fetchWeights: async () => weights });
    await expect(e.embed(["a"])).rejects.toThrow(/non chargé/);
    for (const v of [[[1, 0]], [[1, 0, Number.NaN]], [[1, 0, 0], [1, 0, 0]]]) {
      const x = new Embeddings(pin, { backend: backend(v).b, fetchWeights: async () => weights });
      await x.ensureLoaded();
      await expect(x.embed(["a"])).rejects.toThrow(/invalides/);
    }
  });
});

describe("B2 — index vectoriel : sqlite-vec si le PoC d'ABI passe, sinon repli exact", () => {
  it("le repli classe par cosinus, borne k, vérifie la dimension", () => {
    const idx = new MemoryIndex(2);
    idx.add("a", [1, 0]);
    idx.add("b", [0, 1]);
    idx.add("c", [0.9, 0.1]);
    expect(idx.search([1, 0], 2).map((h) => h.id)).toEqual(["a", "c"]);
    expect(idx.search([1, 0], 0)).toEqual([]);
    expect(() => idx.add("x", [1])).toThrow(/dimension/);
    idx.remove("a");
    expect(idx.size()).toBe(2);
  });

  it("PoC réussi : kind sqlite-vec ; PoC échoué ou absent : repli, avec la raison", () => {
    const inner = new MemoryIndex(2) as unknown as VecIndex;
    expect(openVecIndex(2, { probe: () => ({ version: "0.1.6" }), open: () => inner }).index.kind).toBe("sqlite-vec");
    const failed = openVecIndex(2, { probe: () => { throw new Error("ABI incompatible"); }, open: () => inner });
    expect(failed.index.kind).toBe("memory");
    expect(failed.reason).toMatch(/ABI incompatible/);
    expect(openVecIndex(2, { probe: () => ({ version: "" }), open: () => inner }).index.kind).toBe("memory");
    expect(openVecIndex(2).reason).toMatch(/non branchée/);
  });
});

describe("B3 / B5 — sidecars d'analyse de documents", () => {
  const ok = { path: "docs/rapport.pdf", sizeBytes: 1000 };

  it("construit un appel confiné, jamais une exécution directe", () => {
    expect(planParse(DOCLING, ok, true)).toEqual({ name: "run_shell", args: { command: 'docling "docs/rapport.pdf"', isolation: "workspace", timeout_seconds: 300 } });
    expect(String(planParse(MARKITDOWN, { ...ok, ocr: true }, true).args.command)).toContain("--use-plugins");
  });

  it("sidecar absent : indisponible ; chemin, type, taille ou option hors politique : refusé", () => {
    expect(() => planParse(DOCLING, ok, false)).toThrow(AdapterUnavailable);
    for (const path of ["../x.pdf", "/etc/x.pdf", "C:\\x.pdf", 'a"; del *.pdf', "a&b.pdf", "x.exe"]) expect(() => planParse(DOCLING, { ...ok, path }, true), path).toThrow(AdapterRefused);
    expect(() => planParse(DOCLING, { ...ok, sizeBytes: 60_000_000 }, true)).toThrow(/taille/);
    expect(() => planParse(DOCLING, { ...ok, sizeBytes: Number.NaN }, true)).toThrow(/taille/);
    expect(() => planParse(DOCLING, { ...ok, ocr: true }, true)).toThrow(/OCR/);
  });

  it("la sortie perd ses séquences d'échappement et caractères de contrôle invisibles, et est bornée", () => {
    expect(cleanOutput(DOCLING, "a\x1b[31mb\x00c\u202ed\u200be").markdown).toBe("abcde");
    const big = cleanOutput({ ...DOCLING, maxOutputChars: 5 }, "123456789");
    expect(big).toEqual({ markdown: "12345", truncated: true });
  });
});

describe("B4 — OAuth PKCE, jetons dans le coffre seulement", () => {
  const req = { authorizationEndpoint: "https://as.example/authorize", tokenEndpoint: "https://as.example/token", clientId: "cid", redirectUri: "http://127.0.0.1:8123/cb", scopes: ["mcp", "read"] };

  it("PKCE S256 : le défi est le SHA-256 du vérificateur", () => {
    const p = createPkce();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.challenge).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    expect(createPkce().verifier).not.toBe(p.verifier);
  });

  it("l'URL d'autorisation porte state et défi, jamais le vérificateur", () => {
    const a = beginAuthorization(req);
    const u = new URL(a.url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(a.url).not.toContain(a.verifier);
  });

  it("refuse http hors boucle locale, redirection non locale, identifiants dans l'URL, client_id vide", () => {
    expect(() => beginAuthorization({ ...req, authorizationEndpoint: "http://as.example/a" })).toThrow(/https/);
    expect(() => beginAuthorization({ ...req, tokenEndpoint: "http://as.example/t" })).toThrow(/https/);
    expect(() => beginAuthorization({ ...req, redirectUri: "https://evil.example/cb" })).toThrow(/boucle/);
    expect(() => beginAuthorization({ ...req, authorizationEndpoint: "https://u:p@as.example/a" })).toThrow(/identifiants/);
    expect(() => beginAuthorization({ ...req, clientId: " " })).toThrow(/client_id/);
    expect(() => beginAuthorization({ ...req, authorizationEndpoint: "http://127.0.0.1:9/a", tokenEndpoint: "http://127.0.0.1:9/t" }, { allowLoopbackEndpoints: true })).not.toThrow();
  });

  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("échange le code, dépose les jetons dans le coffre et ne rend que leurs noms", async () => {
    const a = beginAuthorization(req);
    const stored: Record<string, string> = {};
    let sent = "";
    const res = await completeAuthorization(a, `http://127.0.0.1:8123/cb?code=abc&state=${a.state}`, "mcp_demo", {
      vault: { put: (n, v) => void (stored[n] = v) },
      fetch: (async (_u: unknown, init: RequestInit) => ((sent = String(init.body)), new Response(JSON.stringify({ access_token: "AT-123", refresh_token: "RT-456", expires_in: 3600, token_type: "Bearer" })))) as typeof fetch,
    });
    expect(res).toEqual({ accessName: "mcp_demo_access_token", refreshName: "mcp_demo_refresh_token", expiresIn: 3600 });
    expect(stored).toEqual({ mcp_demo_access_token: "AT-123", mcp_demo_refresh_token: "RT-456" });
    expect(JSON.stringify(res)).not.toContain("AT-123");
    expect(sent).toContain(`code_verifier=${a.verifier}`);
  });

  it("refuse un state faux, une erreur du serveur, un code absent, une réutilisation, une réponse sans jeton", async () => {
    const deps = (body: unknown, status = 200) => ({ vault: { put: () => {} }, fetch: reply(body, status) as unknown as typeof fetch });
    const fresh = () => beginAuthorization(req);
    await expect(completeAuthorization(fresh(), "http://127.0.0.1:8123/cb?code=abc&state=nope", "p", deps({}))).rejects.toThrow(/state/);
    const e = fresh();
    await expect(completeAuthorization(e, `http://127.0.0.1:8123/cb?error=access_denied&state=${e.state}`, "p", deps({}))).rejects.toThrow(/refusée/);
    const n = fresh();
    await expect(completeAuthorization(n, `http://127.0.0.1:8123/cb?state=${n.state}`, "p", deps({}))).rejects.toThrow(/code manquant/);
    const r = fresh();
    await expect(completeAuthorization(r, `http://127.0.0.1:8123/cb?code=1&state=${r.state}`, "p", deps({ access_token: "x" }))).resolves.toBeDefined();
    await expect(completeAuthorization(r, `http://127.0.0.1:8123/cb?code=1&state=${r.state}`, "p", deps({ access_token: "x" }))).rejects.toThrow(/déjà utilisée/);
    const s = fresh();
    await expect(completeAuthorization(s, `http://127.0.0.1:8123/cb?code=1&state=${s.state}`, "p", deps({ nope: 1 }))).rejects.toThrow(/access_token/);
    const h = fresh();
    await expect(completeAuthorization(h, `http://127.0.0.1:8123/cb?code=1&state=${h.state}`, "p", deps({}, 400))).rejects.toThrow(/HTTP 400/);
  });
});
