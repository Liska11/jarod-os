// L'essai guidé sur page neutre, contre une FAUSSE extension : la lecture n'a lieu qu'après un « oui » de l'utilisateur, sur l'hôte d'essai seulement.
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { runTrial, TRIAL_HOST, TRIAL_PAGE } from "../../src/impl/firefox-trial.js";
import { FakeExtension } from "./fake-extension.js";

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const u = new URL(url);
    request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "GET", headers: { host: u.host } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    })
      .on("error", () => resolve({ status: 0, body: "" }))
      .end();
  });
}

async function start(ask: (s: string) => Promise<boolean>, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const done = runTrial({ out: (l) => lines.push(l), ask: (s) => (asked.push(s), ask(s)), pollMs: 20, ...over });
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(pred()).toBe(true);
  };
  await until(() => lines.some((l) => l.startsWith("Canal ouvert")));
  const pageUrl = /http:\/\/[^\s]+/.exec(lines[0]!)![0];
  const code = /jarod1\.\d+\.[0-9a-f]{64}/.exec(lines.join("\n"))![0];
  const port = Number(code.split(".")[1]);
  const { ext } = await FakeExtension.open(port, code);
  ext!.startPolling();
  const select = async (origin: string, tab = 3) => {
    await ext!.send({ type: "select", id: randomUUID(), tabId: tab, docId: randomUUID(), origin, url: `${origin}/` });
  };
  return { done, lines, asked, ext: ext!, select, pageUrl, until };
}

describe("essai guidé sur page neutre", () => {
  it("la page d'essai est neutre : un titre, l'élément convenu, un leurre ; rien de personnel", async () => {
    const t = await start(async () => false, { timeoutMs: 400 });
    const r = await get(t.pageUrl);

    expect(r.status).toBe(200);
    expect(r.body).toBe(TRIAL_PAGE);
    expect(r.body).toContain('id="sujet"');
    expect((await get(`${t.pageUrl}autre`)).status).toBe(404);
    expect(t.pageUrl).toContain(`${TRIAL_HOST}:`);
    t.ext.stop();
    await t.done;
  });

  it("geste + « oui » : l'élément convenu est lu et affiché localement ; l'essai se ferme (page et canal)", async () => {
    const t = await start(async () => true);
    await t.select(`http://${TRIAL_HOST}:5555`);
    const cmd = await t.ext.next("read");

    expect(cmd).toMatchObject({ selector: "#sujet", origin: `http://${TRIAL_HOST}:5555` });
    await t.ext.send({ type: "result", id: cmd!.id, ticket: cmd!.ticket, ok: true, title: "Page d'essai", text: "TEXTE-CONVENU" });
    const res = await t.done;

    expect(res.read).toMatchObject({ host: TRIAL_HOST, title: "Page d'essai", text: "TEXTE-CONVENU" });
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0]).toContain("#sujet");
    expect(t.lines.join("\n")).toContain("TEXTE-CONVENU");
    expect(JSON.stringify(res.audits)).not.toContain("TEXTE-CONVENU"); // l'audit ne porte jamais le contenu
    expect((await get(t.pageUrl).catch(() => ({ status: 0, body: "" }))).status).toBe(0); // la page est fermée
    t.ext.stop();
  });

  it("« non » : rien n'est demandé à l'extension, rien n'est lu, et la question n'est pas reposée sur le même geste", async () => {
    const t = await start(async () => false, { timeoutMs: 1500 });
    await t.select(`http://${TRIAL_HOST}:5555`);
    await new Promise((r) => setTimeout(r, 700));

    expect(t.ext.messages.some((m) => m.type === "read")).toBe(false);
    expect(t.asked).toHaveLength(1);
    const res = await t.done;

    expect(res.read).toBeNull();
    expect(res.audits.some((a) => !a.ok)).toBe(true);
    t.ext.stop();
  });

  it("un onglet hors de la page d'essai (autre domaine) : refusé AVANT toute question, rien n'est lu", async () => {
    const t = await start(async () => true, { timeoutMs: 1200 });
    await t.select("http://exemple.org");
    await new Promise((r) => setTimeout(r, 600));

    expect(t.asked).toHaveLength(0);
    expect(t.ext.messages.some((m) => m.type === "read")).toBe(false);
    const res = await t.done;

    expect(res.read).toBeNull();
    expect(t.lines.join("\n")).toMatch(/domaine hors de la politique/);
    t.ext.stop();
  });

  it("sans geste avant le délai : l'essai se termine proprement, sans lecture", async () => {
    const t = await start(async () => true, { timeoutMs: 300 });
    const res = await t.done;

    expect(res.read).toBeNull();
    expect(res.reason).toMatch(/délai/);
    t.ext.stop();
  });
});
