// La garde d'isolation des tests (scripts/test-isolation.mjs) : une suite n'ouvre ni port fixe, ni port réel de Jarod-OS, ni dossier réel de l'utilisateur.
// Les fonctions de décision se testent toujours ; la preuve « en vrai » (la garde est armée dans CE processus et refuse) ne tourne que sous le lanceur
// `scripts/test-report.mjs`, qui l'arme — sans lui ce fichier le dit au lieu de faire semblant.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore — module .mjs du dossier scripts, sans déclaration de types
import { LIVE_PORTS, pathIsProtected, portIsLive } from "../../../scripts/test-isolation.mjs";

const armed = process.env.JAROD_GUARD_ACTIVE === "1";

/** Une tentative VOLONTAIRE : la garde la refuse et la note « canari », pas « violation ». */
function canary<T>(fn: () => T): T {
  const g = globalThis as { __jarodGuardCanary?: boolean };
  g.__jarodGuardCanary = true;
  try {
    return fn();
  } finally {
    g.__jarodGuardCanary = false;
  }
}

describe("décisions de la garde", () => {
  it("un chemin est protégé s'il est DANS un dossier réel (casse et séparateurs indifférents), pas s'il lui ressemble", () => {
    const roots = ["D:\\Jarod-OS", "C:\\Program Files\\Jarod-OS"];
    expect(pathIsProtected("D:\\Jarod-OS\\data\\profile\\SOUL.md", roots)).toBe(true);
    expect(pathIsProtected("d:/jarod-os", roots)).toBe(true);
    expect(pathIsProtected("D:\\Jarod-OS-copie\\x", roots)).toBe(false);
    expect(pathIsProtected(join(tmpdir(), "x"), roots)).toBe(false);
  });

  it("les ports réels de Jarod-OS sont connus (moteur 8080, vision 8792, voix 8790, passerelle WhatsApp 8791)", () => {
    for (const p of [8080, 8792, 8790, 8791]) expect(portIsLive(p)).toBe(true);
    expect(portIsLive(54321)).toBe(false);
    expect(LIVE_PORTS.length).toBeGreaterThan(8);
  });
});

describe.runIf(armed)("la garde est ARMÉE dans ce processus de test (sous le lanceur)", () => {
  it("le domicile est un dossier temporaire, pas celui de l'utilisateur", () => {
    expect(homedir().toLowerCase()).toContain("jarod-test-report");
    expect(process.env.APPDATA?.toLowerCase()).toContain("jarod-test-report");
  });

  it("lire ou écrire dans le profil réel est refusé", () => {
    expect(() => canary(() => readFileSync("D:\\Jarod-OS\\data\\profile\\profiles\\default\\SOUL.md"))).toThrow(/isolation des tests/);
    expect(() => canary(() => writeFileSync("D:\\Jarod-OS\\data\\x.txt", "x"))).toThrow(/isolation des tests/);
    expect(() => canary(() => readdirSync("C:\\Program Files\\Jarod-OS"))).toThrow(/isolation des tests/);
    expect(typeof existsSync("C:\\Program Files\\Jarod-OS\\resources")).toBe("boolean"); // une sonde d'existence (PATH) n'est ni lue ni refusée : journalisée à part
  });

  it("écouter sur un port fixe est refusé ; un port aléatoire (0) est permis", async () => {
    expect(() => canary(() => createServer().listen(8080))).toThrow(/port fixe/);
    expect(() => canary(() => createServer().listen({ port: 8792, host: "127.0.0.1" }))).toThrow(/port fixe/);
    await new Promise<void>((done, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        expect(portIsLive(port)).toBe(false);
        s.close(() => done());
      });
    });
  });

  it("se connecter au moteur réel (127.0.0.1:8080) ou à la vision (8792) est refusé", () => {
    expect(() => canary(() => connect(8080, "127.0.0.1"))).toThrow(/port réel/);
    expect(() => canary(() => connect({ port: 8792, host: "localhost" }))).toThrow(/port réel/);
  });

  it("un fichier dans le dossier temporaire reste permis", () => {
    const f = join(tmpdir(), `iso-${process.pid}.txt`);
    writeFileSync(f, "ok");
    expect(readFileSync(f, "utf8")).toBe("ok");
  });
});

describe.skipIf(armed)("sans le lanceur", () => {
  it("la garde n'est pas armée : lancer `node scripts/test-report.mjs fast --only kernel` pour la preuve en vrai", () => {
    expect(armed).toBe(false);
  });
});
