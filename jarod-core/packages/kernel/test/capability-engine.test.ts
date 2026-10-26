/**
 * Moteur de capacités : radar sur un dépôt réel, quarantaine, analyse, exécution contrôlée,
 * intégration réversible. Porté des cas prouvés dans la reconstruction (T42-T47).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyRegistry,
  evaluate,
  fiche,
  integrate,
  loadRegistry,
  quarantineCopy,
  remove,
  rollback,
  saveRegistry,
  scanSource,
  setActive,
  setStatus,
  staticAnalysis,
  treeDigest,
} from "../src/capability-engine.js";

let root = "";
const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: "cap-demo", name: "Capacité de démonstration", version: "1.0.0", type: "skill", description: "résumé", problem: "rien", benefit: "peu", permissions: ["tools"], entry: "index.mjs", ...over }, null, 2);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jarod-cap-test-"));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function gitRepo(): string {
  const dir = join(root, "src-repo");
  mkdirSync(dir, { recursive: true });
  const g = (...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "test@jarod.local");
  g("config", "user.name", "Jarod Test");
  writeFileSync(join(dir, "capability.json"), manifest({ version: "1.0.0" }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# 1.0.0\n\n- première version\n");
  g("add", "-A");
  g("commit", "-q", "-m", "v1.0.0");
  g("tag", "v1.0.0");
  writeFileSync(join(dir, "capability.json"), manifest({ version: "1.1.0", benefit: "double la vitesse" }));
  writeFileSync(join(dir, "CHANGELOG.md"), "# 1.1.0\n\n- accélère la recherche\n");
  g("add", "-A");
  g("commit", "-q", "-m", "v1.1.0");
  g("tag", "v1.1.0");
  return dir;
}

describe("radar", () => {
  it("détecte les versions d'un dépôt local, lit manifeste et changelog, et ne signale qu'une fois", () => {
    const repo = gitRepo();
    const registry = emptyRegistry();
    const scan = scanSource({ id: "test-repo", kind: "git", path: repo }, registry);
    expect(scan.found).toHaveLength(2);
    expect(scan.found[0]!.version).toBe("1.1.0");
    expect(scan.found[0]!.manifest?.version).toBe("1.1.0");
    expect(scan.found[0]!.changelog).toContain("accélère la recherche");
    const f = fiche(scan.found[0]!);
    for (const key of ["name", "source", "version", "type", "problem", "benefit", "windows", "prerequisites", "risks", "cost", "tests", "recommendation"] as const) {
      expect(f[key], `champ ${key}`).toBeDefined();
    }
    expect(f.windows.ok).toBe(true);
    // une version vue n'est plus annoncée
    registry.sources["test-repo"] = { lastScanAt: new Date().toISOString(), lastVersion: "1.1.0", versions: ["1.1.0", "1.0.0"] };
    expect(scanSource({ id: "test-repo", kind: "git", path: repo }, registry).found).toHaveLength(0);
  });

  it("refuse une source http (non prouvée hors ligne) et un dossier absent", () => {
    expect(() => scanSource({ id: "x", kind: "http", url: "https://exemple" }, emptyRegistry())).toThrow(/http non prouvé/);
    expect(() => scanSource({ id: "y", kind: "git", path: join(root, "absent") }, emptyRegistry())).toThrow(/introuvable/);
  });
});

describe("évaluation", () => {
  function component(over: Record<string, unknown> = {}, file = "console.log('ok: demo');\n"): string {
    const dir = join(root, `comp-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "capability.json"), manifest(over));
    writeFileSync(join(dir, "index.mjs"), file);
    return dir;
  }

  it("copie en quarantaine, calcule l'empreinte et exécute sous contrôle (réseau coupé)", () => {
    const dir = component();
    const report = evaluate(dir, { quarantineRoot: join(root, "quarantine"), id: "cap-bening" });
    expect(report.quarantine.files).toBeGreaterThanOrEqual(2);
    expect(report.quarantine.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.analysis.type).toBe("skill");
    expect(report.sandbox.ran).toBe(true);
    expect(report.sandbox.exitCode).toBe(0);
    expect(String(report.sandbox.stdout)).toContain("ok: demo");
    expect(report.verdict).toBe("safe");
    expect(report.signature.present).toBe(false);
  });

  it("refuse un composant dangereux (processus enfant) et n'écrit aucun artefact", () => {
    const dir = component({ id: "cap-danger", name: "Danger" }, "const { execSync } = require('node:child_process');\nconsole.log(execSync('whoami').toString());\n");
    const report = evaluate(dir, { quarantineRoot: join(root, "quarantine"), id: "cap-danger" });
    expect(report.verdict).toBe("dangerous");
    expect(report.why).toContain("child-process");
    const registry = emptyRegistry();
    expect(() => integrate(registry, report, { kind: "skill", targetRoot: join(root, "store"), approve: true })).toThrow(/dangereux/);
    expect(existsSync(join(root, "store", "skills", "cap-danger"))).toBe(false);
  });
});

describe("intégration réversible", () => {
  it("exige un accord, écrit l'artefact, persiste le registre, puis s'annule", () => {
    const dir = join(root, "comp-integration");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "capability.json"), manifest({ version: "2.0.0" }));
    writeFileSync(join(dir, "index.mjs"), "console.log('ok');\n");
    writeFileSync(join(dir, "SKILL.md"), "# Capacité\n");
    const report = evaluate(dir, { quarantineRoot: join(root, "quarantine"), id: "cap-integration" });
    const registry = emptyRegistry();
    expect(() => integrate(registry, report, { kind: "skill", targetRoot: join(root, "store") })).toThrow(/accord explicite/);
    const entry = integrate(registry, report, { kind: "skill", targetRoot: join(root, "store"), approve: true });
    const artifact = join(root, "store", "skills", "cap-integration");
    expect(entry.status).toBe("active");
    expect(entry.hash).toBe(report.quarantine.treeSha256);
    expect(existsSync(join(artifact, "integration.json"))).toBe(true);
    const registryFile = join(root, "state", "registry.json");
    saveRegistry(registryFile, registry);
    expect(loadRegistry(registryFile).capabilities["cap-integration"]?.status).toBe("active");
    // désactiver puis réactiver
    expect(setActive(registry, "cap-integration", false).status).toBe("disabled");
    expect(setActive(registry, "cap-integration", true).status).toBe("active");
    // retour arrière : fichiers retirés, statut dit
    const r = rollback(registry, "cap-integration");
    expect(r.removed).toBeGreaterThanOrEqual(3);
    expect(existsSync(artifact)).toBe(false);
    expect(registry.capabilities["cap-integration"]?.status).toBe("rolled_back");
    expect(registry.capabilities["cap-integration"]?.artifact).toBeFalsy();
  });

  it("supprime définitivement une intégration et son entrée", () => {
    const dir = join(root, "comp-remove");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "capability.json"), manifest({ id: "cap-remove" }));
    writeFileSync(join(dir, "index.mjs"), "console.log('ok');\n");
    const report = evaluate(dir, { quarantineRoot: join(root, "quarantine"), id: "cap-remove" });
    const registry = emptyRegistry();
    integrate(registry, report, { kind: "skill", targetRoot: join(root, "store"), approve: true });
    const removed = remove(registry, "cap-remove");
    expect(removed.removed).toBeGreaterThanOrEqual(2);
    expect(registry.capabilities["cap-remove"]).toBeUndefined();
  });

  it("enregistre les transitions et refuse un statut inconnu", () => {
    const registry = emptyRegistry();
    for (const s of ["detected", "analyzed", "proposed", "approved"] as const) setStatus(registry, "cap-cycle", s);
    const cycle = registry.capabilities["cap-cycle"]!;
    expect(cycle.status).toBe("approved");
    expect(cycle.history).toHaveLength(4);
    expect(() => setStatus(registry, "cap-cycle", "actif" as never)).toThrow(/statut inconnu/);
  });
});

describe("outils bas niveau", () => {
  it("quarantaine et empreintes sont stables pour un même contenu", () => {
    const a = join(root, "same-a");
    const b = join(root, "same-b");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "x.txt"), "même contenu");
    const q1 = quarantineCopy(a, join(root, "q1"));
    const q2 = quarantineCopy(a, join(root, "q2"));
    expect(q1.treeSha256).toBe(q2.treeSha256);
    expect(treeDigest(a)).toBe(q1.treeSha256);
    expect(staticAnalysis(q1.root).files).toBe(1);
    expect(readFileSync(join(q1.root, "x.txt"), "utf8")).toBe("même contenu");
    void b;
  });
});
