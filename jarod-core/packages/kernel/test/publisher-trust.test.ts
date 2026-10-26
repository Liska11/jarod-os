/**
 * Matrice de confiance des éditeurs (portée depuis la reconstruction, Phases 1 à 4).
 *
 * Les cas sont ceux qui étaient prouvés côté reconstruction (`tests/trust.test.mjs`) : clé inconnue
 * refusée en official/verified, acceptée en community avec avertissement, clé locale seule pour
 * `local`, promotion impossible, rotation qui révoque, réintroduction d'une clé révoquée refusée.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addKey,
  createTrustService,
  decide,
  emptyStore,
  loadStore,
  rotateKey,
  saveStore,
  seedLocal,
  statusOf,
} from "../src/publisher-trust.js";

const PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n";
const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-trust-"));
  dirs.push(dir);
  return join(dir, "publisher-keys.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("décision d'acceptation", () => {
  it("refuse une clé inconnue pour official et verified, l'accepte en community avec avertissement", () => {
    const store = emptyStore();
    const official = decide(store, { keyId: "inconnue", declared: "official" });
    expect(official.ok).toBe(false);
    expect(official.reason).toMatch(/inconnue/);
    const verified = decide(store, { keyId: "inconnue", declared: "verified" });
    expect(verified.ok).toBe(false);
    const community = decide(store, { keyId: "inconnue", declared: "community" });
    expect(community.ok).toBe(true);
    expect(community.level).toBe("community");
    expect(community.warning).toMatch(/non vérifiée|non approuvé/);
  });

  it("n'accepte que local-1 pour le niveau local, et refuse local-1 en official", () => {
    const store = emptyStore();
    seedLocal(store, PEM);
    expect(decide(store, { keyId: "local-1", declared: "local" }).ok).toBe(true);
    const official = decide(store, { keyId: "local-1", declared: "official" });
    expect(official.ok).toBe(false);
    expect(official.keyLevel).toBe("local");
    expect(official.reason).toMatch(/insuffisant/);
    expect(decide(store, { keyId: "autre", declared: "local" }).ok).toBe(false);
  });

  it("refuse une clé enregistrée community pour official (niveau insuffisant)", () => {
    const store = emptyStore();
    addKey(store, { keyId: "comm", publicPem: PEM, level: "community" });
    const d = decide(store, { keyId: "comm", declared: "official" });
    expect(d.ok).toBe(false);
    expect(d.keyLevel).toBe("community");
  });

  it("refuse un niveau déclaré inconnu", () => {
    expect(decide(emptyStore(), { keyId: "x", declared: "root" }).ok).toBe(false);
  });
});

describe("registre", () => {
  it("interdit toute promotion : un keyId existant garde son niveau", () => {
    const store = emptyStore();
    addKey(store, { keyId: "k1", publicPem: PEM, level: "community" });
    expect(() => addKey(store, { keyId: "k1", publicPem: PEM, level: "official" })).toThrow(/rotation requise/);
    expect(addKey(store, { keyId: "k1", publicPem: PEM, level: "community" }).level).toBe("community");
  });

  it("rotation : révoque l'ancienne, enregistre la nouvelle au même niveau, refuse la réintroduction", () => {
    const store = emptyStore();
    addKey(store, { keyId: "old", publicPem: PEM, level: "verified" });
    const r = rotateKey(store, "old", { newKeyId: "new", publicPem: PEM });
    expect(r).toEqual({ revoked: "old", added: "new", level: "verified" });
    expect(statusOf(store, "old").revoked).toBe(true);
    expect(statusOf(store, "old").replacedBy).toBe("new");
    expect(decide(store, { keyId: "old", declared: "verified" }).reason).toMatch(/révoquée/);
    expect(decide(store, { keyId: "new", declared: "verified" }).ok).toBe(true);
    expect(() => addKey(store, { keyId: "old", publicPem: PEM, level: "verified" })).toThrow(/révoquée/);
  });

  it("refuse une clé publique qui n'est pas un PEM", () => {
    expect(() => addKey(emptyStore(), { keyId: "k", publicPem: "nope", level: "community" })).toThrow(/PEM/);
  });

  it("persiste sur disque et relit l'état", () => {
    const file = tempFile();
    const store = emptyStore();
    addKey(store, { keyId: "k2", publicPem: PEM, level: "official" });
    saveStore(file, store);
    const back = loadStore(file);
    expect(back.keys.k2!.level).toBe("official");
    expect(JSON.parse(readFileSync(file, "utf8")).keys.k2.keyId).toBe("k2");
  });
});

describe("service adossé au fichier", () => {
  it("relit le disque à chaque décision (une clé ajoutée après coup compte)", () => {
    const file = tempFile();
    const service = createTrustService(file);
    expect(service.check({ name: "p", trust: "official", signature: { keyId: "tard" } }).ok).toBe(false);
    const store = loadStore(file);
    addKey(store, { keyId: "tard", publicPem: PEM, level: "official" });
    saveStore(file, store);
    expect(service.check({ name: "p", trust: "official", signature: { keyId: "tard" } }).ok).toBe(true);
    expect(service.pems().tard).toContain("BEGIN PUBLIC KEY");
  });

  it("seed local-1 au niveau local et l'expose dans pems(), jamais après révocation", () => {
    const file = tempFile();
    const service = createTrustService(file, PEM);
    const store = loadStore(file);
    expect(store.keys["local-1"]!.level).toBe("local");
    expect(service.status({ name: "p", trust: "local", signature: { keyId: "local-1" } })).toMatchObject({ level: "local", revoked: false, ok: true });
    rotateKey(store, "local-1", { newKeyId: "local-2", publicPem: PEM });
    saveStore(file, store);
    expect(service.status({ name: "p", trust: "local", signature: { keyId: "local-1" } })).toMatchObject({ revoked: true, ok: false });
    expect(Object.keys(service.pems())).toEqual(["local-2"]);
  });
});
