// Passerelle compatible Hermes : l'écran « Providers » du shell (fournisseurs, clés API, adresses, test). Logique pure, puis le VRAI noyau par HTTP.
// Règle vérifiée partout : une clé enregistrée ne ressort JAMAIS (réponse, erreur, test).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { ConfigError } from "../src/gateway/config.js";
import { cleanKey, clearProviderKey, keySecretName, type ProviderInfoLike, providerRows, setExtraProviderKeys, setProviderKey, setProviderOverride, testProvider } from "../src/gateway/providers.js";
import { createGateway } from "../src/gateway/server.js";

const KEY = ["sk", "CANARI-PROVIDERS-0123456789abcdef"].join("-");
const OTHER = ["sk", "CANARI-AUTRE-0123456789abcdef0123"].join("-");

const list: ProviderInfoLike[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", models: ["gpt-x"], hasKey: false, configured: false, extraKeys: 0, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434", models: [], local: true, configured: true },
];

function fakeSettings(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { providerOverrides: {}, ...initial };
  const secrets = new Map<string, string>();
  return {
    state,
    secrets,
    get: (k: string) => state[k],
    patch: (p: Record<string, unknown>) => void Object.assign(state, p),
    setSecret: (k: string, v: string) => void (v ? secrets.set(k, v) : secrets.delete(k)),
  };
}

