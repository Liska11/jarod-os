// E2 / Firefox — le canal extension ↔ JAROD-OS et le courtier de lecture, contre une FAUSSE extension (requêtes HTTP écrites à la main).
// La vraie extension, dans un vrai Firefox de test, est essayée dans test/engines/firefox.reader.engine.test.ts.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserPolicy, FirefoxReader, type FirefoxReaderDeps, ReaderChannel, type ReaderApprovalRequest, type ReaderAuditEntry, type ReaderDisplay } from "../../src/index.js";
import { FakeExtension, post } from "./fake-extension.js";

const POLICY: BrowserPolicy = { allowDomains: ["localhost", "exemple.org"] };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function rig(over: Partial<FirefoxReaderDeps> = {}, channelOpts: ConstructorParameters<typeof ReaderChannel>[0] = {}) {
  const channel = new ReaderChannel({ pollMs: 300, idleMs: 700, ...channelOpts });
  const { port, pairingCode } = await channel.start();
  const displays: ReaderDisplay[] = [];
  const audits: ReaderAuditEntry[] = [];
  const asked: ReaderApprovalRequest[] = [];
  const reader = new FirefoxReader({
    channel,
    policy: POLICY,
    approve: async (r) => (asked.push(r), true),
    display: (r) => displays.push(r),
    audit: (e) => audits.push(e),
    approvalTimeoutMs: 400,
    readTtlMs: 600,
    ...over,
  });
  cleanups.push(() => reader.stop());
  const { status, ext } = await FakeExtension.open(port, pairingCode);
  expect(status).toBe(200);
  ext!.startPolling();
  cleanups.push(() => ext!.stop());
  const select = async (o: Record<string, unknown> = {}) => {
    const m = { type: "select", id: randomUUID(), tabId: 7, docId: randomUUID(), origin: "http://localhost:4000", url: "http://localhost:4000/page", ...o };
    await ext!.send(m);
    await new Promise((r) => setTimeout(r, 40));
    return m as { id: string; tabId: number; docId: string; origin: string; url: string };
  };
  return { channel, port, pairingCode, reader, ext: ext!, displays, audits, asked, select };
}

