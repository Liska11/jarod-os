// G10 — smolvm 1.30.1 RÉEL : une machine de test À PART (`jarod-test`), supprimée à la fin. Préparée une fois (téléchargement de l'image,
// accord de l'utilisateur), puis : réseau coupé, dossier de travail en lecture seule puis en écriture, code de retour, délai, suppression.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linuxOperation, linuxTools, smolvmBinary } from "../../src/index.js";
import { ROOT } from "./helpers.js";

describe("G10 — opérations de règle et refus (pur)", () => {
  it("réseau et écriture dans le dossier de travail sont des opérations à part (réservées)", () => {
    expect(linuxOperation({})).toBe("run");
    expect(linuxOperation({ workspace: "ro" })).toBe("run.workspace-ro");
    expect(linuxOperation({ workspace: "rw" })).toBe("run.workspace-rw");
    expect(linuxOperation({ network: true, workspace: "rw" })).toBe("run.network+workspace-rw");
    const [, run] = linuxTools({ bin: () => "x", internet: () => true });
    expect(Object.keys(run!.restrictedOperations!)).toEqual(["run.network", "run.workspace-rw", "run.network+workspace-rw", "run.network+workspace-ro"]);
  });

  it("refus avant tout lancement : Internet coupé pour Jarod, image invalide, dossier absent", () => {
    let internet = false;
    const [prepare, run] = linuxTools({ bin: () => "x", internet: () => internet });
    expect(() => prepare!.precheck!({}, { workspace: null })).toThrow(/Internet est coupé/);
    expect(() => run!.precheck!({ command: "id", network: true }, { workspace: null })).toThrow(/Internet est coupé/);
    expect(run!.precheck!({ command: "id" }, { workspace: null })).toMatch(/réseau coupé/);
    internet = true;
    expect(() => prepare!.precheck!({ image: "../../etc" }, { workspace: null })).toThrow(/image invalide/);
    expect(() => run!.precheck!({ command: "ls", workspace: "ro" }, { workspace: null })).toThrow(/aucun dossier de travail/);
  });
});

const BIN = smolvmBinary({ JAROD_SMOLVM: join(ROOT, "engines", "smolvm", "smolvm.exe") });
if (process.platform === "win32" && !BIN) console.warn("[moteurs] smolvm absent : le banc G10 est ignoré");

describe.skipIf(process.platform !== "win32" || !BIN)("G10 — machine Linux réelle (smolvm), machine de test", () => {
  const [prepare, run, reset] = linuxTools({ bin: () => BIN, name: "jarod-test", internet: () => true });
  const ws = mkdtempSync(join(tmpdir(), "jarod-g10-"));
  const ctx = { sessionId: "banc-g10", workspace: ws };

  beforeAll(async () => {
    writeFileSync(join(ws, "lisible.txt"), "contenu de l'hôte");
    expect(await prepare!.run({ image: "alpine" }, ctx)).toMatch(/Machine Linux prête \(alpine\).*réseau coupé/);
  }, 600_000);

  afterAll(async () => {
    await reset!.run({}, ctx);
    rmSync(ws, { recursive: true, force: true });
  }, 300_000);

  it("une commande sans réseau : noyau Linux, aucune sortie réseau, état conservé d'un appel à l'autre", async () => {
    const out = await run!.run({ command: "uname -s; wget -q -T 3 -O- http://example.com >/dev/null 2>&1 && echo RESEAU-OUVERT || echo RESEAU-FERME; echo garde > /root/marque" }, ctx);
    expect(out).toMatch(/Code de retour : 0\./);
    expect(out).toContain("Linux");
    expect(out).toContain("RESEAU-FERME");
    expect(await run!.run({ command: "cat /root/marque" }, ctx)).toContain("garde");
  }, 300_000);

  it("dossier de travail en lecture seule : lu, écriture refusée ; en écriture : le fichier arrive sur l'hôte", async () => {
    const ro = await run!.run({ command: "cat lisible.txt; echo x > ecrit.txt && echo ECRIT || echo REFUSE", workspace: "ro" }, ctx);
    expect(ro).toContain("contenu de l'hôte");
    expect(ro).toContain("REFUSE");
    expect(existsSync(join(ws, "ecrit.txt"))).toBe(false);
    await run!.run({ command: "echo depuis-linux > ecrit.txt", workspace: "rw" }, ctx);
    expect(readFileSync(join(ws, "ecrit.txt"), "utf8").trim()).toBe("depuis-linux");
    // Sans partage, plus rien de l'hôte n'est visible.
    expect(await run!.run({ command: "ls /work 2>&1 || echo ABSENT" }, ctx)).not.toContain("lisible.txt");
  }, 300_000);

  it("code de retour transmis ; une commande trop longue est arrêtée au délai", async () => {
    expect(await run!.run({ command: "exit 3" }, ctx)).toMatch(/Code de retour : 3\./);
    const t = Date.now();
    const slow = await run!.run({ command: "sleep 60", timeoutSec: 3 }, ctx);
    expect(Date.now() - t).toBeLessThan(45_000);
    expect(slow).not.toMatch(/Code de retour : 0\./);
  }, 300_000);
});