describe("clés", () => {
  it("cleanKey : rogne les bords, refuse le vide, les espaces internes, les guillemets, le non imprimable et le trop long", () => {
    expect(cleanKey(`  ${KEY}\n`)).toBe(KEY);
    for (const bad of ["", "   ", "sk abc", 'sk"abc', "sk'abc", "sk`abc", "clé-é", "a\u0000b", "x".repeat(2049)]) expect(() => cleanKey(bad)).toThrow(ConfigError);
    expect(() => cleanKey(42)).toThrow(ConfigError);
  });

  it("setProviderKey écrit dans le coffre sous le nom du noyau ; clearProviderKey l'efface ; un fournisseur inconnu est refusé sans rien écrire", () => {
    const s = fakeSettings();
    setProviderKey(s, list, "openai", KEY);
    expect(s.secrets.get("provider:openai:apiKey")).toBe(KEY);
    expect(keySecretName("openai")).toBe("provider:openai:apiKey");
    clearProviderKey(s, list, "openai");
    expect(s.secrets.size).toBe(0);
    expect(() => setProviderKey(s, list, "inconnu", KEY)).toThrow(/inconnu/);
    expect(s.secrets.size).toBe(0);
  });

  it("le message d'erreur d'une clé refusée ne la répète pas", () => {
    const bad = `${KEY} avec espace`;
    let message = "";
    try {
      cleanKey(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("CANARI");
  });

  it("les clés supplémentaires : liste remplacée en bloc, chacune vérifiée, 20 au plus", () => {
    const got: string[][] = [];
    const router = { list: () => list, setExtraKeys: (_id: string, keys: string[]) => void got.push(keys), client: () => ({ listModels: async () => [] }) };
    setExtraProviderKeys(router, "openai", [KEY, OTHER]);
    expect(got).toEqual([[KEY, OTHER]]);
    expect(() => setExtraProviderKeys(router, "openai", "pas une liste")).toThrow(ConfigError);
    expect(() => setExtraProviderKeys(router, "openai", [KEY, "mauvaise clé"])).toThrow(ConfigError);
    expect(() => setExtraProviderKeys(router, "openai", Array.from({ length: 21 }, () => KEY))).toThrow(/20/);
    expect(got).toHaveLength(1);
  });
});

describe("adresse et modèles", () => {
  it("écrit la surcharge, garde les autres champs, et la valeur vide revient au catalogue", () => {
    const s = fakeSettings({ providerOverrides: { openai: { baseUrl: "http://x/v1", extra: 1 }, autre: { models: ["m"] } } });
    setProviderOverride(s, list, "openai", { models: [" gpt-y ", "gpt-y", "", "gpt-z"] });
    expect(s.state.providerOverrides).toEqual({ openai: { baseUrl: "http://x/v1", extra: 1, models: ["gpt-y", "gpt-z"] }, autre: { models: ["m"] } });
    setProviderOverride(s, list, "openai", { baseUrl: " http://127.0.0.1:1234/v1/ " });
    expect((s.state.providerOverrides as any).openai.baseUrl).toBe("http://127.0.0.1:1234/v1");
    setProviderOverride(s, list, "openai", { baseUrl: "", models: [] });
    expect(s.state.providerOverrides).toEqual({ openai: { extra: 1 }, autre: { models: ["m"] } });
  });

  it("refuse une adresse sans http(s), avec identifiants, ou illisible ; des modèles qui n'en sont pas", () => {
    const s = fakeSettings();
    for (const bad of ["ftp://x", "javascript:alert(1)", "http://u:p@h/v1", "pas une adresse", 5]) expect(() => setProviderOverride(s, list, "openai", { baseUrl: bad })).toThrow(ConfigError);
    expect(() => setProviderOverride(s, list, "openai", { models: "gpt" })).toThrow(ConfigError);
    expect(() => setProviderOverride(s, list, "openai", { models: [1] })).toThrow(ConfigError);
    expect(() => setProviderOverride(s, list, "openai", { models: ["x".repeat(201)] })).toThrow(ConfigError);
    expect(s.state.providerOverrides).toEqual({});
  });

  it("l'adresse refusée ne cite pas les identifiants qu'elle contenait", () => {
    let message = "";
    try {
      setProviderOverride(fakeSettings(), list, "openai", { baseUrl: `http://user:${KEY}@h/v1` });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/identifiants/);
    expect(message).not.toContain("CANARI");
  });
});

describe("providerRows", () => {
  it("dit d'où vient la clé : coffre (modifiable) ou variable d'environnement (nom donné, jamais la valeur) ; le coffre passe devant", () => {
    const rows = [
      { ...list[0]!, hasKey: true },
      { id: "anthropic", name: "Anthropic", baseUrl: "https://a", models: [], hasKey: true, configured: true },
      { id: "mistral", name: "Mistral", baseUrl: "https://m", models: [], hasKey: false, configured: false },
    ];
    const out = providerRows(rows, "", "", { vault: ["provider:anthropic:apiKey"], env: { "provider:openai:apiKey": "OPENAI_API_KEY", "provider:anthropic:apiKey": "ANTHROPIC_API_KEY" } }).providers;
    expect(out[0]).toMatchObject({ id: "openai", key_source: "env", env_var: "OPENAI_API_KEY" });
    expect(out[1]).toMatchObject({ id: "anthropic", key_source: "vault", env_var: null });
    expect(out[2]).toMatchObject({ id: "mistral", key_source: null, env_var: null });
    // Sans information de source (faux noyau) : une clé est présumée du coffre.
    expect(providerRows(rows, "", "").providers[0]).toMatchObject({ key_source: "vault", env_var: null });
  });

  it("décrit chaque fournisseur sans jamais porter de clé, et marque l'actif", () => {
    const rows = providerRows(list, "ollama", "qwen");
    expect(rows.active).toEqual({ provider: "ollama", model: "qwen" });
    expect(rows.providers[0]).toMatchObject({ id: "openai", has_key: false, extra_keys: 0, local: false, active: false, key_url: "https://platform.openai.com/api-keys", models: ["gpt-x"] });
    expect(rows.providers[1]).toMatchObject({ id: "ollama", local: true, active: true, configured: true, key_url: null });
  });
});

describe("testProvider", () => {
  it("dit ce qui manque sans interroger le serveur, et rend le nombre de modèles quand il répond", async () => {
    const never = { list: () => list, setExtraKeys: () => {}, client: () => { throw new Error("ne doit pas être appelé"); } };
    expect(await testProvider(never, "openai")).toMatchObject({ ok: false, error: expect.stringContaining("Aucune clé") });
    const ok = { list: () => [{ ...list[0]!, configured: true }], setExtraKeys: () => {}, client: () => ({ listModels: async () => ["a", "b"] }) };
    expect(await testProvider(ok, "openai")).toEqual({ ok: true, models: 2 });
    await expect(testProvider(ok, "inconnu")).rejects.toThrow(ConfigError);
  });

  it("une erreur du serveur est dite sans clé et coupée ; un serveur muet est coupé par le délai", async () => {
    const leaking = { list: () => [{ ...list[0]!, configured: true }], setExtraKeys: () => {}, client: () => ({ listModels: async () => { throw new Error(`401 Authorization: Bearer ${KEY} ${"x".repeat(1000)}`); } }) };
    const r = await testProvider(leaking, "openai");
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("CANARI");
    expect(r.error!.length).toBeLessThanOrEqual(300);
    const mute = { list: () => [{ ...list[0]!, configured: true }], setExtraKeys: () => {}, client: () => ({ listModels: () => new Promise<string[]>(() => {}) }) };
    expect(await testProvider(mute, "openai", 30)).toMatchObject({ ok: false, error: expect.stringContaining("Pas de réponse") });
  });
});

// --- le vrai noyau, par HTTP ------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-prov-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root, ...extraEnv } });
  const gw = createGateway({ core, version: "test" });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "x-hermes-session-token": gw.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  return { core, call, port, token: gw.token };
}

describe("passerelle réelle", () => {
  it("liste le catalogue ; l'enregistrement d'une clé change has_key/configured et la clé ne ressort dans aucune réponse", async () => {
    const { call } = await rig();
    const before = await call("GET", "/api/jarod/providers");
    expect(before.status).toBe(200);
    const openai = before.json.providers.find((p: any) => p.id === "openai");
    expect(openai).toMatchObject({ has_key: false, configured: false });
    expect(before.json.providers.length).toBeGreaterThan(5);

    const put = await call("PUT", "/api/jarod/providers/openai/key", { key: KEY });
    expect(put.status).toBe(200);
    expect(put.json.providers.find((p: any) => p.id === "openai")).toMatchObject({ has_key: true, configured: true });
    expect(put.text).not.toContain("CANARI");
    expect((await call("GET", "/api/jarod/providers")).text).not.toContain("CANARI");

    const del = await call("DELETE", "/api/jarod/providers/openai/key");
    expect(del.json.providers.find((p: any) => p.id === "openai")).toMatchObject({ has_key: false, configured: false });
  });

  it("une clé fournie par l'environnement est dite telle ; la saisir au coffre prend le relais ; la retirer rend l'environnement", async () => {
    const { call } = await rig({ OPENAI_API_KEY: KEY });
    const openai = (r: { json: any }) => r.json.providers.find((p: any) => p.id === "openai");
    const first = await call("GET", "/api/jarod/providers");
    expect(openai(first)).toMatchObject({ has_key: true, key_source: "env", env_var: "OPENAI_API_KEY" });
    expect(first.text).not.toContain("CANARI");
    expect(openai(await call("PUT", "/api/jarod/providers/openai/key", { key: OTHER }))).toMatchObject({ key_source: "vault", env_var: null });
    expect(openai(await call("DELETE", "/api/jarod/providers/openai/key"))).toMatchObject({ has_key: true, key_source: "env", env_var: "OPENAI_API_KEY" });
  });

  it("un fournisseur SANS variable d'environnement (Nous, z.ai…) est vu comme configuré dès que sa clé est au coffre", async () => {
    // Le CLI ne listait que les clés des fournisseurs de ENV_KEYS : une clé de Nous restait invisible, donc absente du sélecteur de modèles.
    const { call } = await rig();
    const put = await call("PUT", "/api/jarod/providers/nous/key", { key: KEY });
    expect(put.json.providers.find((p: any) => p.id === "nous")).toMatchObject({ has_key: true, configured: true });
    expect(put.text).not.toContain("CANARI");
  });

  it("une clé invalide ou un fournisseur inconnu → 400, sans écho de la clé, et rien d'enregistré", async () => {
    const { call, core } = await rig();
    const bad = await call("PUT", "/api/jarod/providers/openai/key", { key: `${KEY} oups` });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("CANARI");
    expect((await call("PUT", "/api/jarod/providers/nimporte/key", { key: KEY })).status).toBe(400);
    expect((await call("POST", "/api/jarod/providers/nimporte/test")).status).toBe(400);
    expect(core.settings.secretKeys()).toEqual([]);
  });

  it("sans jeton, 401 ; clés supplémentaires comptées ; adresse et modèles posés puis effacés", async () => {
    const { call, port } = await rig();
    const anon = await fetch(`http://127.0.0.1:${port}/api/jarod/providers`);
    expect(anon.status).toBe(401);

    const extra = await call("PUT", "/api/jarod/providers/openai/extra-keys", { keys: [KEY, OTHER] });
    expect(extra.status).toBe(200);
    expect(extra.json.providers.find((p: any) => p.id === "openai").extra_keys).toBe(2);
    expect(extra.text).not.toContain("CANARI");

    const set = await call("PUT", "/api/jarod/providers/custom", { baseUrl: "http://127.0.0.1:9/v1", models: ["m1", "m2"] });
    expect(set.json.providers.find((p: any) => p.id === "custom")).toMatchObject({ base_url: "http://127.0.0.1:9/v1", models: ["m1", "m2"] });
    const reset = await call("PUT", "/api/jarod/providers/custom", { baseUrl: "", models: [] });
    expect(reset.json.providers.find((p: any) => p.id === "custom").base_url).not.toBe("http://127.0.0.1:9/v1");
    expect((await call("PUT", "/api/jarod/providers/custom", { baseUrl: "http://u:p@h/v1" })).status).toBe(400);
  });

  describe("test avec un faux serveur", () => {
    let fake: Server | null = null;
    afterEach(() => fake?.close());
    it("envoie la clé enregistrée au serveur (en-tête), compte les modèles, et rend l'échec sans la clé", async () => {
      const seen: string[] = [];
      let status = 200;
      fake = createServer((req, res) => {
        seen.push(String(req.headers.authorization));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 200 ? JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }) : JSON.stringify({ error: `bad key ${KEY}` }));
      });
      await new Promise<void>((ok) => fake!.listen(0, ok));
      const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
      const { call } = await rig();
      await call("PUT", "/api/jarod/providers/openai", { baseUrl: base });
      expect((await call("POST", "/api/jarod/providers/openai/test")).json).toMatchObject({ ok: false, error: expect.stringContaining("Aucune clé") });

      await call("PUT", "/api/jarod/providers/openai/key", { key: KEY });
      const good = await call("POST", "/api/jarod/providers/openai/test");
      expect(good.json).toEqual({ ok: true, models: 3 });
      expect(seen).toEqual([`Bearer ${KEY}`]);

      status = 401;
      const refused = await call("POST", "/api/jarod/providers/openai/test");
      expect(refused.json.ok).toBe(false);
      expect(refused.text).not.toContain("CANARI");
    });
  });
});
