// E2 / Firefox — la VRAIE extension (jarod-core/sidecars/firefox-reader) dans un VRAI Firefox de test (ESR séparé, profil neuf créé par geckodriver, rien à voir
// avec le Firefox de l'utilisateur), avec des onglets leurres. Le geste de l'utilisateur est simulé sur le bouton de l'extension depuis l'interface du Firefox de test.
// Aucun contenu n'est envoyé à un modèle : l'affichage est local.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BrowserPolicy, FirefoxReader, ReaderChannel, type ReaderApprovalRequest, type ReaderAuditEntry, type ReaderDisplay } from "../../src/index.js";
import { startTestSite, startWitness, type TestSite, type Witness } from "./browser_site.js";
import { FirefoxTest, hasFirefoxTest } from "./firefox_driver.js";
import { ROOT } from "./helpers.js";

const HAS = hasFirefoxTest(ROOT) && existsSync(join(ROOT, "jarod-core", "sidecars", "firefox-reader", "manifest.json"));
if (!HAS) console.warn("[moteurs] Firefox de test absent : essais de l'extension ignorés (voir engines.lock/README.md, engines/firefox-test)");
const POLICY: BrowserPolicy = { allowDomains: ["localhost"] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS)("E2 / Firefox — extension réelle, Firefox de test, onglets leurres", () => {
  let site: TestSite;
  let witness: Witness;
  let ff: FirefoxTest;
  let channel: ReaderChannel;
  let reader: FirefoxReader;
  let decide: (r: ReaderApprovalRequest) => Promise<boolean> = async () => true;
  const displays: ReaderDisplay[] = [];
  const audits: ReaderAuditEntry[] = [];
  const asked: ReaderApprovalRequest[] = [];
  const fromExt: Record<string, unknown>[] = [];
  const toExt: Record<string, unknown>[] = [];
  const tabs: Record<string, string> = {};
  const selects = () => fromExt.filter((m) => m.type === "select").length;
  const reads = () => toExt.filter((m) => m.type === "read").length;

  /** Ouvre un onglet leurre ou cible et note son nom. */
  async function tab(name: string, url: string): Promise<string> {
    const h = await ff.newTab(url);
    tabs[name] = h;
    return h;
  }

  /** Le geste de l'utilisateur : on met l'onglet au premier plan, puis on clique sur le bouton de l'extension. Vrai si JAROD-OS a reçu la sélection. */
  async function gesture(handle: string, ms = 6000): Promise<boolean> {
    const n = selects();
    await ff.select(handle);
    await ff.clickAction();
    const end = Date.now() + ms;
    while (selects() === n && Date.now() < end) await wait(50);
    await wait(80);
    return selects() > n;
  }

  beforeAll(async () => {
    witness = await startWitness();
    site = await startTestSite(witness.port);
    ff = await FirefoxTest.start(ROOT);
    channel = new ReaderChannel({ pollMs: 5000, idleMs: 20_000 });
    const { pairingCode } = await channel.start();
    reader = new FirefoxReader({ channel, policy: POLICY, approve: async (r) => (asked.push(r), decide(r)), display: (d) => displays.push(d), audit: (e) => audits.push(e), approvalTimeoutMs: 15_000, readTtlMs: 10_000, perMinute: 200 });
    // on écoute ce que l'extension envoie et ce qu'on lui envoie (pour prouver ce qui n'a PAS été envoyé)
    const c = channel as unknown as { onMessage: (m: Record<string, unknown>) => void };
    const orig = c.onMessage.bind(channel);
    c.onMessage = (m) => (fromExt.push(m), orig(m));
    const send = channel.send.bind(channel);
    channel.send = (m) => (toExt.push(m), send(m));
    await ff.installAddon(join(ROOT, "jarod-core", "sidecars", "firefox-reader"));
    const uuid = (JSON.parse(await ff.chrome<string>(`return JSON.stringify({ u: WebExtensionPolicy.getByID("jarod-reader@jarod.os").mozExtensionHostname })`)) as { u: string }).u;
    await ff.newTab(`moz-extension://${uuid}/options.html`);
    const [, port, key] = /^jarod1\.(\d+)\.([0-9a-f]{64})$/.exec(pairingCode)!;
    await ff.pageAsync(`const done = arguments[arguments.length - 1]; browser.storage.local.set({ pairing: { port: ${port}, key: "${key}" } }).then(() => done("ok"))`);
    // les onglets leurres : un autre site permis, un domaine interdit par mot d'hôte, un hôte hors liste, une page de formulaire
    await tab("leurre-permis", site.url("localhost", "/second"));
    await tab("leurre-interdit", site.url("checkout.localhost", "/"));
    await tab("leurre-hors-liste", site.url("127.0.0.1", "/second"));
    await tab("leurre-formulaire", site.url("localhost", "/"));
  }, 180_000);

  afterAll(async () => {
    await reader?.stop().catch(() => undefined);
    await ff?.quit();
    await site?.close();
    await witness?.close();
  }, 60_000);

  const everything = () => JSON.stringify({ fromExt, toExt, audits, asked });

  it("la vraie extension est chargée avec EXACTEMENT les permissions annoncées", async () => {
    const perms = JSON.parse(await ff.chrome<string>(`const p = WebExtensionPolicy.getByID("jarod-reader@jarod.os"); return JSON.stringify({ perms: p.permissions, origins: Array.from(p.allowedOrigins.patterns, (x) => x.pattern), csp: !!p.extension.manifest.content_security_policy })`)) as { perms: string[]; origins: string[] };
    expect([...perms.perms].sort()).toEqual(["activeTab", "scripting", "storage"]);
    // aucune permission d'hôte (pas de <all_urls>) : le seul motif est celui des pages de l'extension elle-même
    expect(perms.origins.filter((o) => !o.startsWith("moz-extension://"))).toEqual([]);
  });

  it("SANS GESTE : aucune lecture possible, rien n'est demandé, l'extension n'a même pas ouvert le canal", async () => {
    await expect(reader.readElement("#titre")).rejects.toThrow(/aucune cible/);
    expect(asked).toHaveLength(0);
    expect(toExt).toHaveLength(0);
    expect(fromExt).toHaveLength(0);
    expect(channel.connected).toBe(false);
  });

  it("PAGES NON PRISES EN CHARGE (interne, extension) : le geste ne produit aucune sélection", async () => {
    const blank = await tab("vide", "about:blank");
    expect(await gesture(blank, 2500)).toBe(false);
    expect(reader.selection()).toBeNull();
    await ff.select(blank);
    await ff.close();
    await ff.select(tabs["leurre-permis"]!);
  });

  it("REFUS D'ACCORD : le geste est fait, la demande nomme Firefox, l'origine, le chemin et l'élément ; refusée, rien n'est commandé ni lu", async () => {
    const target = await tab("cible", site.url("localhost", "/readable"));
    expect(await gesture(target)).toBe(true);
    expect(reader.selection()).toMatchObject({ origin: site.url("localhost", "").replace(/\/$/, ""), url: site.url("localhost", "/readable") });
    decide = async () => false;
    const before = asked.length;
    await expect(reader.readElement("#note")).rejects.toThrow(/non accordée/);
    expect(asked.length).toBe(before + 1);
    expect(asked.at(-1)).toMatchObject({ browser: "Firefox", host: "localhost", url: site.url("localhost", "/readable"), params: { selector: "#note" } });
    await wait(300);
    expect(reads()).toBe(0);
    expect(displays).toHaveLength(0);
    decide = async () => true;
  });

  it("DOMAINE INTERDIT et HÔTE HORS LISTE : le geste est reçu, mais la lecture est refusée AVANT l'accord ; la politique n'est pas touchée", async () => {
    const askedBefore = asked.length;
    for (const name of ["leurre-interdit", "leurre-hors-liste"]) {
      expect(await gesture(tabs[name]!)).toBe(true);
      await expect(reader.readElement("h1")).rejects.toThrow(/politique/);
    }
    expect(asked.length).toBe(askedBefore);
    expect(reads()).toBe(0);
    expect(POLICY).toEqual({ allowDomains: ["localhost"] });
    expect(displays).toHaveLength(0);
  });

  it("LECTURE DE L'ÉLÉMENT EXACT : titre et texte de #note, rien d'autre ; l'affichage est local, le journal sans contenu", async () => {
    expect(await gesture(tabs["cible"]!)).toBe(true);
    await expect(reader.readElement("#note")).resolves.toBeUndefined();
    expect(displays).toEqual([{ host: "localhost", url: site.url("localhost", "/readable"), title: "/readable", text: "NOTE-CONVENUE" }]);
    expect(audits.at(-1)).toEqual({ op: "read_element", host: "localhost", ok: true });
    const read = toExt.filter((m) => m.type === "read").at(-1)!;
    expect(read).toMatchObject({ selector: "#note", origin: site.url("localhost", "").replace(/\/$/, "") });
    // ce que l'extension a envoyé : sélection sans contenu, puis UN résultat ; rien de la page voisine ni des autres onglets
    expect(Object.keys(fromExt.filter((m) => m.type === "select").at(-1)!).sort()).toEqual(["docId", "id", "origin", "tabId", "type", "url"]);
    for (const needle of ["AUTRE-ZONE-NON-DEMANDEE", "DANS-UN-FORMULAIRE", "VALEUR-DU-CHAMP", "TEXTE-EDITABLE", "SECOND-PAGE", "valeur-fabriquee-du-champ"]) {
      expect(everything(), needle).not.toContain(needle);
      expect(JSON.stringify(displays), needle).not.toContain(needle);
    }
    expect(JSON.stringify(audits)).not.toContain("NOTE-CONVENUE");
  });

  it("USAGE UNIQUE : après la lecture, il faut un nouveau geste", async () => {
    await expect(reader.readElement("#note")).rejects.toThrow(/aucune cible/);
  });

  it("ÉLÉMENTS DE FORMULAIRE, ÉDITABLES, BOUTONS, CHAMPS, ÉLÉMENT ABSENT : refusés par l'extension dans la page, rien n'est lu", async () => {
    for (const [selector, why] of [["#pw", /formulaire/], ["#inner", /formulaire/], ["#infoform", /formulaire/], ["#avecchamp", /formulaire/], ["#editable", /formulaire/], ["#bouton", /formulaire/], ["#zone", /formulaire/], ["#absent", /absent/]] as const) {
      expect(await gesture(tabs["cible"]!), selector).toBe(true);
      await expect(reader.readElement(selector), selector).rejects.toThrow(why);
    }
    expect(displays).toHaveLength(1); // seule la lecture de #note a abouti
    for (const needle of ["VALEUR-DU-CHAMP", "DANS-UN-FORMULAIRE", "TEXTE-EDITABLE", "ZONE-DE-SAISIE", "valeur-fabriquee-du-champ"]) expect(everything(), needle).not.toContain(needle);
  });

  it("DOCUMENT PRINCIPAL SEULEMENT : le contenu d'un cadre n'est jamais lu", async () => {
    const framed = await tab("cadres", site.url("localhost", "/frames"));
    expect(await gesture(framed)).toBe(true);
    await expect(reader.readElement("p")).rejects.toThrow(/absent/); // le <p> est dans le cadre (/second), pas dans le document principal
    expect(await gesture(framed)).toBe(true);
    await reader.readElement("#cadre-parent");
    expect(displays.at(-1)).toMatchObject({ text: "Page à cadre" });
    expect(everything()).not.toContain("SECOND-PAGE");
    await ff.select(framed);
    await ff.close();
  });

  it("NAVIGATION PENDANT L'ATTENTE DE L'ACCORD : rien n'est lu, même si l'accord est ensuite donné", async () => {
    expect(await gesture(tabs["cible"]!)).toBe(true);
    const readsBefore = reads();
    decide = async () => {
      await ff.select(tabs["cible"]!);
      await ff.navigate(site.url("localhost", "/second"));
      await wait(500);
      return true;
    };
    await expect(reader.readElement("#note")).rejects.toThrow(/annulée|cible a changé|aucune cible/);
    expect(reads()).toBe(readsBefore);
    expect(displays.every((d) => d.text !== "SECOND-PAGE")).toBe(true);
    decide = async () => true;
    await ff.navigate(site.url("localhost", "/readable")); // on remet la page
  });

  it("RECHARGEMENT PENDANT L'ATTENTE : le document change, la lecture est annulée", async () => {
    expect(await gesture(tabs["cible"]!)).toBe(true);
    const readsBefore = reads();
    decide = async () => {
      await ff.select(tabs["cible"]!);
      await ff.cmd("POST", "/refresh", {});
      await wait(500);
      return true;
    };
    await expect(reader.readElement("#note")).rejects.toThrow(/annulée|cible a changé|aucune cible/);
    expect(reads()).toBe(readsBefore);
    decide = async () => true;
  });

  it("FERMETURE DE L'ONGLET PENDANT L'ATTENTE : la lecture est annulée", async () => {
    const temp = await tab("jetable", site.url("localhost", "/readable"));
    expect(await gesture(temp)).toBe(true);
    const readsBefore = reads();
    decide = async () => {
      await ff.select(temp);
      await ff.close();
      await ff.select(tabs["leurre-permis"]!);
      await wait(500);
      return true;
    };
    await expect(reader.readElement("#note")).rejects.toThrow(/annulée|cible a changé|aucune cible/);
    expect(reads()).toBe(readsBefore);
    decide = async () => true;
  });

  it("LECTURE FORGÉE APRÈS NAVIGATION : même si JAROD-OS (ou un tiers) envoyait une commande de lecture, l'extension revérifie et ne rend aucun contenu", async () => {
    expect(await gesture(tabs["cible"]!)).toBe(true);
    const sel = fromExt.filter((m) => m.type === "select").at(-1)!;
    await ff.select(tabs["cible"]!);
    await ff.navigate(site.url("localhost", "/second"));
    await wait(700);
    const before = fromExt.length;
    channel.send({ type: "read", id: sel.id, tabId: sel.tabId, docId: sel.docId, origin: sel.origin, selector: "h1", expiresAt: Date.now() + 5000, ticket: "t".repeat(32) });
    await wait(1200);
    const answers = fromExt.slice(before).filter((m) => m.type === "result");
    for (const a of answers) {
      expect(a.ok).toBe(false);
      expect(a.title).toBeUndefined();
      expect(a.text).toBeUndefined();
    }
    expect(JSON.stringify(fromExt.slice(before))).not.toContain("Seconde page");
    await ff.navigate(site.url("localhost", "/readable"));
  });

  it("AUTRES ONGLETS INTACTS : aucun n'a été sélectionné, lu, fermé, navigué ni modifié ; seuls les onglets du geste ont été proposés", async () => {
    const handles = await ff.windows();
    for (const name of ["leurre-permis", "leurre-interdit", "leurre-hors-liste", "leurre-formulaire", "cible"]) expect(handles, name).toContain(tabs[name]);
    const texts: Record<string, string> = {};
    for (const name of ["leurre-permis", "leurre-hors-liste", "leurre-formulaire"]) {
      await ff.select(tabs[name]!);
      texts[name] = await ff.page<string>("return location.href + '|' + document.title + '|' + document.body.innerText.slice(0, 60)");
    }
    expect(texts["leurre-permis"]).toContain("SECOND-PAGE");
    expect(texts["leurre-hors-liste"]).toContain("SECOND-PAGE");
    expect(texts["leurre-formulaire"]).toContain("Page d'essai");
    // jamais d'énumération : seuls des types de message fermés sont partis de l'extension
    expect(new Set(fromExt.map((m) => m.type))).toEqual(new Set(["select", "invalidate", "result"]));
    // l'onglet interdit et l'onglet hors liste n'ont jamais reçu de commande de lecture
    expect(toExt.filter((m) => m.type === "read").every((m) => m.origin === site.url("localhost", "").replace(/\/$/, ""))).toBe(true);
    // aucun contenu des leurres dans ce qui a circulé
    for (const needle of ["SECOND-PAGE", "Page d'essai", "valeur-fabriquee-du-champ", "valeur-fabriquee-du-cookie"]) expect(everything(), needle).not.toContain(needle);
  });

  it("DÉCONNEXION : le canal est fermé, le navigateur, ses onglets et l'extension restent intacts ; un nouveau clic ne produit plus rien", async () => {
    const handles = await ff.windows();
    await reader.stop();
    expect(channel.connected).toBe(false);
    expect(await ff.windows()).toEqual(handles); // aucun onglet fermé
    const alive = await ff.chrome<string>(`return JSON.stringify({ ext: !!WebExtensionPolicy.getByID("jarod-reader@jarod.os"), windows: Services.wm.getMostRecentWindow("navigator:browser") !== null })`);
    expect(JSON.parse(alive)).toEqual({ ext: true, windows: true });
    const n = selects();
    await ff.select(tabs["cible"]!);
    await ff.clickAction();
    await wait(1500);
    expect(selects()).toBe(n);
    await ff.select(tabs["leurre-permis"]!);
    expect(await ff.page<string>("return document.body.innerText")).toContain("SECOND-PAGE");
  });
});
