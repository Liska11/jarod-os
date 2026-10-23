// 2026-10-22 — la commande de l'agent hérite de l'environnement de l'utilisateur SANS les jetons internes ni les clés de fournisseur de Jarod ;
// un secret autorisé arrive par `extraEnv`, pour cette commande seulement. Faux secrets sentinelles : seule la présence est lue.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShell } from "../src/builtin.js";

const planted = ["JAROD_GATEWAY_TOKEN", "JAROD_OS_CONTROL_TOKEN", "OPENAI_API_KEY", "USER_TOOL_TOKEN"];
const before = new Map<string, string | undefined>();
beforeEach(() => {
  for (const n of planted) before.set(n, process.env[n]);
  for (const n of planted) process.env[n] = `SENTINELLE-${n}`;
});
afterEach(() => {
  for (const [n, v] of before) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

const probe = `node -e "process.stdout.write(['JAROD_GATEWAY_TOKEN','JAROD_OS_CONTROL_TOKEN','OPENAI_API_KEY','USER_TOOL_TOKEN','INJECTED'].map(n=>n+'='+(process.env[n]!==undefined)).join(','))"`;

describe("run_shell — environnement de la commande", () => {
  it("sans jeton interne ni clé de fournisseur ; les outils de l'utilisateur gardent leurs identifiants", async () => {
    const { output } = await runShell(probe, process.cwd());
    expect(output).toContain("JAROD_GATEWAY_TOKEN=false");
    expect(output).toContain("JAROD_OS_CONTROL_TOKEN=false");
    expect(output).toContain("OPENAI_API_KEY=false");
    expect(output).toContain("USER_TOOL_TOKEN=true");
    expect(output).toContain("INJECTED=false");
    expect(output).not.toContain("SENTINELLE");
  }, 30_000);

  it("un secret autorisé est injecté pour cette commande seulement", async () => {
    const { output } = await runShell(probe, process.cwd(), undefined, 30_000, undefined, { INJECTED: "SENTINELLE-injecté" });
    expect(output).toContain("INJECTED=true");
    expect(output).toContain("JAROD_GATEWAY_TOKEN=false");
    const again = await runShell(probe, process.cwd());
    expect(again.output).toContain("INJECTED=false");
  }, 60_000);
});