describe("canal : authentifié et borné", () => {
  it("clé d'appairage neuve à chaque ouverture, sur le bouclage seulement, fermée à la fin", async () => {
    const a = new ReaderChannel();
    const b = new ReaderChannel();
    const pa = await a.start();
    const pb = await b.start();
    expect(pa.pairingCode).toMatch(/^jarod1\.\d{2,5}\.[0-9a-f]{64}$/);
    expect(pa.pairingCode.split(".")[2]).not.toBe(pb.pairingCode.split(".")[2]);
    await a.close();
    await b.close();
    expect((await post(pa.port, "/hello", {})).status).toBe(0); // plus personne n'écoute
  });

  it("une PAGE WEB ne passe pas : Origin http/https, absente, « null », ou Host étranger — refusé sans même un en-tête CORS", async () => {
    const r = await rig({}, { idleMs: 5000 });
    for (const origin of ["https://evil.example", "http://localhost:4000", "null", "moz-extension-fake://x", null]) {
      expect((await post(r.port, "/hello", {}, { origin })).status, String(origin)).toBe(403);
    }
    expect((await post(r.port, "/hello", {}, { host: "evil.example" })).status).toBe(403);
    expect((await post(r.port, "/hello", {}, { host: `evil.example:${r.port}` })).status).toBe(403);
    // même un « simple request » de page (texte brut) n'atteint aucune logique
    expect((await post(r.port, "/msg", null, { origin: "https://evil.example", contentType: "text/plain", raw: '{"type":"select"}' })).status).toBe(403);
    expect(r.reader.selection()).toBeNull();
  });

  it("l'extension peut lire les réponses (CORS limité à SON origine) ; la pré-requête OPTIONS est acceptée", async () => {
    const r = await rig({}, { idleMs: 5000 });
    const origin = "moz-extension://11111111-2222-3333-4444-555555555555";
    expect((await post(r.port, "/msg", null, { method: "OPTIONS", origin, contentType: null, raw: "" })).status).toBe(204);
  });

  it("des chemins, méthodes et types inconnus sont refusés", async () => {
    const r = await rig({}, { idleMs: 5000 });
    expect((await post(r.port, "/autre", {})).status).toBe(404);
    expect((await post(r.port, "/msg", null, { method: "GET", contentType: null, raw: "" })).status).toBe(405);
    expect((await post(r.port, "/msg", null, { contentType: "text/plain", raw: "{}" })).status).toBe(415);
    expect((await post(r.port, "/msg", null, { raw: "pas du json", session: r.ext.session })).status).toBe(400);
    expect((await post(r.port, "/msg", null, { raw: "[1]", session: r.ext.session })).status).toBe(400);
  });

  it("UN SEUL client : une seconde ouverture est refusée tant que la session vit ; « bye » la libère", async () => {
    const r = await rig({}, { idleMs: 5000 });
    expect((await post(r.port, "/hello", {})).status).toBe(409);
    expect((await r.ext.bye()).status).toBe(200);
    const again = await FakeExtension.open(r.port, r.pairingCode);
    expect(again.status).toBe(200);
  });

  it("mauvaise preuve : refusée ; trois échecs : verrouillé, même avec la bonne clé ; le verrou tombe ensuite", async () => {
    const channel = new ReaderChannel({ lockMs: 400 });
    const { port, pairingCode } = await channel.start();
    cleanups.push(() => channel.close());
    for (let i = 0; i < 3; i++) {
      const hello = await post(port, "/hello", {});
      expect(hello.status).toBe(200);
      expect((await post(port, "/auth", { proof: "0".repeat(64) })).status).toBe(403);
    }
    expect((await post(port, "/hello", {})).status).toBe(429);
    await new Promise((r) => setTimeout(r, 450));
    expect((await FakeExtension.open(port, pairingCode)).status).toBe(200);
  });

  it("le défi ne sert qu'une fois et n'est pas rejouable ; une preuve mal formée est refusée", async () => {
    const channel = new ReaderChannel();
    const { port, pairingCode } = await channel.start();
    cleanups.push(() => channel.close());
    const { createHmac } = await import("node:crypto");
    const hello = await post(port, "/hello", {});
    const proof = createHmac("sha256", Buffer.from(pairingCode.split(".")[2]!, "hex")).update(String(hello.json!.nonce)).digest("hex");
    expect((await post(port, "/auth", { proof: "zz" })).status).toBe(403); // défi consommé par l'échec
    expect((await post(port, "/auth", { proof })).status).toBe(403); // la bonne preuve du défi consommé ne vaut plus
    expect((await post(port, "/hello", {})).status).toBe(200);
  });

  it("aucune commande sans jeton de session : /msg et /poll refusent (401) et comptent comme échec", async () => {
    const got: unknown[] = [];
    const channel = new ReaderChannel();
    channel.handlers({ message: (m) => got.push(m), closed: () => undefined });
    const { port } = await channel.start();
    cleanups.push(() => channel.close());
    expect((await post(port, "/msg", { type: "select" })).status).toBe(401);
    expect((await post(port, "/poll", {})).status).toBe(401);
    expect((await post(port, "/msg", { type: "select" }, { session: "0".repeat(32) })).status).toBe(401);
    expect(got).toEqual([]);
    expect((await post(port, "/hello", {})).status).toBe(429); // trois échecs ont verrouillé
  });

  it("corps trop grand : 413 ; message sans type : 400", async () => {
    const r = await rig({}, { maxMessage: 1000, idleMs: 5000 });
    expect((await r.ext.call("/msg", { type: "x", pad: "a".repeat(5000) })).status).toBe(413);
    expect((await r.ext.call("/msg", { a: 1 })).status).toBe(400);
  });

  it("débit borné : au-delà de 20 requêtes par seconde la session est terminée", async () => {
    const r = await rig({}, { idleMs: 5000 });
    const results: number[] = [];
    for (let i = 0; i < 30; i++) results.push((await r.ext.send({ type: "invalidate", id: "x" })).status);
    expect(results).toContain(429);
    expect(r.channel.connected).toBe(false);
  });

  it("session sans aucune requête pendant le délai : terminée (le courtier le sait)", async () => {
    const r = await rig({}, { idleMs: 300, pollMs: 100 });
    await r.select();
    expect(r.reader.selection()).not.toBeNull();
    r.ext.stop();
    await new Promise((x) => setTimeout(x, 900));
    expect(r.channel.connected).toBe(false);
    expect(r.reader.selection()).toBeNull();
  });
});

