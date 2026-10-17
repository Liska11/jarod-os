import { describe, expect, it } from "vitest";
import { AdapterRefused, AdapterUnavailable, type BrowserAuditEntry, type BrowserBackend, ConnectedBrowser, type TabRef } from "../src/index.js";

const tabs: TabRef[] = [
  { id: "t1", url: "https://docs.exemple.org/guide?token=abc#x", title: "Guide" },
  { id: "t2", url: "https://mail.google.com/mail/u/0/", title: "Boîte" },
  { id: "t3", url: "https://www.mabanque.fr/compte", title: "Compte" },
  { id: "t4", url: "https://autre.net/", title: "Autre" },
];

function fake() {
  const log: string[] = [];
  const b: BrowserBackend = {
    engine: "browser-harness",
    listTabs: async () => tabs,
    readPage: async (t) => (log.push(`read ${t}`), { text: "contenu", passwordFields: 0 }),
    navigate: async (t, u) => void log.push(`nav ${t} ${u}`),
    click: async (t, s) => void log.push(`click ${t} ${s}`),
    typeText: async (t, s, x) => void log.push(`type ${t} ${s} ${x}`),
    pressKey: async (t, k) => void log.push(`key ${t} ${k}`),
    isPasswordField: async (_t, s) => s === "#pwd",
  };
  return { b, log };
}

function browser(over: Partial<ConstructorParameters<typeof ConnectedBrowser>[0]> = {}) {
  const f = fake();
  const audit: BrowserAuditEntry[] = [];
  const asked: string[] = [];
  const c = new ConnectedBrowser({
    backend: f.b,
    policy: { allowDomains: ["exemple.org", "mail.google.com", "mabanque.fr"] },
    approve: async (op, summary) => (asked.push(`${op}: ${summary}`), true),
    audit: (e) => audit.push(e),
    ...over,
  });
  return { c, audit, asked, ...f };
}

describe("E2 — navigateur connecté : un accord par action, un journal", () => {
  it("sans moteur : indisponible", async () => {
    await expect(new ConnectedBrowser({ policy: { allowDomains: ["exemple.org"] }, approve: async () => true }).listTabs()).rejects.toThrow(AdapterUnavailable);
  });

  it("sans accord branché, ou accord refusé : rien n'est lancé, même une lecture", async () => {
    const none = browser({ approve: undefined });
    await expect(none.c.readPage("t1")).rejects.toThrow(/non accordée/);
    const no = browser({ approve: async () => false });
    await expect(no.c.click("t1", "#ok")).rejects.toThrow(/non accordée/);
    expect(none.log).toEqual([]);
    expect(no.log).toEqual([]);
  });

  it("chaque opération demande l'accord, lecture comprise", async () => {
    const { c, asked } = browser();
    await c.listTabs();
    await c.readPage("t1");
    await c.navigate("t1", "https://docs.exemple.org/autre");
    await c.click("t1", "#ok");
    await c.typeText("t1", "#q", "bonjour");
    await c.pressKey("t1", "Enter");
    expect(asked.map((a) => a.split(":")[0])).toEqual(["list_tabs", "read_page", "navigate", "click", "type_text", "press_key"]);
  });

  it("les onglets hors liste blanche ou en liste noire ne sont ni listés ni touchés (la liste noire l'emporte)", async () => {
    const { c, log } = browser();
    const seen = await c.listTabs();
    expect(seen.map((t) => t.id)).toEqual(["t1"]);
    for (const id of ["t2", "t3", "t4"]) await expect(c.readPage(id)).rejects.toThrow(AdapterRefused);
    expect(log).toEqual([]);
  });

  it("l'adresse rendue n'a ni requête ni fragment", async () => {
    const [t] = await browser().c.listTabs();
    expect(t!.url).toBe("https://docs.exemple.org/guide");
  });

  it("liste blanche vide : rien n'est permis", async () => {
    const { c } = browser({ policy: { allowDomains: [] } });
    expect(await c.listTabs()).toEqual([]);
    await expect(c.readPage("t1")).rejects.toThrow(/politique/);
  });

  it("navigation : schémas, identifiants dans l'adresse et domaines de destination refusés", async () => {
    const { c, log } = browser();
    for (const u of ["file:///C:/x", "javascript:alert(1)", "https://u:p@docs.exemple.org/", "https://autre.net/", "https://mail.google.com/", "pas une url"]) {
      await expect(c.navigate("t1", u)).rejects.toThrow(AdapterRefused);
    }
    expect(log).toEqual([]);
  });

  it("un champ de mot de passe n'est jamais cliqué ni rempli", async () => {
    const { c, log } = browser();
    await expect(c.click("t1", "#pwd")).rejects.toThrow(/mot de passe/);
    await expect(c.typeText("t1", "#pwd", "x")).rejects.toThrow(/mot de passe/);
    expect(log).toEqual([]);
  });

  it("texte trop long, caractères de contrôle, touche hors liste, débit : refusés", async () => {
    const { c, log } = browser({ policy: { allowDomains: ["exemple.org"], maxTextLength: 5, perMinute: 3 } });
    await expect(c.typeText("t1", "#q", "123456")).rejects.toThrow(/trop long/);
    await expect(c.typeText("t1", "#q", "a\u0007")).rejects.toThrow(/contrôle/);
    await expect(c.pressKey("t1", "F12")).rejects.toThrow(/non permise/);
    await expect(c.listTabs()).rejects.toThrow(/minute/);
    expect(log).toEqual([]);
  });

  it("le journal garde l'opération, l'hôte et le résultat — ni adresse complète, ni contenu, ni texte saisi", async () => {
    const { c, audit } = browser();
    await c.readPage("t1");
    await c.typeText("t1", "#q", "mot-secret-saisi").catch(() => undefined);
    await c.readPage("t2").catch(() => undefined);
    const dump = JSON.stringify(audit);
    expect(audit.length).toBe(3);
    expect(audit[0]).toEqual({ op: "read_page", host: "docs.exemple.org", ok: true });
    expect(audit[2]!.ok).toBe(false);
    expect(dump).not.toContain("token=abc");
    expect(dump).not.toContain("contenu");
    expect(dump).not.toContain("mot-secret-saisi");
  });

  it("aucune opération sur les cookies, le stockage ou le profil n'existe", () => {
    const names = Object.getOwnPropertyNames(ConnectedBrowser.prototype);
    expect(names.filter((n) => /cookie|storage|profile|export|evaluate|eval|script/i.test(n))).toEqual([]);
  });
});
