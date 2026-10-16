import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activationOrder,
  ManifestError,
  parseManifest,
  type PlatformEvent,
  PlatformError,
  type PluginHost,
  type PluginManifest,
  PluginPlatform,
  satisfies,
  signManifest,
  verifyManifest,
} from "../src/index.js";

const made: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-plat-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const trusted = { main: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };

function manifest(name: string, version = "1.0.0", extra: Partial<PluginManifest> = {}, payload = name): PluginManifest {
  return parseManifest({
    name,
    version,
    dependencies: {},
    permissions: [],
    quotas: { memoryMb: 100, diskMb: 50, vramMb: 0 },
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    ...extra,
  });
}
const signed = (m: PluginManifest) => signManifest(m, "main", pair.privateKey);

function fakeHost(opts: { failActivate?: Set<string>; unhealthy?: Set<string> } = {}) {
  const active = new Set<string>();
  const log: string[] = [];
  const host: PluginHost = {
    async activate(m) {
      log.push(`activate ${m.name}@${m.version}`);
      if (opts.failActivate?.has(`${m.name}@${m.version}`)) throw new Error("boom");
      active.add(m.name);
    },
    async deactivate(name) {
      log.push(`deactivate ${name}`);
      active.delete(name);
    },
    async health(name) {
      return !opts.unhealthy?.has(name);
    },
  };
  return { host, active, log };
}

function platform(host: PluginHost, extra: Partial<ConstructorParameters<typeof PluginPlatform>[0]> = {}) {
  const events: PlatformEvent[] = [];
  const stateFile = join(temp(), "state.json");
  const p = new PluginPlatform({ stateFile, trusted, host, approve: async () => true, onEvent: (e) => events.push(e), ...extra });
  return { p, events, stateFile };
}

describe("manifeste et signature", () => {
  it("refuse une forme invalide, une permission inconnue, un champ inconnu, un GPU sans permission", () => {
    expect(() => parseManifest(null)).toThrow(ManifestError);
    expect(() => parseManifest({ ...manifest("a"), name: "A b" })).toThrow(/name/);
    expect(() => parseManifest({ ...manifest("a"), version: "1.0" })).toThrow(/version/);
    expect(() => parseManifest({ ...manifest("a"), permissions: ["root"] })).toThrow(/permission inconnue/);
    expect(() => parseManifest({ ...manifest("a"), extra: 1 })).toThrow(/champ inconnu/);
    expect(() => parseManifest({ ...manifest("a"), quotas: { memoryMb: 1, diskMb: 1, vramMb: 512 } })).toThrow(/gpu/);
    expect(() => parseManifest({ ...manifest("a"), dependencies: { b: "latest" } })).toThrow(/plage/);
  });

  it("une signature valide passe ; non signé, clé inconnue, clé d'un autre, ou manifeste altéré : refus", () => {
    const m = signed(manifest("a"));
    expect(() => verifyManifest(m, trusted)).not.toThrow();
    expect(() => verifyManifest(manifest("a"), trusted)).toThrow(/non signé/);
    expect(() => verifyManifest(signManifest(manifest("a"), "inconnue", pair.privateKey), trusted)).toThrow(/inconnue/);
    expect(() => verifyManifest(signManifest(manifest("a"), "main", other.privateKey), trusted)).toThrow(/invalide/);
    expect(() => verifyManifest({ ...m, version: "9.9.9" }, trusted)).toThrow(/invalide/);
    expect(() => verifyManifest({ ...m, permissions: ["gpu"] }, trusted)).toThrow(/invalide/);
  });
});

