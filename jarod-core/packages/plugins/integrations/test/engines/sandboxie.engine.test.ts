// G15 — Sandboxie-Plus RÉEL (installé par l'utilisateur, 1.18.8) : un bac de test À PART (`JarodTest`), vidé et retiré de la configuration à
// la fin. Ce qu'un programme écrit reste dans le bac ; le réseau du bac est coupé par défaut (témoin LOCAL : aucune requête) et ouvert sur
// demande ; le code de retour du programme est rendu ; vider le bac le vide. Le vrai profil n'est jamais modifié (vérifié).
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { networkClosed, readBoxSection, realPathOf, SandboxieBox, sandboxieDir, sandboxTools } from "../../src/index.js";

describe("G15 — lecture de la configuration et des chemins (pur)", () => {
  it("une entrée du bac nomme le chemin réel qu'elle remplace", () => {
    expect(realPathOf("drive\\C\\Outils\\a.txt", "C:\\Users\\X")).toBe("C:\\Outils\\a.txt");
    expect(realPathOf("user\\current\\Documents\\b.txt", "C:\\Users\\X")).toBe(join("C:\\Users\\X", "Documents", "b.txt"));
    expect(realPathOf("RegHive", "C:\\Users\\X")).toBeNull();
  });

  it("la section d'un bac, et un réseau coupé SANS exception", () => {
    const ini = "\uFEFF# x\r\n[GlobalSettings]\r\nTemplate=A\r\n\r\n[JarodTest]\r\nEnabled=y\r\nClosedFilePath=InternetAccessDevices\r\n[Autre]\r\nX=1\r\n";
    const s = readBoxSection(ini, "jarodtest");
    expect(s).toEqual(["Enabled=y", "ClosedFilePath=InternetAccessDevices"]);
    expect(networkClosed(s)).toBe(true);
    // Ce que l'interface de Sandboxie-Plus avait écrit : un blocage AVEC une exception (curl) — ce n'est pas un réseau coupé.
    expect(networkClosed(["ProcessGroup=<InternetAccess>,*,curl.exe", "ClosedFilePath=!<InternetAccess>,InternetAccessDevices"])).toBe(false);
  });
});

const dir = process.platform === "win32" ? sandboxieDir() : null;
if (process.platform === "win32" && !dir) console.warn("[moteurs] Sandboxie-Plus absent : le banc G15 est ignoré");
const BOX = "JarodTest";

describe.skipIf(!dir)("G15 — Sandboxie-Plus réel, bac de test", () => {
  let witness: Server;
  let port = 0;
  let hits = 0;
  const scratch = join(tmpdir(), "jarod-sandbox-run-test");
  let internet = true;
  const [run, changes, discard] = sandboxTools({ dir: () => dir, box: BOX, internet: () => internet, scratch });
  const box = new SandboxieBox({ dir: dir!, box: BOX });
  const ctx = { sessionId: "banc-g15", workspace: null };
  const marker = join(process.env.USERPROFILE ?? "", `jarod-g15-banc-${process.pid}.txt`);

  beforeAll(async () => {
    witness = createServer((_q, r) => {
      hits++;
      r.end("ok");
    });
    await new Promise<void>((r) => witness.listen(0, "127.0.0.1", () => r()));
    port = (witness.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((r) => witness.close(r));
    await box.discard();
    await box.remove();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(marker, { force: true }); // n'existe pas si le bac a tenu ; retiré par précaution
  }, 120_000);

  it("ce qu'écrit le programme reste dans le bac (le vrai profil n'est pas touché) ; le code de retour est rendu", async () => {
    const out = await run!.run({ program: "cmd.exe", args: ["/c", `echo g15> ${marker}`] }, ctx);
    expect(existsSync(marker)).toBe(false);
    expect(out).toMatch(/Code de retour : 0\./);
    expect(out).toContain(marker);
    expect(await changes!.run({}, ctx)).toContain(marker);
    expect(await run!.run({ program: "cmd.exe", args: ["/c", "exit", "3"] }, ctx)).toMatch(/Code de retour : 3\./);
  }, 120_000);

  it("réseau coupé par défaut (aucune requête au témoin local) ; ouvert sur demande ; la configuration relue le confirme", async () => {
    hits = 0;
    const closed = await run!.run({ program: "curl.exe", args: ["-s", "-m", "4", `http://127.0.0.1:${port}/`] }, ctx);
    expect(hits).toBe(0);
    expect(closed).toMatch(/Réseau du bac : coupé/);
    expect(networkClosed(box.section())).toBe(true);
    const open = await run!.run({ program: "curl.exe", args: ["-s", "-m", "4", `http://127.0.0.1:${port}/`], network: true }, ctx);
    expect(hits).toBe(1);
    expect(open).toMatch(/Sortie :\nok/);
    expect(networkClosed(box.section())).toBe(false);
  }, 120_000);

  it("refus avant tout lancement : caractère qui changerait la ligne de commande ; réseau demandé quand Internet est coupé pour Jarod", () => {
    expect(() => run!.precheck!({ program: "cmd.exe", args: ["/c", "echo a & calc"] })).toThrow(/caractère refusé/);
    expect(() => run!.precheck!({ program: "x.exe", args: ["%USERPROFILE%"] })).toThrow(/caractère refusé/);
    internet = false;
    expect(() => run!.precheck!({ program: "curl.exe", network: true })).toThrow(/Internet est coupé/);
    expect(run!.precheck!({ program: "curl.exe" })).toMatch(/réseau coupé/);
    internet = true;
  });

  it("vider le bac le vide ; le vrai disque n'a jamais été touché", async () => {
    expect(await discard!.run({}, ctx)).toMatch(/Bac vidé : \d+ fichier/);
    expect(await changes!.run({}, ctx)).toBe("Le bac est vide.");
    expect(existsSync(marker)).toBe(false);
  }, 120_000);
});
