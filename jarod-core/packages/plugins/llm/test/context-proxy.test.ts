// Cockpit, lot 4 — billion-context branché EXPLICITEMENT au transport : préfixe `/bili/` sur l'adresse du fournisseur, bouclage seulement,
// fournisseurs nommés seulement, jamais un fournisseur local ; l'adresse affichée et enregistrée (def) ne change pas.
import { describe, expect, it } from "vitest";
import { isLoopbackUrl, viaContextProxy } from "../src/providers.js";

const on = { enabled: true, url: "http://127.0.0.1:8787", providers: ["anthropic", "openai"] };

describe("proxy de compression de l'historique", () => {
  it("préfixe l'adresse du fournisseur nommé", () => {
    expect(viaContextProxy(on, "openai", "https://api.openai.com/v1", false)).toBe("http://127.0.0.1:8787/bili/https://api.openai.com/v1");
    expect(viaContextProxy({ ...on, url: "http://localhost:8787/" }, "anthropic", "https://api.anthropic.com", false)).toBe("http://localhost:8787/bili/https://api.anthropic.com");
  });

  it("ne touche à rien : éteint, fournisseur non nommé, fournisseur local, adresse non https, proxy hors bouclage", () => {
    expect(viaContextProxy({ ...on, enabled: false }, "openai", "https://api.openai.com/v1", false)).toBe("https://api.openai.com/v1");
    expect(viaContextProxy(on, "mistral", "https://api.mistral.ai/v1", false)).toBe("https://api.mistral.ai/v1");
    expect(viaContextProxy({ ...on, providers: ["lmstudio"] }, "lmstudio", "http://127.0.0.1:1234/v1", true)).toBe("http://127.0.0.1:1234/v1");
    expect(viaContextProxy(on, "openai", "http://intranet/v1", false)).toBe("http://intranet/v1");
    expect(viaContextProxy({ ...on, url: "http://proxy.example.com:8787" }, "openai", "https://api.openai.com/v1", false)).toBe("https://api.openai.com/v1");
    expect(viaContextProxy(undefined, "openai", "https://api.openai.com/v1", false)).toBe("https://api.openai.com/v1");
  });

  it("bouclage : http, 127.0.0.1 / localhost / [::1], sans chemin", () => {
    for (const ok of ["http://127.0.0.1:8787", "http://localhost:9", "http://[::1]:8787/"]) expect(isLoopbackUrl(ok), ok).toBe(true);
    for (const no of ["https://127.0.0.1:8787", "http://10.0.0.2:8787", "http://127.0.0.1:8787/bili", "http://localhost.evil.com:1", "pas une url"]) expect(isLoopbackUrl(no), no).toBe(false);
  });
});