describe("graphe de dépendances", () => {
  it("plages de versions", () => {
    expect(satisfies("1.4.0", "^1.2.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfies("1.0.0", "1.0.0")).toBe(true);
    expect(satisfies("1.0.1", "1.0.0")).toBe(false);
    expect(satisfies("3.0.0", ">=2.0.0")).toBe(true);
  });

  it("ordre d'activation, manque, version hors plage et cycle avec son chemin", () => {
    const m = (name: string, deps: Record<string, string> = {}, version = "1.0.0") => manifest(name, version, { dependencies: deps });
    const ok = new Map([m("a", { b: "^1.0.0" }), m("b", { c: "^1.0.0" }), m("c")].map((x) => [x.name, x]));
    expect(activationOrder(ok, ["a"])).toEqual(["c", "b", "a"]);

    expect(() => activationOrder(new Map([[ "a", m("a", { z: "^1.0.0" }) ]]), ["a"])).toThrow(/z : introuvable/);
    expect(() => activationOrder(new Map([m("a", { b: "^2.0.0" }), m("b")].map((x) => [x.name, x])), ["a"])).toThrow(/a demande b \^2\.0\.0/);
    const cycle = new Map([m("a", { b: "^1.0.0" }), m("b", { a: "^1.0.0" })].map((x) => [x.name, x]));
    expect(() => activationOrder(cycle, ["a"])).toThrow(/cycle : a → b → a/);
  });
});

describe("installation", () => {
  it("refuse sans signature, avec un contenu qui ne correspond pas, et ne change rien", async () => {
    const { host } = fakeHost();
    const { p } = platform(host);
    await expect(p.install(manifest("a"))).rejects.toThrow(/non signé/);
    await expect(p.install(signed(manifest("a")), Buffer.from("autre contenu"))).rejects.toThrow(/empreinte signée/);
    expect(p.list()).toEqual([]);
    await p.install(signed(manifest("a")), Buffer.from("a"));
    expect(p.get("a").status).toBe("installed");
  });

  it("des permissions déclarées exigent un accord ; sans canal, ou refusé, rien n'est installé", async () => {
    const m = signed(manifest("a", "1.0.0", { permissions: ["net.http"] }));
    const { host } = fakeHost();
    await expect(platform(host, { approve: null }).p.install(m)).rejects.toThrow(/aucun canal/);
    await expect(platform(host, { approve: async () => false }).p.install(m)).rejects.toThrow(/refusées/);
    const ok = platform(host);
    await ok.p.install(m);
    expect(ok.p.list()).toHaveLength(1);
  });

  it("un plugin n'a que les permissions déclarées, et seulement quand il est actif", async () => {
    const { host } = fakeHost();
    const { p } = platform(host);
    await p.install(signed(manifest("a", "1.0.0", { permissions: ["net.http"] })));
    expect(p.allowed("a", "net.http")).toBe(false);
    await p.enable("a");
    expect(p.allowed("a", "net.http")).toBe(true);
    expect(p.allowed("a", "process.spawn")).toBe(false);
    expect(p.allowed("inconnu", "net.http")).toBe(false);
  });

  it("une dépendance manquante ou un cycle sont refusés à l'installation", async () => {
    const { host } = fakeHost();
    const { p } = platform(host);
    await expect(p.install(signed(manifest("a", "1.0.0", { dependencies: { b: "^1.0.0" } })))).rejects.toThrow(/b : introuvable/);
    expect(p.list()).toEqual([]);
  });

  it("les budgets de la zone sont tenus (somme des quotas installés)", async () => {
    const { host } = fakeHost();
    const { p } = platform(host, { budgets: { memoryMb: 250 } });
    await p.install(signed(manifest("a")));
    await p.install(signed(manifest("b")));
    await expect(p.install(signed(manifest("c")))).rejects.toThrow(/budget memoryMb dépassé : 200 \+ 100 > 250/);
    expect(p.list().map((r) => r.manifest.name)).toEqual(["a", "b"]);
  });
});

describe("cycle de vie", () => {
  async function trio() {
    const f = fakeHost();
    const env = platform(f.host);
    await env.p.install(signed(manifest("base")));
    await env.p.install(signed(manifest("mid", "1.0.0", { dependencies: { base: "^1.0.0" } })));
    await env.p.install(signed(manifest("top", "1.0.0", { dependencies: { mid: "^1.0.0" } })));
    return { ...f, ...env };
  }

  it("activer un plugin active ses dépendances d'abord", async () => {
    const { p, log } = await trio();
    await p.enable("top");
    expect(log).toEqual(["activate base@1.0.0", "activate mid@1.0.0", "activate top@1.0.0"]);
    expect(p.list().map((r) => r.status)).toEqual(["enabled", "enabled", "enabled"]);
  });

  it("un échec d'activation défait tout ce qui venait d'être activé", async () => {
    const f = fakeHost({ failActivate: new Set(["top@1.0.0"]) });
    const { p } = platform(f.host);
    await p.install(signed(manifest("base")));
    await p.install(signed(manifest("top", "1.0.0", { dependencies: { base: "^1.0.0" } })));
    await expect(p.enable("top")).rejects.toThrow(PlatformError);
    expect(f.active.size).toBe(0);
    expect(p.get("base").status).toBe("installed");
    expect(p.get("top").failures).toBe(1);
  });

  it("désactiver ou retirer ce dont un autre dépend est refusé, sauf cascade explicite", async () => {
    const { p, active } = await trio();
    await p.enable("top");
    await expect(p.disable("base")).rejects.toThrow(/nécessaire à : mid, top/);
    await expect(p.remove("base")).rejects.toThrow(/nécessaire à/);
    expect(active.size).toBe(3);
    await p.disable("base", true);
    expect(active.size).toBe(0);
    expect(p.list().map((r) => r.status)).toEqual(["disabled", "disabled", "disabled"]);
  });
});

describe("mise à jour et retour arrière", () => {
  it("une mise à jour réussie garde la version précédente pour un retour manuel", async () => {
    const f = fakeHost();
    const { p } = platform(f.host);
    await p.install(signed(manifest("a")));
    await p.enable("a");
    await p.update(signed(manifest("a", "1.1.0")));
    expect(p.get("a").manifest.version).toBe("1.1.0");
    expect(p.get("a").previous?.version).toBe("1.0.0");
    await p.rollback("a");
    expect(p.get("a").manifest.version).toBe("1.0.0");
    expect(f.active.has("a")).toBe(true);
    await expect(p.rollback("a")).rejects.toThrow(/aucune version précédente/);
  });

  it("une mise à jour qui échoue est ANNULÉE : l'ancienne version tourne toujours", async () => {
    const f = fakeHost({ failActivate: new Set(["a@2.0.0"]) });
    const { p, events } = platform(f.host);
    await p.install(signed(manifest("a")));
    await p.enable("a");

    await expect(p.update(signed(manifest("a", "2.0.0")))).rejects.toThrow(/1\.0\.0 est rétabli/);
    expect(p.get("a").manifest.version).toBe("1.0.0");
    expect(f.active.has("a")).toBe(true);
    expect(events.some((e) => e.action === "update-rolled-back")).toBe(true);
  });

  it("une mise à jour dont le contrôle de santé échoue est annulée de même", async () => {
    const unhealthy = new Set<string>();
    const f = fakeHost({ unhealthy });
    const { p } = platform(f.host);
    await p.install(signed(manifest("a")));
    await p.enable("a");
    unhealthy.add("a");
    await expect(p.update(signed(manifest("a", "1.0.1")))).rejects.toThrow(/rétabli/);
    expect(p.get("a").manifest.version).toBe("1.0.0");
  });

  it("refuse un retour en arrière de version, des permissions ajoutées sans accord, et de casser un dépendant", async () => {
    const f = fakeHost();
    const { p } = platform(f.host);
    await p.install(signed(manifest("a", "1.2.0")));
    await p.install(signed(manifest("b", "1.0.0", { dependencies: { a: "^1.0.0" } })));
    await expect(p.update(signed(manifest("a", "1.1.0")))).rejects.toThrow(/ne dépasse pas/);
    await expect(p.update(signed(manifest("a", "2.0.0")))).rejects.toThrow(/b exige a \^1\.0\.0/);

    const noapprove = platform(f.host, { approve: null });
    await noapprove.p.install(signed(manifest("c")));
    await expect(noapprove.p.update(signed(manifest("c", "1.1.0", { permissions: ["net.http"] })))).rejects.toThrow(/nouvelles permissions/);
    expect(noapprove.p.get("c").manifest.version).toBe("1.0.0");
  });

  it("une mise à jour non signée par une clé de confiance est refusée", async () => {
    const { p } = platform(fakeHost().host);
    await p.install(signed(manifest("a")));
    await expect(p.update(signManifest(manifest("a", "1.1.0"), "main", other.privateKey))).rejects.toThrow(/invalide/);
  });
});

describe("santé, quotas et quarantaine", () => {
  it("trois échecs de santé de suite : quarantaine, dépendants désactivés ; seul release en sort", async () => {
    const unhealthy = new Set<string>();
    const f = fakeHost({ unhealthy });
    const { p } = platform(f.host);
    await p.install(signed(manifest("base")));
    await p.install(signed(manifest("top", "1.0.0", { dependencies: { base: "^1.0.0" } })));
    await p.enable("top");

    unhealthy.add("base");
    expect(await p.checkHealth("base")).toBe(false);
    expect(await p.checkHealth("base")).toBe(false);
    expect(p.get("base").status).toBe("enabled");
    expect(await p.checkHealth("base")).toBe(false);

    expect(p.get("base").status).toBe("quarantined");
    expect(p.get("top").status).toBe("disabled");
    expect(f.active.size).toBe(0);
    await expect(p.enable("top")).rejects.toThrow(/quarantaine/);

    unhealthy.clear();
    p.release("base");
    expect(p.get("base").status).toBe("disabled");
    await p.enable("top");
    expect(f.active.has("top")).toBe(true);
  });

  it("un succès remet le compteur à zéro", async () => {
    const unhealthy = new Set<string>();
    const f = fakeHost({ unhealthy });
    const { p } = platform(f.host);
    await p.install(signed(manifest("a")));
    await p.enable("a");
    unhealthy.add("a");
    await p.checkHealth("a");
    await p.checkHealth("a");
    unhealthy.clear();
    expect(await p.checkHealth("a")).toBe(true);
    unhealthy.add("a");
    await p.checkHealth("a");
    await p.checkHealth("a");
    expect(p.get("a").status).toBe("enabled");
  });

  it("un dépassement de quota met en quarantaine tout de suite", async () => {
    const f = fakeHost();
    const { p } = platform(f.host);
    await p.install(signed(manifest("a")));
    await p.enable("a");
    await p.reportUsage("a", { memoryMb: 100, diskMb: 50 });
    expect(p.get("a").status).toBe("enabled");
    await p.reportUsage("a", { memoryMb: 101 });
    expect(p.get("a").status).toBe("quarantined");
    expect(p.get("a").reason).toMatch(/quota memoryMb dépassé : 101 > 100/);
    expect(f.active.size).toBe(0);
  });

  it("l'état survit au redémarrage, et l'audit ne contient ni permission ni contenu", async () => {
    const f = fakeHost();
    const { p, stateFile, events } = platform(f.host);
    await p.install(signed(manifest("a", "1.0.0", { permissions: ["secrets.read"] })));
    await p.enable("a");

    const again = new PluginPlatform({ stateFile, trusted, host: f.host });
    expect(again.get("a")).toMatchObject({ status: "enabled", manifest: { version: "1.0.0" } });
    expect(readFileSync(stateFile, "utf8")).toContain('"a"');
    expect(JSON.stringify(events)).not.toContain("secrets.read");
  });
});
