/**
 * Les scripts et les paramètres envoyés à un exécuteur SIMULÉ. Aucun test ne pilote Hyper-V : voir l'en-tête de
 * `hyperv.ts` pour ce que cela prouve et ce que cela ne prouve pas.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HyperVError, HyperVService, type PsExecutor, SCRIPTS } from "../src/index.js";

const made: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-hv-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fake(code = 0, stdout = "") {
  const calls: { script: string; params: Record<string, unknown> }[] = [];
  const exec: PsExecutor = async (script, params) => {
    calls.push({ script, params });
    return { code, stdout, stderr: code ? "refusé par Hyper-V" : "" };
  };
  return { calls, exec };
}

describe("plugin-hyperv", () => {
  it("aucune donnée de l'appelant n'est collée dans un script : elles voyagent en paramètres", async () => {
    const root = temp();
    const { calls, exec } = fake();
    const svc = new HyperVService({ root, exec });

    await svc.checkpoint("jarod-box1", "avant-test");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.script).toBe(SCRIPTS.checkpoint);
    expect(calls[0]!.script).not.toContain("jarod-box1");
    expect(calls[0]!.script).not.toContain("avant-test");
    expect(calls[0]!.params).toEqual({ vm: "jarod-box1", checkpoint: "avant-test" });
  });

  it("refuse tout nom qui n'est pas « jarod-… » ou qui tente une injection, sans appeler PowerShell", async () => {
    const { calls, exec } = fake();
    const svc = new HyperVService({ root: temp(), exec });

    for (const bad of ["MaVMPerso", "jarod-", "jarod-X", "jarod-a; Remove-VM *", "jarod-a'b", "jarod-a b", "../jarod-a", ""]) {
      await expect(svc.start(bad)).rejects.toThrow(HyperVError);
      await expect(svc.remove(bad)).rejects.toThrow(HyperVError);
    }
    await expect(svc.checkpoint("jarod-a", "x'; Stop-Computer; '")).rejects.toThrow(HyperVError);
    expect(calls).toHaveLength(0);
  });

  it("chaque script qui vise une machine revérifie le préfixe côté PowerShell", () => {
    for (const key of ["newVm", "start", "stop", "checkpoint", "rollback", "remove"] as const) {
      expect(SCRIPTS[key]).toContain("StartsWith('jarod-')");
    }
    expect(SCRIPTS.newSwitch).toContain("StartsWith('jarod-')");
  });

  it("le réseau créé est de type Private (ni hôte ni extérieur)", async () => {
    const { calls, exec } = fake();
    await new HyperVService({ root: temp(), exec }).createIsolatedNetwork("jarod-net");
    expect(calls[0]!.script).toContain("-SwitchType Private");
    expect(calls[0]!.script).not.toMatch(/External|Internal/);
  });

  it("les disques restent sous la racine gérée, en .vhdx simple", async () => {
    const root = temp();
    const { calls, exec } = fake();
    const svc = new HyperVService({ root, exec });
    writeFileSync(join(root, "modele.vhdx"), "x");

    await expect(svc.createDifferencing(join(root, "modele.vhdx"), join(tmpdir(), "dehors.vhdx"))).rejects.toThrow(/hors de la racine/);
    await expect(svc.createDifferencing(join(root, "modele.vhdx"), join(root, "enfant.vhd"))).rejects.toThrow(/nom de disque/);
    await expect(svc.createDifferencing(join(root, "modele.vhdx"), join(root, "..", "x.vhdx"))).rejects.toThrow(/hors de la racine/);
    await expect(svc.createDifferencing(join(root, "modele.vhdx"), join(root, "modele.vhdx"))).rejects.toThrow(/propre parent/);
    expect(calls).toHaveLength(0);

    const path = await svc.createDifferencing(join(root, "modele.vhdx"), join(root, "enfant.vhdx"));
    expect(calls[0]!.params).toMatchObject({ path });
    expect(calls[0]!.script).toContain("-Differencing");
  });

  it("un différentiel existant n'est pas écrasé, un modèle absent est signalé", async () => {
    const root = temp();
    const { calls, exec } = fake();
    const svc = new HyperVService({ root, exec });
    writeFileSync(join(root, "modele.vhdx"), "x");
    writeFileSync(join(root, "enfant.vhdx"), "x");

    await expect(svc.createDifferencing(join(root, "modele.vhdx"), join(root, "enfant.vhdx"))).rejects.toThrow(/existe déjà/);
    await expect(svc.registerTemplate(join(root, "absent.vhdx"))).rejects.toThrow(/introuvable/);
    expect(calls).toHaveLength(0);
  });

  it("une machine : mémoire bornée, disque et réseau validés, intégration invité coupée", async () => {
    const root = temp();
    const { calls, exec } = fake();
    const svc = new HyperVService({ root, exec });

    await expect(svc.createVm({ name: "jarod-a", disk: join(root, "d.vhdx"), network: "jarod-net", memoryMb: 100 })).rejects.toThrow(/mémoire/);
    await expect(svc.createVm({ name: "jarod-a", disk: join(root, "d.vhdx"), network: "Default Switch" })).rejects.toThrow(HyperVError);

    await svc.createVm({ name: "jarod-a", disk: join(root, "d.vhdx"), network: "jarod-net", memoryMb: 1024 });
    expect(calls[0]!.params).toMatchObject({ vm: "jarod-a", switch: "jarod-net", memoryBytes: 1024 * 1024 * 1024 });
    expect(calls[0]!.script).toContain("Disable-VMIntegrationService");
    expect(calls[0]!.script).toContain("-AutomaticCheckpointsEnabled $false");
  });

  it("le retour arrière restaure le point de contrôle nommé, sans confirmation interactive", async () => {
    const { calls, exec } = fake();
    await new HyperVService({ root: temp(), exec }).rollback("jarod-a", "propre");
    expect(calls[0]!.script).toContain("Restore-VMSnapshot");
    expect(calls[0]!.script).toContain("-Confirm:$false");
    expect(calls[0]!.params).toEqual({ vm: "jarod-a", checkpoint: "propre" });
  });

  it("un échec de PowerShell remonte comme une erreur, avec la raison, et est audité", async () => {
    const events: unknown[] = [];
    const { exec } = fake(1);
    const svc = new HyperVService({ root: temp(), exec, onEvent: (e) => events.push(e) });
    await expect(svc.start("jarod-a")).rejects.toThrow(/refusé par Hyper-V/);
    expect(events).toEqual([expect.objectContaining({ action: "start", detail: { ok: false, code: 1 } })]);
  });

  it("l'état dit la vérité : absent, non administrateur, ou prêt — et une réponse illisible n'est pas « prêt »", async () => {
    const root = temp();
    const status = async (stdout: string, code = 0) => new HyperVService({ root, exec: fake(code, stdout).exec }).status();

    expect((await status('{"cmdlets":false,"admin":false}')).detail).toMatch(/absentes/);
    expect((await status('{"cmdlets":true,"admin":false}')).detail).toMatch(/pas administrateur/);
    expect(await status('{"cmdlets":true,"admin":true}')).toMatchObject({ cmdlets: true, admin: true, detail: "prêt" });
    expect(await status("n'importe quoi")).toMatchObject({ cmdlets: false, admin: false });
    expect(await status("", 1)).toMatchObject({ cmdlets: false, admin: false });
  });

  const onWindows = process.platform === "win32" ? it : it.skip;

  onWindows("chaque script est du PowerShell valide (analysé, jamais exécuté)", () => {
    for (const [key, script] of Object.entries(SCRIPTS)) {
      const parsed = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "[void][scriptblock]::Create($env:JAROD_SCRIPT)"],
        { env: { ...process.env, JAROD_SCRIPT: script }, encoding: "utf8" },
      );
      expect(parsed.status, `${key}: ${parsed.stderr}`).toBe(0);
    }
    // Un PowerShell démarré PAR script : plus de 30 s sur un runner Windows chargé.
  }, 120_000);

  onWindows("la sonde réelle répond sans droits particuliers et ne modifie rien", async () => {
    const status = await new HyperVService({ root: temp() }).status();
    expect(typeof status.cmdlets).toBe("boolean");
    expect(typeof status.admin).toBe("boolean");
  });
});
