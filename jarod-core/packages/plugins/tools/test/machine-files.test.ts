// Accès à tous les lecteurs (analyse du 30/10) : avec `machineFiles`, un chemin absolu hors du dossier de travail est accepté, sauf dans un
// emplacement protégé ; sans, le confinement d'avant reste exactement le même. Un chemin relatif reste toujours dans le dossier de travail.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInWorkspace } from "../src/builtin.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-mf-"));
  dirs.push(d);
  return d;
};

describe("resolveInWorkspace et machineFiles", () => {
  it("sans le réglage : un chemin absolu hors du dossier de travail est refusé (comportement d'avant)", () => {
    const ws = temp();
    const other = temp();
    expect(() => resolveInWorkspace({ sessionId: "s", workspace: ws }, join(other, "a.txt"))).toThrow(/hors du dossier de travail/);
  });

  it("avec le réglage : un autre dossier (un autre lecteur) est accepté", () => {
    const ws = temp();
    const other = temp();
    expect(resolveInWorkspace({ sessionId: "s", workspace: ws, machineFiles: true }, join(other, "a.txt"))).toBe(resolve(other, "a.txt"));
  });

  it("avec le réglage, sans dossier de travail : un chemin absolu suffit", () => {
    const other = temp();
    expect(resolveInWorkspace({ sessionId: "s", workspace: null, machineFiles: true }, other)).toBe(resolve(other));
  });

  it("un chemin relatif reste dans le dossier de travail", () => {
    const ws = temp();
    expect(resolveInWorkspace({ sessionId: "s", workspace: ws, machineFiles: true }, "notes.txt")).toBe(resolve(ws, "notes.txt"));
    expect(() => resolveInWorkspace({ sessionId: "s", workspace: ws, machineFiles: true }, "..\\..\\x")).toThrow(/hors du dossier de travail/);
  });

  it("les emplacements protégés restent refusés", () => {
    expect(() => resolveInWorkspace({ sessionId: "s", workspace: null, machineFiles: true }, join(homedir(), ".ssh", "id_rsa"))).toThrow(/emplacement protégé/);
    const sys = process.env.SystemRoot;
    if (sys) expect(() => resolveInWorkspace({ sessionId: "s", workspace: null, machineFiles: true }, join(sys, "System32"))).toThrow(/emplacement protégé/);
  });
});
