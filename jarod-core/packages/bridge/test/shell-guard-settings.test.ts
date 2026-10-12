/**
 * SPECS-P5-UI-PARITE.md §3.2 — garde du shell (`shellGuard`) dans les réglages : la politique effective se lit, le durcir ne demande rien, tout
 * ce qui l'AFFAIBLIT passe par une boîte native qui liste les changements, et rien d'invalide n'est écrit. VRAI kernel, VRAIS handlers.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Eff = {
  writeScope: string;
  writableRoots: string[];
  allowedPrograms: string[];
  deniedPrograms: string[];
  askPrograms: string[];
  environment: string;
  docker: { image: string; network: boolean; memory: string; cpus: number };
};
const eff = async (call: (c: string, ...a: unknown[]) => unknown) => ((await call("get-jarod-settings")) as { shellGuard: Eff }).shellGuard;
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);

describe("garde du shell : lecture et durcissement", () => {
  it("lecture : la politique EFFECTIVE (défauts complétés), comme le garde la lit", async () => {
    const { call, app } = await setupKernel();
    expect(await eff(call)).toEqual({
      writeScope: "off", writableRoots: [], allowedPrograms: [], deniedPrograms: [], askPrograms: [], environment: "local",
      docker: { image: "node:22-bookworm", network: true, memory: "4g", cpus: 2 },
    });
    app.agent.settings.set("shellGuard", { writeScope: "workspace", deniedPrograms: ["curl"] });
    expect(await eff(call)).toMatchObject({ writeScope: "workspace", deniedPrograms: ["curl"], environment: "local" });
  });

  it("DURCIR ne demande rien : confinement, programmes refusés, accords, liste de permis, Docker, réseau coupé", async () => {
    const { call, app, confirms } = await setupKernel();
    await call("set-jarod-settings", { shellGuard: { writeScope: "workspace", deniedPrograms: ["curl", "wget"], askPrograms: ["git"], allowedPrograms: ["git", "node"], environment: "docker" } });
    expect(app.agent.settings.get("shellGuard")).toMatchObject({ writeScope: "workspace", deniedPrograms: ["curl", "wget"], askPrograms: ["git"], allowedPrograms: ["git", "node"], environment: "docker" });
    await call("set-jarod-settings", { shellGuard: { docker: { network: false, memory: "1g", cpus: 1 } } });
    expect(confirms).toHaveLength(0);
  });

  it("les listes sont nettoyées : espaces coupés, doublons retirés", async () => {
    const { call } = await setupKernel();
    await call("set-jarod-settings", { shellGuard: { deniedPrograms: [" curl ", "curl", "wget"] } });
    expect((await eff(call)).deniedPrograms).toEqual(["curl", "wget"]);
  });
});

describe("garde du shell : affaiblir", () => {
  it("AFFAIBLIR demande une boîte native qui LISTE chaque changement ; refusée, rien n'est écrit ; acceptée, c'est écrit", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    app.agent.settings.set("shellGuard", { writeScope: "workspace", environment: "docker", deniedPrograms: ["curl"], askPrograms: ["git"], allowedPrograms: ["git"], docker: { network: false } as never });
    const before = app.agent.settings.get("shellGuard");
    const weaker = { writeScope: "off", environment: "local", deniedPrograms: [], askPrograms: [], allowedPrograms: [], writableRoots: ["build"], docker: { network: true } };
    await rejects(() => call("set-jarod-settings", { shellGuard: weaker }), /refusé par l'utilisateur/);
    expect(app.agent.settings.get("shellGuard")).toEqual(before);
    const d = confirms[0]!.detail;
    for (const line of ["le confinement des écritures est retiré", "plus dans Docker", "écriture permise dans « build »", "tous les programmes redeviennent permis", "n'est plus refusé : curl", "ne demande plus d'accord : git", "accès au réseau"]) {
      expect(d, line).toContain(line);
    }
    expect(confirms[0]!.message).toMatch(/Affaiblir le garde/);
    await call("set-jarod-settings", { shellGuard: weaker });
    expect(app.agent.settings.get("shellGuard")).toMatchObject({ writeScope: "off", environment: "local", deniedPrograms: [], writableRoots: ["build"] });
  });

  it("changer l'image Docker (ce qui s'exécute) et ajouter un permis à une liste non vide demandent une boîte ; passer de « tous » à « git seul » DURCIT", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [true, true]);
    app.agent.settings.set("shellGuard", { environment: "docker", allowedPrograms: ["git"] });
    await call("set-jarod-settings", { shellGuard: { docker: { image: "python:3.13" } } });
    expect(confirms[0]!.detail).toContain("image Docker changée : python:3.13");
    await call("set-jarod-settings", { shellGuard: { allowedPrograms: ["git", "node"] } });
    expect(confirms[1]!.detail).toContain("programme permis en plus : node");
    app.agent.settings.set("shellGuard", {});
    await call("set-jarod-settings", { shellGuard: { allowedPrograms: ["git"] } });
    expect(confirms).toHaveLength(2);
  });

  it("un patch qui mêle durcissement et affaiblissement : la boîte ne liste QUE l'affaiblissement ; refusé, le durcissement n'est pas écrit non plus", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false]);
    app.agent.settings.set("shellGuard", { deniedPrograms: ["curl"] });
    await rejects(() => call("set-jarod-settings", { shellGuard: { deniedPrograms: [], askPrograms: ["git"] } }), /refusé/);
    expect(confirms[0]!.detail).toContain("n'est plus refusé : curl");
    expect(confirms[0]!.detail).not.toContain("git");
    expect(app.agent.settings.get("shellGuard")).toEqual({ deniedPrograms: ["curl"] });
  });
});

describe("garde du shell : validation", () => {
  it("refus sans écriture partielle : types, clés inconnues, programmes piégés, dossiers absolus ou « .. », image, mémoire, processeurs, listes trop longues", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ writeScope: "partout" }, /off ou workspace/],
      [{ environment: "vm" }, /local ou docker/],
      [{ virus: 1 }, /inconnue/],
      [{ deniedPrograms: ["curl; rm -rf /"] }, /sans espace ni caractère de shell/],
      [{ deniedPrograms: ["a b"] }, /sans espace/],
      [{ askPrograms: ["$(x)"] }, /caractère de shell/],
      [{ allowedPrograms: "git" }, /liste attendue/],
      [{ allowedPrograms: Array.from({ length: 101 }, (_, i) => `p${i}`) }, /100 entrées/],
      [{ writableRoots: ["C:\\Windows"] }, /relatif/],
      [{ writableRoots: ["/etc"] }, /relatif/],
      [{ writableRoots: ["../dehors"] }, /sans « \.\. »/],
      [{ writableRoots: ["a/../../b"] }, /sans « \.\. »/],
      [{ docker: { image: "Mauvaise Image" } }, /référence d'image/],
      [{ docker: { image: "x/../y" } }, /référence d'image/],
      [{ docker: { memory: "beaucoup" } }, /512m ou 4g/],
      [{ docker: { cpus: -1 } }, /entre 0/],
      [{ docker: { network: "oui" } }, /booléen/],
      [{ docker: { gpu: true } }, /inconnue/],
    ];
    for (const [patch, why] of bad) await rejects(() => call("set-jarod-settings", { agentMode: "plan", shellGuard: patch }), why);
    expect(app.agent.settings.getAll()).toEqual(before);
  });

  it("get-jarod-options : le texte EXACT de /shell-guard, mécanisme de confinement de cette machine compris", async () => {
    const { call } = await setupKernel();
    const o = (await call("get-jarod-options")) as { shellGuardText: string };
    expect(o.shellGuardText).toContain("Garde du shell");
    expect(o.shellGuardText).toContain("Mécanisme de confinement");
    expect(o.shellGuardText).not.toContain("**");
  });
});
