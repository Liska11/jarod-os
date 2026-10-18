// Le lanceur de run_shell (sidecars/mxc-run) construit sa propre requête MXC : elle doit rester celle de `toMxcRequest`.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { toMxcRequest } from "../src/index.js";

const RUNNER = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), "sidecars", "mxc-run", "mxc_run.mjs");
const runner = (await import(pathToFileURL(RUNNER).href)) as {
  buildRequest(command: string, o: { workspace: string; cwd: string; timeoutSeconds: number; readonlyPaths?: string[]; deniedPaths?: string[] }): unknown;
  defaultDenied(home: string): string[];
};

describe("lanceur MXC de run_shell — même requête que toMxcRequest", () => {
  const policy = { workspace: "C:\\Zone\\travail", readonlyPaths: ["C:\\Windows", "C:\\Program Files\\nodejs"], deniedPaths: ["C:\\Users\\x\\.ssh"] };

  it("mêmes champs pour une même politique", () => {
    expect(runner.buildRequest("echo a", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 45, readonlyPaths: policy.readonlyPaths, deniedPaths: policy.deniedPaths })).toEqual(toMxcRequest("echo a", policy, 45));
  });

  it("mêmes bornes de délai et mêmes refus", () => {
    const big = runner.buildRequest("x", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 99999 }) as { timeoutMs: number };
    expect(big.timeoutMs).toBe(600_000);
    expect(() => runner.buildRequest("x", { workspace: "relatif", cwd: "relatif", timeoutSeconds: 1 })).toThrow();
    expect(() => runner.buildRequest("x", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 1, readonlyPaths: ["C:\\a\\..\\b"] })).toThrow();
    expect(() => runner.buildRequest("x", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 1, deniedPaths: [`${policy.workspace}\\`] })).toThrow(/aussi/);
    expect(() => runner.buildRequest(" ", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 1 })).toThrow(/vide/);
  });

  it("le réseau est toujours refusé et il n'existe aucune option pour l'ouvrir", () => {
    const r = runner.buildRequest("x", { workspace: policy.workspace, cwd: policy.workspace, timeoutSeconds: 1 }) as { network: unknown };
    expect(r.network).toEqual({ egress: { default: "deny" } });
  });

  it("les dossiers personnels sensibles sont interdits par défaut", () => {
    // Un dossier personnel de la machine qui exécute les tests : le lanceur assemble les chemins avec son séparateur.
    const home = resolve("x");
    expect(runner.defaultDenied(home)).toEqual(expect.arrayContaining([join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg")]));
  });
});
