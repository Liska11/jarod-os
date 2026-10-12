/**
 * U4 — règles du main extraites de `index.ts` (`policies.ts`) : chiffrement safeStorage, permission micro,
 * navigation, reprise bornée du renderer. Le câblage Electron reste éprouvé par les e2e (fenêtre, reprise).
 */
import { describe, expect, it } from "vitest";
import { allowMediaRequest, navigationDecision, RENDERER_MAX_RELOADS, rendererRecovery, type SafeStorageLike, safeStorageCipher } from "../src/main/policies.js";

/** Trousseau simulé réversible (inverse les octets) : on vérifie le format, pas DPAPI. */
function keyring(available: boolean): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString: (p) => (calls.push(`enc:${p}`), Buffer.from(p, "utf8").reverse()),
    decryptString: (b) => (calls.push("dec"), Buffer.from(b).reverse().toString("utf8")),
  };
}

describe("U4 main : chiffrement des secrets par safeStorage", () => {
  it("trousseau disponible : préfixe ss:, aller-retour par le trousseau", () => {
    const k = keyring(true);
    const c = safeStorageCipher(k);
    const enc = c.encrypt("clé-API-é");
    expect(enc.startsWith("ss:")).toBe(true);
    expect(enc).not.toContain("clé");
    expect(c.decrypt(enc)).toBe("clé-API-é");
    expect(k.calls).toEqual(["enc:clé-API-é", "dec"]);
  });

  it("sans trousseau : échec franc à l'écriture (plus de repli pl:), mais la construction ne plante pas le démarrage", () => {
    const c = safeStorageCipher(keyring(false)); // construit au chargement du module, avant « ready »
    expect(() => c.encrypt("secret")).toThrow(/safeStorage indisponible/);
  });

  it("secret sans préfixe ss: : refus à la lecture", () => {
    const k = keyring(true);
    const c = safeStorageCipher(k);
    const enc = c.encrypt("secret");
    expect(enc.startsWith("ss:")).toBe(true);
    expect(() => c.decrypt("ancienne-valeur")).toThrow(/préfixe manquant/);
    expect(() => c.decrypt("pl:c2VjcmV0")).toThrow(/préfixe manquant/);
  });
});

describe("U4 main : permission micro", () => {
  it("notre fenêtre, « media », audio seul → accordé ; tout le reste refusé", () => {
    expect(allowMediaRequest(true, "media", ["audio"])).toBe(true);
    expect(allowMediaRequest(true, "media", ["audio", "video"])).toBe(false);
    expect(allowMediaRequest(true, "media", ["video"])).toBe(false);
    expect(allowMediaRequest(false, "media", ["audio"])).toBe(false);
    expect(allowMediaRequest(true, "geolocation", [])).toBe(false);
    expect(allowMediaRequest(true, "notifications", undefined)).toBe(false);
  });
});

describe("U4 main : navigation de la fenêtre", () => {
  it("http(s) → navigateur ; le reste bloqué ; serveur de dev seul autorisé à rester", () => {
    expect(navigationDecision("https://example.org/")).toBe("external");
    expect(navigationDecision("http://example.org/")).toBe("external");
    expect(navigationDecision("file:///C:/Windows/win.ini")).toBe("block");
    expect(navigationDecision("javascript:alert(1)")).toBe("block");
    expect(navigationDecision("http://localhost:5173/chat", "http://localhost:5173")).toBe("stay");
    expect(navigationDecision("http://localhost:5174/", "http://localhost:5173")).toBe("external");
  });
});

describe("U4 main : reprise bornée du renderer", () => {
  it("3 rechargements par minute glissante, puis abandon annoncé ; sortie propre ignorée", () => {
    let t = 0;
    const r = rendererRecovery(RENDERER_MAX_RELOADS, 60_000, () => t);
    expect(r.onGone("clean-exit")).toEqual({ action: "ignore", count: 0 });
    expect([1, 2, 3].map(() => r.onGone("crashed").action)).toEqual(["reload", "reload", "reload"]);
    expect(r.onGone("oom")).toEqual({ action: "give-up", count: 4 });
    // Une minute plus tard, les anciens arrêts sortent de la fenêtre : on recharge de nouveau.
    t = 60_001;
    expect(r.onGone("killed")).toEqual({ action: "reload", count: 1 });
    expect(r.count).toBe(1);
  });
});

describe("AV2-009 : list-models borné à 500, jamais en silence, le modèle actif est conservé", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p:m${i}`, name: `m${i}`, provider: "p", model: `m${i}`, baseUrl: "", createdAt: 0 }));

  it("sous le plafond : rendu tel quel, aucun avertissement", async () => {
    const { boundModels, MAX_LISTED_MODELS } = await import("../src/main/handlers/models.js");
    const warned: number[] = [];
    const list = many(MAX_LISTED_MODELS);
    expect(boundModels(list, "p:m0", (t) => warned.push(t))).toBe(list);
    expect(warned).toEqual([]);
  });

  it("au-dessus : tronqué à 500, avertissement avec le total, modèle actif (dernier de la liste) conservé", async () => {
    const { boundModels, MAX_LISTED_MODELS } = await import("../src/main/handlers/models.js");
    expect(MAX_LISTED_MODELS).toBe(500);
    const warned: number[] = [];
    const list = many(731);
    const out = boundModels(list, "p:m730", (t) => warned.push(t));
    expect(warned).toEqual([731]);
    expect(out).toHaveLength(500);
    expect(out.at(-1)!.id).toBe("p:m730");
    expect(out[0]!.id).toBe("p:m0");
    // Déjà dans les 500 premiers : rien à substituer.
    expect(boundModels(list, "p:m3", () => {}).map((m) => m.id)).toEqual(list.slice(0, 500).map((m) => m.id));
  });
});

describe("AV2-009 : secrets illisibles listés, jamais silencieux", () => {
  it("une valeur sans préfixe ss: est refusée à la lecture ET signalée par son NOM ; les valeurs du trousseau restent lisibles", async () => {
    const { cleanup } = await import("@jarod/kernel/testing");
    const { setupKernel } = await import("./ui-parite-helpers.js");
    try {
      const { app, call } = await setupKernel();
      const settings = (app as unknown as { storage: { settings: import("@jarod/plugin-storage").SettingsService; db: import("@jarod/plugin-storage").Db } }).storage;
      const k = keyring(true);
      // Le chiffreur de production : un trousseau qui marche.
      (settings.settings as unknown as { cipher: unknown }).cipher = safeStorageCipher(k);
      settings.settings.setSecret("fournisseur.ok", "valeur-valide");
      settings.db.run("INSERT INTO secrets (key, value) VALUES (?, ?)", "gateway.ancienne", "valeur-en-clair-d-avant");
      settings.db.run("INSERT INTO secrets (key, value) VALUES (?, ?)", "gateway.pl", "pl:c2VjcmV0");
      expect(settings.settings.getSecret("fournisseur.ok")).toBe("valeur-valide");
      expect(settings.settings.getSecret("gateway.ancienne")).toBeUndefined(); // refus assumé
      const r = (await call("secrets-unreadable")) as { keys: string[] };
      expect(r).toEqual({ keys: ["gateway.ancienne", "gateway.pl"] });
      expect(JSON.stringify(r)).not.toContain("valeur-en-clair");
    } finally {
      cleanup();
    }
  });
});
