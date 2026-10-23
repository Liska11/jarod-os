// Le jeton de la passerelle ne descend dans AUCUN processus enfant (2026-10-21) : le shell de l'agent, un serveur MCP ou une extension qui
// l'hériterait pourrait ouvrir la passerelle et répondre lui-même à une demande d'accord (`tool-approval-respond`) — l'agent s'accorderait
// des droits. Le point d'entrée le lit puis le retire de `process.env` AVANT d'ouvrir le cœur (le premier code qui lance des enfants).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(__dirname, "..", "src", "gateway", "main.ts"), "utf8");

describe("JAROD_GATEWAY_TOKEN", () => {
  it("est lu puis retiré de process.env avant l'ouverture du cœur ; la passerelle reçoit la valeur lue", () => {
    const read = main.indexOf("const gatewayToken = env.JAROD_GATEWAY_TOKEN;");
    const removed = main.indexOf("delete process.env.JAROD_GATEWAY_TOKEN;");
    const core = main.indexOf("await openCore(");
    expect(read).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(read);
    expect(core).toBeGreaterThan(removed);
    expect(main).toContain("...(gatewayToken ? { token: gatewayToken } : {}),");
    // Plus aucune lecture de la variable après son retrait.
    expect(main.slice(removed + "delete process.env.JAROD_GATEWAY_TOKEN;".length)).not.toMatch(/env\.JAROD_GATEWAY_TOKEN/);
  });

  it("un enfant lancé après le retrait ne la voit pas (même mécanisme que le shell de l'agent : process.env hérité)", () => {
    const script = "process.env.JAROD_GATEWAY_TOKEN='jeton';const t=process.env.JAROD_GATEWAY_TOKEN;delete process.env.JAROD_GATEWAY_TOKEN;" +
      "const r=require('node:child_process').spawnSync(process.execPath,['-e','process.stdout.write(String(process.env.JAROD_GATEWAY_TOKEN))'],{encoding:'utf8'});" +
      "process.stdout.write(t+'|'+r.stdout)";
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(r.stdout).toBe("jeton|undefined");
  });
});
