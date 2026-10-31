/**
 * L'action webhook : un POST JSON vers une adresse publique, rien d'autre.
 *  - l'adresse est contrôlée (schéma, identifiants, hôte public) ;
 *  - le service doit répondre 2xx, une redirection n'est pas suivie ;
 *  - une règle webhook ne se crée qu'avec une adresse valide, et la demande d'accord la montre.
 */
import { describe, expect, it } from "vitest";
import { AutomationService, automationTools, parseWebhookUrl, postWebhook, webhookTargets } from "../src/index.js";
import { makeCore, tempDir, testKeys } from "./helpers.js";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const reply = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

describe("parseWebhookUrl", () => {
  it("accepte http et https, refuse le reste", () => {
    expect(parseWebhookUrl("https://hooks.example.com/a/b?k=1").hostname).toBe("hooks.example.com");
    expect(() => parseWebhookUrl("ftp://example.com/x")).toThrow(/http/);
    expect(() => parseWebhookUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => parseWebhookUrl("pas une adresse")).toThrow(/n'est pas une adresse/);
    expect(() => parseWebhookUrl("https://user:secret@example.com/x")).toThrow(/identifiants/);
  });
});

describe("postWebhook", () => {
  it("envoie un POST JSON et rend la main sur un 2xx", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await postWebhook("https://hooks.example.com/in", { a: 1 }, { fetch: fetcher, lookup: PUBLIC });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://hooks.example.com/in");
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: '{"a":1}', redirect: "manual" });
    expect((seen[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("refuse la machine locale et les réseaux privés, avant tout envoi", async () => {
    let called = false;
    const fetcher = (async () => ((called = true), new Response(null, { status: 200 }))) as unknown as typeof fetch;
    await expect(postWebhook("http://127.0.0.1:8080/x", {}, { fetch: fetcher })).rejects.toThrow(/locale ou privée/);
    await expect(postWebhook("http://[::1]/x", {}, { fetch: fetcher })).rejects.toThrow(/locale ou privée/);
    await expect(postWebhook("https://interne.example/x", {}, { fetch: fetcher, lookup: async () => [{ address: "10.0.0.5", family: 4 }] })).rejects.toThrow(/locale ou privée/);
    expect(called).toBe(false);
  });

  it("une erreur du service ou une redirection est un échec dit, jamais un « ok »", async () => {
    await expect(postWebhook("https://hooks.example.com/in", {}, { fetch: reply(500), lookup: PUBLIC })).rejects.toThrow(/500/);
    await expect(postWebhook("https://hooks.example.com/in", {}, { fetch: reply(404), lookup: PUBLIC })).rejects.toThrow(/404/);
    await expect(postWebhook("https://hooks.example.com/in", {}, { fetch: reply(302), lookup: PUBLIC })).rejects.toThrow(/redirection/);
  });

  it("borne la taille du corps", async () => {
    await expect(postWebhook("https://hooks.example.com/in", { texte: "x".repeat(70 * 1024) }, { fetch: reply(200), lookup: PUBLIC })).rejects.toThrow(/Ko/);
  });
});

describe("l'action webhook dans une règle", () => {
  it("la règle envoie le corps écrit, ou à défaut son nom et l'heure", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const sent: { url: string; payload: unknown }[] = [];
    const service = new AutomationService({
      db: core.db,
      jobs: core.jobs,
      now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
      runAgent: async () => ({ sessionId: "s", ok: true, summary: "" }),
      postWebhook: async (url, payload) => void sent.push({ url, payload }),
      notify: () => {},
    });
    const withBody = service.create({ name: "avec", trigger: { kind: "manual" }, actions: [{ type: "webhook", url: "https://hooks.example.com/a", payload: { x: 1 } }] });
    const bare = service.create({ name: "sans", trigger: { kind: "manual" }, actions: [{ type: "webhook", url: "https://hooks.example.com/b" }] });
    await service.run(withBody.id);
    await service.run(bare.id);
    expect(sent[0]).toEqual({ url: "https://hooks.example.com/a", payload: { x: 1 } });
    expect(sent[1]!.url).toBe("https://hooks.example.com/b");
    expect(sent[1]!.payload).toMatchObject({ rule: "sans", ruleId: bare.id, firedAt: "2026-10-31T12:00:00.000Z" });
    await core.dispose();
  });

  it("sans envoi branché, l'action échoue en le disant", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const service = new AutomationService({ db: core.db, jobs: core.jobs, runAgent: async () => ({ sessionId: "s", ok: true, summary: "" }), notify: () => {} });
    const rule = service.create({ name: "w", trigger: { kind: "manual" }, actions: [{ type: "webhook", url: "https://hooks.example.com/a" }] });
    await service.run(rule.id);
    const [job] = core.jobs.list().filter((j) => j.kind === "automation");
    expect(job!.status).not.toBe("done");
    expect(job!.lastError).toContain("non disponible");
    await core.dispose();
  });
});

describe("automation_create avec un webhook", () => {
  const tool = (name: string) => {
    const service = {} as AutomationService;
    return automationTools(service).find((t) => t.name === name)!;
  };

  it("refuse une action webhook sans adresse valide", async () => {
    const create = tool("automation_create");
    const bad = await create.run({ name: "w", trigger: { kind: "manual" }, actions: [{ type: "webhook", url: "n'importe quoi" }] }, {} as never);
    expect(bad).toMatch(/^Erreur : action webhook/);
    const noUrl = await create.run({ name: "w", trigger: { kind: "manual" }, actions: [{ type: "webhook" }] }, {} as never);
    expect(noUrl).toMatch(/^Erreur : action webhook/);
  });

  it("la demande d'accord nomme la destination, sans la partie après « ? »", async () => {
    const create = tool("automation_create");
    const text = await create.precheck!({ name: "Prévenir Slack", actions: [{ type: "agent", prompt: "p" }, { type: "webhook", url: "https://hooks.slack.com/services/T0/B0/XXX?token=secret" }] }, {} as never);
    expect(text).toContain("https://hooks.slack.com/services/T0/B0/XXX");
    expect(text).not.toContain("secret");
    expect(await create.precheck!({ name: "n", actions: [{ type: "notify", title: "t" }] }, {} as never)).toBeUndefined();
  });

  it("webhookTargets ignore ce qui n'est pas un webhook", () => {
    expect(webhookTargets([{ type: "notify", title: "t" }])).toEqual([]);
    expect(webhookTargets(undefined)).toEqual([]);
  });
});
