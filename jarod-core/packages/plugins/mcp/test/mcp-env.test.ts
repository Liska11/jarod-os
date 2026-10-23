// 2026-10-22 — un serveur MCP tiers ne reçoit ni jeton de contrôle interne, ni clé de fournisseur, ni variable en forme de secret ;
// il reçoit ce que SA configuration nomme. Faux secrets sentinelles : on ne lit que « présent / absent », jamais une valeur.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp.js";

const ENV_MCP = fileURLToPath(new URL("./fixtures/env-mcp.mjs", import.meta.url));
const NAMES = ["JAROD_GATEWAY_TOKEN", "JAROD_OS_CONTROL_TOKEN", "ANTHROPIC_API_KEY", "AMBIENT_API_TOKEN", "CONFIGURED_TOKEN", "ELECTRON_RUN_AS_NODE", "PATH_LIKE_OK"];
const planted = ["JAROD_GATEWAY_TOKEN", "JAROD_OS_CONTROL_TOKEN", "ANTHROPIC_API_KEY", "AMBIENT_API_TOKEN", "ELECTRON_RUN_AS_NODE", "PATH_LIKE_OK"];
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

async function has(config: Record<string, string>): Promise<Record<string, boolean>> {
  const client = new McpClient({ command: process.execPath, args: [ENV_MCP], env: config }, 15_000);
  try {
    await client.start();
    const r = await client.callTool("has", { names: NAMES });
    return JSON.parse(r.text) as Record<string, boolean>;
  } finally {
    client.stop();
  }
}

describe("MCP — environnement du serveur", () => {
  it("un serveur sans configuration ne voit aucun secret du noyau ; le reste de l'environnement passe", async () => {
    expect(await has({})).toEqual({
      JAROD_GATEWAY_TOKEN: false,
      JAROD_OS_CONTROL_TOKEN: false,
      ANTHROPIC_API_KEY: false,
      AMBIENT_API_TOKEN: false,
      CONFIGURED_TOKEN: false,
      ELECTRON_RUN_AS_NODE: true,
      PATH_LIKE_OK: true,
    });
  }, 30_000);

  it("la variable nommée par la configuration du serveur lui arrive, à lui seul", async () => {
    const withIt = await has({ CONFIGURED_TOKEN: "SENTINELLE-configuré" });
    expect(withIt.CONFIGURED_TOKEN).toBe(true);
    expect(withIt.JAROD_GATEWAY_TOKEN).toBe(false);
    expect(withIt.AMBIENT_API_TOKEN).toBe(false);
    expect((await has({})).CONFIGURED_TOKEN).toBe(false);
  }, 60_000);

  it("la configuration ne peut pas réintroduire un jeton interne (de bout en bout, processus réel) ; ses propres identifiants arrivent", async () => {
    const r = await has({ JAROD_GATEWAY_TOKEN: "SENTINELLE-copie", JAROD_OS_CONTROL_TOKEN: "SENTINELLE-copie", CONFIGURED_TOKEN: "SENTINELLE-propre" });
    expect(r.JAROD_GATEWAY_TOKEN).toBe(false);
    expect(r.JAROD_OS_CONTROL_TOKEN).toBe(false);
    expect(r.CONFIGURED_TOKEN).toBe(true);
  }, 60_000);
});
