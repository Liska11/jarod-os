import type { McpServerConfig } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { linearEntry, mergeLinear } from "../src/wire-linear-mcp.js";

const other: McpServerConfig = { id: "o1", name: "autre", command: "x", args: [], env: { A: "1" }, enabled: true };

describe("câblage du sidecar Linear", () => {
  it("l'entrée est une commande absolue : node et build/index.js du sidecar, clé dans l'env", () => {
    const e = linearEntry("lin_api_test", "id1");
    expect(e).toMatchObject({ id: "id1", name: "linear", enabled: true, env: { LINEAR_API_KEY: "lin_api_test" } });
    expect(e.command).toBe(process.execPath);
    expect(e.args).toHaveLength(1);
    const script = (e.args[0] ?? "").split(String.fromCharCode(92)).join("/");
    expect(script.endsWith("/tools/linear-mcp-server/node_modules/linear-mcp-server/build/index.js")).toBe(true);
  });

  it("fusion : ajoute sans toucher aux autres ; relancée, remplace l'entrée en gardant son id (idempotente)", () => {
    const once = mergeLinear([other], linearEntry("k1", "new1"));
    expect(once.map((s) => s.name)).toEqual(["autre", "linear"]);
    expect(once[0]).toBe(other);
    const twice = mergeLinear(once, linearEntry("k2", "new2"));
    expect(twice).toHaveLength(2);
    expect(twice[1]).toMatchObject({ id: "new1", env: { LINEAR_API_KEY: "k2" } });
    expect(mergeLinear(twice, linearEntry("k2", "new3"))).toEqual(twice);
  });
});