describe("courtier : la cible vient du geste, la lecture de l'accord", () => {
  it("sans geste : rien n'est demandé ni commandé", async () => {
    const r = await rig();
    await expect(r.reader.readElement("#statut")).rejects.toThrow(/aucune cible/);
    expect(r.asked).toHaveLength(0);
    expect(r.ext.messages.filter((m) => m.type === "read")).toHaveLength(0);
    expect(r.audits).toEqual([{ op: "read_element", ok: false, reason: expect.stringMatching(/aucune cible/) }]);
  });

  it("le geste est exposé SANS contenu : onglet, origine, adresse sans requête", async () => {
    const r = await rig();
    await r.select({ url: "http://localhost:4000/page" });
    expect(r.reader.selection()).toMatchObject({ tabId: 7, origin: "http://localhost:4000", url: "http://localhost:4000/page" });
    expect(Object.keys(r.reader.selection()!).sort()).toEqual(["ageMs", "origin", "tabId", "url"]);
    await r.select({ url: "http://localhost:4000/page?token=abc#x" }); // adresse avec requête : geste mal formé, ignoré (et le précédent est annulé)
    expect(r.reader.selection()).toBeNull();
  });

  it("gestes mal formés ignorés : origine non http, identifiant de document inventé, onglet non entier", async () => {
    const r = await rig();
    for (const bad of [{ origin: "about:blank", url: "about:blank" }, { origin: "moz-extension://x", url: "moz-extension://x/p" }, { docId: "../../etc" }, { tabId: "7" }, { id: "x" }, { url: "http://autre.example/p" }]) {
      await r.select(bad);
      expect(r.reader.selection(), JSON.stringify(bad)).toBeNull();
    }
  });

  it("DOMAINE INTERDIT ou hors liste : refusé AVANT toute demande d'accord, rien n'est commandé, la politique reste intacte", async () => {
    for (const origin of ["http://checkout.localhost:4000", "https://mail.google.com", "https://accounts.google.com", "https://evil.example", "http://127.0.0.1:4000"]) {
      const r = await rig();
      await r.select({ origin, url: `${origin}/p` });
      await expect(r.reader.readElement("#statut")).rejects.toThrow(/politique/);
      expect(r.asked, origin).toHaveLength(0);
      expect(r.ext.messages.filter((m) => m.type === "read")).toHaveLength(0);
      expect(POLICY).toEqual({ allowDomains: ["localhost", "exemple.org"] });
      await r.reader.stop();
    }
  });

  it("sélecteurs non simples refusés avant l'accord : combinateurs, attributs, listes, jokers, espaces, vide, trop long", async () => {
    const r = await rig();
    await r.select();
    for (const s of ["", "*", "div > p", "a b", "a,b", "[type=password]", "input[type=password]", ":root", "#a #b", "div:not(.x)", "#" + "x".repeat(90), "a\nb", "<script>"]) {
      await expect(r.reader.readElement(s), JSON.stringify(s)).rejects.toThrow(/sélecteur/);
    }
    expect(r.asked).toHaveLength(0);
    for (const ok of ["#statut", ".note", "h1", "p.intro", "div#main.big"]) {
      const q = await rig({ approve: async () => false });
      await q.select();
      await expect(q.reader.readElement(ok)).rejects.toThrow(/non accordée/);
      await q.reader.stop();
    }
  });

  it("AUCUN ACCORD (absent, refus, erreur, délai) = aucune lecture commandée", async () => {
    for (const approve of [undefined, async () => false, async () => { throw new Error("panne"); }, () => new Promise<boolean>(() => undefined)]) {
      const r = await rig({ approve: approve as never, approvalTimeoutMs: 150 });
      await r.select();
      await expect(r.reader.readElement("#statut")).rejects.toThrow(/non accordée|expiré/);
      await new Promise((x) => setTimeout(x, 100));
      expect(r.ext.messages.filter((m) => m.type === "read")).toHaveLength(0);
      expect(r.displays).toHaveLength(0);
      await r.reader.stop();
    }
  });

  it("l'accord montre le navigateur, l'origine, le chemin et l'élément — et la commande de lecture porte exactement cette cible", async () => {
    const r = await rig();
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    const cmd = await r.ext.next("read");
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ op: "read_element", browser: "Firefox", host: "localhost", url: "http://localhost:4000/page", params: { selector: "#statut", tab: 7 } });
    expect(r.asked[0]!.summary).toContain("Firefox");
    expect(r.asked[0]!.summary).toContain("#statut");
    expect(cmd).toMatchObject({ type: "read", id: s.id, tabId: 7, docId: s.docId, origin: "http://localhost:4000", selector: "#statut" });
    expect(typeof cmd!.ticket).toBe("string");
    await r.ext.send({ type: "result", id: s.id, ticket: cmd!.ticket, ok: true, title: "Titre d'essai", text: "ÉLÉMENT-CONVENU" });
    await expect(reading).resolves.toBeUndefined(); // le contenu ne revient pas par la valeur de retour
    expect(r.displays).toEqual([{ host: "localhost", url: "http://localhost:4000/page", title: "Titre d'essai", text: "ÉLÉMENT-CONVENU" }]);
    expect(r.audits).toEqual([{ op: "read_element", host: "localhost", ok: true }]); // opération, hôte, résultat : jamais le contenu
    expect(JSON.stringify(r.audits)).not.toMatch(/Titre d'essai|ÉLÉMENT-CONVENU/);
  });

  it("USAGE UNIQUE : après une lecture, il faut un nouveau geste", async () => {
    const r = await rig();
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    const cmd = await r.ext.next("read");
    await r.ext.send({ type: "result", id: s.id, ticket: cmd!.ticket, ok: true, title: "t", text: "x" });
    await reading;
    await expect(r.reader.readElement("#statut")).rejects.toThrow(/aucune cible/);
  });

  it("un résultat avec un AUTRE ticket ou un autre identifiant est ignoré : rien n'est affiché, la lecture expire ; un résultat tardif n'a plus d'effet", async () => {
    const r = await rig();
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    const cmd = await r.ext.next("read");
    await r.ext.send({ type: "result", id: s.id, ticket: "f".repeat(32), ok: true, title: "faux", text: "faux" });
    await r.ext.send({ type: "result", id: randomUUID(), ticket: cmd!.ticket, ok: true, title: "faux", text: "faux" });
    await expect(reading).rejects.toThrow(/expiré/);
    expect(r.displays).toHaveLength(0);
    await r.ext.send({ type: "result", id: s.id, ticket: cmd!.ticket, ok: true, title: "tard", text: "tard" });
    await new Promise((x) => setTimeout(x, 100));
    expect(r.displays).toHaveLength(0);
  });

  it("l'extension peut refuser (page protégée, formulaire, document changé) : rien n'est affiché, le motif est court et sans contenu", async () => {
    const r = await rig();
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    const cmd = await r.ext.next("read");
    await r.ext.send({ type: "result", id: s.id, ticket: cmd!.ticket, ok: false, reason: "élément de formulaire refusé" });
    await expect(reading).rejects.toThrow(/formulaire/);
    expect(r.displays).toHaveLength(0);
    expect(r.audits.at(-1)).toMatchObject({ ok: false });
  });

  it("NAVIGATION PENDANT L'ATTENTE DE L'ACCORD : la cible change, rien n'est commandé", async () => {
    let release: (v: boolean) => void = () => undefined;
    const r = await rig({ approve: () => new Promise<boolean>((res) => (release = res)), approvalTimeoutMs: 2000 });
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    await new Promise((x) => setTimeout(x, 50));
    await r.ext.send({ type: "invalidate", id: s.id, why: "navigation" });
    await new Promise((x) => setTimeout(x, 50));
    release(true);
    await expect(reading).rejects.toThrow(/cible a changé|aucune cible/);
    await new Promise((x) => setTimeout(x, 100));
    expect(r.ext.messages.filter((m) => m.type === "read")).toHaveLength(0);
    expect(r.displays).toHaveLength(0);
  });

  it("NOUVEAU GESTE sur un autre onglet pendant l'accord : l'accord ne vaut pas pour la nouvelle cible", async () => {
    let release: (v: boolean) => void = () => undefined;
    const r = await rig({ approve: () => new Promise<boolean>((res) => (release = res)), approvalTimeoutMs: 2000 });
    await r.select({ tabId: 7 });
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    await new Promise((x) => setTimeout(x, 50));
    await r.select({ tabId: 8 });
    release(true);
    await expect(reading).rejects.toThrow(/annulée|cible a changé/);
    await new Promise((x) => setTimeout(x, 100));
    expect(r.ext.messages.filter((m) => m.type === "read")).toHaveLength(0);
  });

  it("FERMETURE / NAVIGATION PENDANT LA LECTURE : annulée, un résultat tardif est jeté", async () => {
    const r = await rig({ readTtlMs: 2000 });
    const s = await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    const cmd = await r.ext.next("read");
    await r.ext.send({ type: "invalidate", id: s.id, why: "onglet fermé" });
    await expect(reading).rejects.toThrow(/annulée/);
    await r.ext.send({ type: "result", id: s.id, ticket: cmd!.ticket, ok: true, title: "t", text: "x" });
    await new Promise((x) => setTimeout(x, 100));
    expect(r.displays).toHaveLength(0);
  });

  it("PERTE DU CANAL pendant l'attente : annulée ; plus de cible ensuite", async () => {
    const r = await rig({ readTtlMs: 3000 }, { idleMs: 300, pollMs: 100 });
    await r.select();
    const reading = r.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    await r.ext.next("read");
    r.ext.stop();
    await expect(reading).rejects.toThrow(/annulée/);
    await expect(r.reader.readElement("#statut")).rejects.toThrow(/aucune cible/);
  });

  it("EXPIRATION : un geste trop ancien n'est plus une cible ; l'extension qui ne répond pas à temps = accord expiré", async () => {
    let t = 1_000_000;
    const r = await rig({ now: () => t, selectionTtlMs: 5000 });
    await r.select();
    t += 6000;
    await expect(r.reader.readElement("#statut")).rejects.toThrow(/aucune cible/);
    expect(r.asked).toHaveLength(0);
    const q = await rig({ readTtlMs: 150 });
    await q.select();
    const reading = q.reader.readElement("#statut");
    reading.catch(() => undefined); // la promesse est observée plus loin : pas de rejet « non traité » entre-temps
    await q.ext.next("read");
    await expect(reading).rejects.toThrow(/expiré/);
  });

  it("débit : la quatrième lecture de la minute est refusée avant l'accord", async () => {
    const r = await rig({ approve: async () => false, perMinute: 3 });
    await r.select();
    for (let i = 0; i < 3; i++) await expect(r.reader.readElement("#statut")).rejects.toThrow(/non accordée/);
    await expect(r.reader.readElement("#statut")).rejects.toThrow(/minute/);
  });
});
