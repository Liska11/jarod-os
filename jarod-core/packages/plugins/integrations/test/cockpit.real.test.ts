// Cockpit, lot 1 : les sondes sur la VRAIE machine (hôte réel). L'état dépend de ce qui est installé ; le test vérifie ce qui ne doit
// jamais varier : chaque sonde aboutit, aucun état n'est inventé, aucune valeur de clé ne sort. `JAROD_COCKPIT_PRINT=1` affiche le relevé.
import { describe, expect, it } from "vitest";
import { nodeProbeHost } from "../src/cockpit/probe.js";
import { CapabilityService } from "../src/cockpit/service.js";

const STATES = ["not-installed", "installed-unconfigured", "available", "degraded", "error"];

describe("cockpit : sondes réelles", () => {
  it("chaque intégration rend un état mesuré, sans secret, en temps borné", async () => {
    const s = new CapabilityService({ host: nodeProbeHost(), tools: { info: () => [], spec: () => undefined }, skills: () => [], mcpServers: () => [], decide: () => "allow" });
    const t0 = Date.now();
    const rows = await s.list();
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(rows).toHaveLength(10);
    const keyish = Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|PASSWORD/i.test(k) && v && v.length >= 8).map(([, v]) => v!);
    for (const r of rows) {
      expect(STATES, r.id).toContain(r.state);
      expect(r.checkedAt, r.id).not.toBeNull();
      for (const v of keyish) expect(JSON.stringify(r)).not.toContain(v);
    }
    if (process.env.JAROD_COCKPIT_PRINT) for (const r of rows) console.log(`${r.id.padEnd(34)} ${r.state.padEnd(24)} ${r.version ?? ""}  ${r.detail}`);
  }, 60_000);
});
