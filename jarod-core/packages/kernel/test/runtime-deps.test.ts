/**
 * Dépendances d'exécution : inventaire réel, politiques, proposition, bascule portable réversible,
 * refus d'une bascule système sans compatibilité vérifiée. Porté des cas prouvés (T49-T52).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPortable,
  applySystem,
  COMPONENTS,
  digestTrees,
  emptyState,
  inventory,
  loadState,
  propose,
  rollbackPortable,
  saveState,
  setPolicy,
} from "../src/runtime-deps.js";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jarod-deps-test-"));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("inventaire", () => {
  it("détecte les versions installées, tous les candidats du PATH, et les absents", () => {
    const inv = inventory();
    const by = Object.fromEntries(inv.components.map((c) => [c.id, c]));
    for (const id of ["node", "npm", "git", "python", "docker", "ollama"]) {
      expect(by[id], `composant ${id}`).toBeDefined();
      expect(by[id]!.installed, `${id} installé : ${by[id]!.error ?? ""}`).toBe(true);
      expect(by[id]!.version, `${id} version`).toBeTruthy();
    }
    expect(inv.components).toHaveLength(COMPONENTS.length);
    // pnpm : au moins deux candidats, le résolu marqué, un candidat de l'utilisateur
    const pnpm = by.pnpm;
    expect(pnpm!.candidates.length).toBeGreaterThanOrEqual(2);
    expect(pnpm!.candidates[0]!.resolved).toBe(true);
    expect(pnpm!.candidates.some((c) => c.user)).toBe(true);
  });
});

describe("politique et proposition", () => {
  it("signale un composant critique, une donnée manquante, et refuse une politique inconnue", () => {
    const state = emptyState();
    setPolicy(state, "node", "notify", { current: "1.0.0", available: "2.0.0", compatibility: "unverified" });
    const proposal = propose(state, "node");
    expect(proposal.risk).toBe("critical");
    expect(proposal.updatePossible).toBe(true);
    expect(proposal.rollback.possible).toBe(false);
    expect(proposal.tests.length).toBeGreaterThanOrEqual(3);
    const unknown = propose(state, "restic");
    expect(unknown.available).toBeNull();
    expect(unknown.missing).toHaveLength(1);
    expect(unknown.recommendation).toMatch(/sans connaître la version disponible/);
    expect(() => setPolicy(state, "node", "auto-parfois" as never)).toThrow(/politique inconnue/);
  });

  it("persiste l'état des politiques", () => {
    const file = join(root, "runtime-policies.json");
    const state = emptyState();
    setPolicy(state, "git", "auto-safe", { compatibility: "verified" });
    saveState(file, state);
    expect(loadState(file).components.git?.policy).toBe("auto-safe");
  });
});

describe("bascule portable", () => {
  function portable(): { engines: string; v2: string; original: string } {
    const engines = join(root, `engines-${Math.random().toString(36).slice(2, 7)}`);
    const target = join(engines, "fx-portable");
    const v2 = join(root, `new-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "version.txt"), "1.0.0");
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, "version.txt"), "2.0.0");
    return { engines, v2, original: digestTrees(target) };
  }

  it("exige un accord, conserve l'ancienne version, vérifie la nouvelle, restaure à l'identique", () => {
    const { engines, v2, original } = portable();
    const state = emptyState();
    const target = join(engines, "fx-portable");
    expect(() => applyPortable(state, "fx-portable", { newDir: v2, enginesRoot: engines })).toThrow(/accord explicite/);
    expect(digestTrees(target)).toBe(original);
    const applied = applyPortable(state, "fx-portable", {
      newDir: v2,
      enginesRoot: engines,
      approve: true,
      verify: (dir) => ({ ok: readFileSync(join(dir, "version.txt"), "utf8") === "2.0.0", detail: "version.txt = 2.0.0" }),
    });
    expect(applied.applied).toBe(true);
    expect(applied.verified.ok).toBe(true);
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("2.0.0");
    expect(applied.previousTreeSha256).toBe(original);
    const rolled = rollbackPortable(state, "fx-portable", { enginesRoot: engines, approve: true });
    expect(rolled.restoredTreeSha256).toBe(original);
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("1.0.0");
    expect(digestTrees(target)).toBe(original);
    expect(state.components["fx-portable"]?.history?.filter((h) => h.action === "apply" || h.action === "rollback")).toHaveLength(2);
  });

  it("trouve la version prête dans engines/<id>.next quand aucun chemin n'est donné", () => {
    const { engines, v2 } = portable();
    const next = join(engines, "fx-portable.next");
    mkdirSync(next, { recursive: true });
    writeFileSync(join(next, "version.txt"), "2.0.0");
    const state = emptyState();
    const applied = applyPortable(state, "fx-portable", { enginesRoot: engines, approve: true });
    expect(applied.applied).toBe(true);
    expect(readFileSync(join(engines, "fx-portable", "version.txt"), "utf8")).toBe("2.0.0");
    void v2;
  });
});

describe("bascule système", () => {
  it("refuse sans compatibilité vérifiée, puis n'exécute rien (installation hors module)", () => {
    const state = emptyState();
    expect(() => applySystem(state, "node", { approve: true })).toThrow(/compatibilité non vérifiée/);
    setPolicy(state, "node", "auto-safe", { compatibility: "verified" });
    const r = applySystem(state, "node", { approve: true });
    expect(r.executed).toBe(false);
    expect(r.reason).toMatch(/non exécutée/);
    expect(() => applySystem(state, "node", { approve: false })).toThrow(/accord explicite/);
    expect(() => applySystem(state, "inconnu", { approve: true })).toThrow(/inconnu/);
  });
});
