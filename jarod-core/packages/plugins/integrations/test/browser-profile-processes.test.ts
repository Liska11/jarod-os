// E2 — arrêt des processus d'un profil jetable PAR LE PROFIL, pas par un numéro de processus. Mesuré le 2026-10-18 : le numéro noté au lancement
// (`chromePid`) était mort alors que le vrai navigateur (relancé sous un autre numéro) tournait encore ; `close()` et le balayage ne l'arrêtaient
// donc pas, le profil restait verrouillé et chaque balayage y perdait plusieurs secondes. Seuls les processus dont la ligne de commande contient
// CE dossier sont arrêtés ; un processus étranger, même au nom voisin, survit.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killProfileProcesses } from "../src/index.js";

const made: string[] = [];
const procs: number[] = [];
afterEach(() => {
  for (const pid of procs.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* déjà parti */
    }
  }
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Un faux « navigateur » : un Node qui attend, avec le dossier dans sa ligne de commande (comme `--user-data-dir=<profil>\chrome`). */
function fakeBrowser(arg: string): number {
  const p = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "--", `--user-data-dir=${arg}`], { stdio: "ignore", windowsHide: true });
  procs.push(p.pid!);
  return p.pid!;
}

describe("killProfileProcesses", () => {
  it("arrête les processus qui portent CE profil, et eux seuls", async () => {
    const profile = mkdtempSync(join(tmpdir(), "jarod-e2-"));
    const voisin = mkdtempSync(join(tmpdir(), "jarod-e2-"));
    made.push(profile, voisin);
    const ours = fakeBrowser(join(profile, "chrome"));
    const stranger = fakeBrowser(join(voisin, "chrome"));
    await new Promise((r) => setTimeout(r, 500));

    expect(killProfileProcesses(profile)).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(ours)).toBe(false);
    expect(alive(stranger)).toBe(true);
  }, 30_000);

  it("ne fait rien hors d'un profil jetable", () => {
    expect(killProfileProcesses(tmpdir())).toBe(0);
    expect(killProfileProcesses(join(tmpdir(), "autre-dossier"))).toBe(0);
  });
});
