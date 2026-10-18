// Portage de packages/core/test/shell-guard.test.ts (rév. 2e180305).
/**
 * Ce que le garde du shell tient vraiment, et ce qu'il refuse de promettre.
 *
 * Les tests de refus emploient de VRAIES commandes qui écrivent vraiment : le fichier est regardé
 * sur le disque avant et après. Rien ici ne juge une chaîne de caractères, sinon un filtre sur du
 * texte pourrait passer pour un confinement.
 */
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { DEFAULT_SETTINGS, type Settings } from "@jarod/plugin-storage";
import {
  firstToken,
  probeMechanism,
  programKey,
  ShellGuardService,
  type ShellLaunchPlan,
  type ShellPlanResult,
  type ShellProbe,
  type ShellRefusal,
} from "@jarod/plugin-permissions";
import { runShell } from "@jarod/plugin-tools";
import type { ToolCall } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

/** Une commande qui ÉCRIT vraiment un fichier : ce qui compte est le disque, pas le texte. */
const commandeEcriture = (cible: string, texte = "ecrit") =>
  `node -e "require('fs').writeFileSync('${cible.replaceAll("\\", "/")}','${texte}')"`;

function planDe(r: ShellPlanResult): ShellLaunchPlan {
  if (r.kind !== "plan") throw new Error(`attendu un plan, reçu un refus : ${r.reason}`);
  return r;
}

function refusDe(r: ShellPlanResult): ShellRefusal {
  if (r.kind !== "refuse") throw new Error(`attendu un refus, reçu un plan (${r.mode})`);
  return r;
}

/** Un mécanisme simulé présent : c'est le seul moyen de vérifier la ligne de commande ailleurs. */
const probePresent: ShellProbe = (input, platform) =>
  input.platforms.includes(platform)
    ? { ok: true, path: `/usr/bin/${input.binary}`, detail: `${input.binary} simulé` }
    : { ok: false, path: null, detail: `${input.binary} n'existe pas sur ${platform}` };

/** Un mécanisme simulé absent : la machine ne sait pas tenir la promesse. */
const probeAbsent: ShellProbe = (input) => ({ ok: false, path: null, detail: `absent (simulé, ${input.id})` });

describe("garde du shell — l'usage légitime passe exactement comme avant", () => {
  it("la même commande rend la même sortie, avec et sans le garde", async () => {
    const dir = tempDir();
    const garde = new ShellGuardService({ workspace: dir });
    const plan = planDe(await garde.plan("echo bonjour", { cwd: dir }));
    expect(plan.mode).toBe("shell");
    expect(plan.mechanism).toBe("none");
    expect(plan.writableRoots).toEqual([]);

    const sans = await runShell("echo bonjour", dir);
    const avec = await runShell("echo bonjour", dir, undefined, 120_000, plan);
    expect(avec.code).toBe(0);
    expect(avec.output).toContain("bonjour");
    // À l'octet près : le défaut ne change rien au comportement.
    expect(avec.output).toBe(sans.output);
  });

  it("par défaut, `run_shell` ne restreint ni ne refuse rien", async () => {
    const core = await makeCore();
    const ws = tempDir();
    const out = await core.tools.get("run_shell")!.run({ command: "echo bonjour" }, { sessionId: "s", workspace: ws });
    expect(out).toContain("code de sortie : 0");
    expect(out).toContain("bonjour");
    expect(out).not.toContain("confine");
    expect(core.settings.get("shellGuard")).toEqual({
      writeScope: "off",
      writableRoots: [],
      readRoots: [],
      allowedPrograms: [],
      deniedPrograms: [],
      askPrograms: [],
      // La machine elle-même : Docker n'est employé que si l'utilisateur le choisit.
      environment: "local",
      docker: { image: "node:22-bookworm", network: true, memory: "4g", cpus: 2 },
    });
  });

  it("la commande vide est le seul refus que le défaut ajoute", async () => {
    const garde = new ShellGuardService({ workspace: tempDir() });
    expect(refusDe(await garde.plan("   ")).reason).toMatch(/vide/);
  });
});

describe("garde du shell — une écriture hors du dossier autorisé est refusée", () => {
  it("refuse de lancer, dit pourquoi, et le fichier interdit n'existe pas", async () => {
    const ws = tempDir();
    const dehors = join(tempDir(), "interdit.txt");
    const commande = commandeEcriture(dehors);
    // Plateforme forcée à win32 : la décision ne dépend alors pas de la machine qui exécute les tests.
    const garde = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace" }, platform: "win32" });

    const refus = refusDe(await garde.plan(commande, { cwd: ws }));
    expect(refus.reason).toMatch(/^Refusé/);
    expect(refus.reason).toMatch(/win32/);
    expect(refus.reason).toMatch(/PAS été lancée/);
    expect(existsSync(dehors)).toBe(false);

    // La même commande, SANS le garde, écrit vraiment : c'est donc bien le refus qui l'a empêchée,
    // et pas le hasard, ni une faute de frappe dans le test.
    const libre = await runShell(commande, ws);
    expect(libre.code).toBe(0);
    expect(existsSync(dehors)).toBe(true);
  });

  it("la décision ne regarde pas le texte : la même commande vers DEDANS est refusée pareil", async () => {
    const ws = tempDir();
    const dedans = join(ws, "ok.txt");
    const garde = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace" }, platform: "win32" });
    const dehors = join(tempDir(), "interdit.txt");

    const versDehors = refusDe(await garde.plan(commandeEcriture(dehors), { cwd: ws }));
    const versDedans = refusDe(await garde.plan(commandeEcriture(dedans), { cwd: ws }));
    // Même refus, alors que l'un des deux chemins est parfaitement légitime : ce n'est pas un filtre
    // sur des mots interdits, c'est l'absence d'un mécanisme qui tienne la promesse.
    expect(versDedans.reason).toBe(versDehors.reason);
    expect(existsSync(dedans)).toBe(false);
  });
});

describe("garde du shell — confiné par le noyau, ou refusé, jamais promis", () => {
  it("sur cette plateforme-ci, demander le confinement refuse au lieu de promettre", async () => {
    const ws = tempDir();
    const cible = join(tempDir(), "interdit.txt");
    const garde = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace" } });
    const refus = refusDe(await garde.plan(commandeEcriture(cible), { cwd: ws }));
    expect(refus.reason).toMatch(/confinement des écritures est demandé/);
    expect(refus.reason).toMatch(/cette machine ne peut pas le tenir/);
    if (process.platform === "win32") expect(refus.reason).toMatch(/win32/);
    expect(existsSync(cible)).toBe(false);
    // Là où le mécanisme n'existe pas, le garde le dit au lieu de faire semblant.
    if (process.platform !== "linux") expect(garde.mechanism().available).toBe(false);
  });

  it("quand le mécanisme est là, la ligne de commande le porte vraiment", async () => {
    const ws = tempDir();
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "linux",
      probe: probePresent,
    });
    const plan = planDe(await garde.plan("echo bonjour", { cwd: ws }));

    expect(plan.mode).toBe("exec");
    expect(plan.mechanism).toBe("bwrap");
    expect(plan.bin).toBe("/usr/bin/bwrap");
    // La racine est en LECTURE SEULE, le dossier autorisé est remonté en lecture-écriture : c'est le
    // noyau qui refuse le write, pas une analyse de la ligne.
    const racine = realpathSync.native(ws);
    expect(plan.writableRoots).toEqual([racine]);
    expect(plan.args.join(" ")).toContain("--ro-bind / /");
    expect(plan.args.join(" ")).toContain(`--bind ${racine} ${racine}`);
    expect(plan.args.join(" ")).toContain(`--chdir ${racine}`);
    // La commande est le dernier argument, entière : elle n'est pas recollée par un shell.
    expect(plan.args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo bonjour"]);
    expect(plan.detail).toContain("écriture permise seulement dans");
  });

  it("sans mécanisme présent, un confinement demandé n'est jamais exécuté quand même", async () => {
    const ws = tempDir();
    const cible = join(tempDir(), "interdit.txt");
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "linux",
      probe: probeAbsent,
    });
    const refus = refusDe(await garde.plan(commandeEcriture(cible), { cwd: ws }));
    expect(refus.reason).toMatch(/cette machine ne peut pas le tenir/);
    expect(refus.reason).toMatch(/bwrap : absent \(simulé, bwrap\)/);
    expect(existsSync(cible)).toBe(false);
  });

  it("un dossier d'exécution hors du dossier autorisé est refusé", async () => {
    const ws = tempDir();
    const ailleurs = tempDir();
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "linux",
      probe: probePresent,
    });
    const refus = refusDe(await garde.plan("echo bonjour", { cwd: ailleurs }));
    expect(refus.reason).toMatch(/hors du dossier de travail autorisé/);
  });

  it("sans dossier de travail, le confinement n'a rien à tenir et le dit", async () => {
    const garde = new ShellGuardService({ workspace: null, policy: { writeScope: "workspace" } });
    const refus = refusDe(await garde.plan("echo bonjour"));
    expect(refus.reason).toMatch(/sans dossier de travail/);
  });
});

describe("garde du shell — les chemins sont vérifiés, liens et jonctions suivis", () => {
  it("une jonction posée dans le dossier de travail et pointant dehors est refusée", async () => {
    const ws = tempDir();
    const ailleurs = tempDir();
    symlinkSync(ailleurs, join(ws, "lien"), "junction");
    const garde = new ShellGuardService({ workspace: ws, policy: { writableRoots: ["lien"] } });
    const refus = refusDe(await garde.plan("echo bonjour", { cwd: ws }));
    expect(refus.reason).toMatch(/sort du dossier de travail/);
    // Le refus nomme le chemin RÉEL : celui où l'écriture serait vraiment arrivée.
    expect(refus.reason).toContain(realpathSync.native(ailleurs));
  });

  it("un dossier d'écriture autorisé reste autorisé, une fois vérifié", async () => {
    const ws = tempDir();
    mkdirSync(join(ws, "sous"));
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace", writableRoots: ["sous"] },
      platform: "linux",
      probe: probePresent,
    });
    const plan = planDe(await garde.plan("echo bonjour", { cwd: ws }));
    expect(plan.writableRoots).toEqual([realpathSync.native(ws), realpathSync.native(join(ws, "sous"))]);
  });

  it("un dossier d'écriture qui n'existe pas est refusé", async () => {
    const ws = tempDir();
    const garde = new ShellGuardService({ workspace: ws, policy: { writableRoots: ["jamais-cree"] } });
    const refus = refusDe(await garde.plan("echo bonjour", { cwd: ws }));
    expect(refus.reason).toMatch(/n'existe pas/);
  });
});

describe("garde du shell — le programme est vérifié sur le binaire résolu", () => {
  it("refuse un programme absent de la liste, et laisse passer celui qui y est", async () => {
    const ws = tempDir();
    const strict = new ShellGuardService({ workspace: ws, policy: { allowedPrograms: ["git"] } });
    const refus = refusDe(await strict.plan('node -e "1"', { cwd: ws }));
    expect(refus.reason).toMatch(/n'est pas dans la liste des programmes autorisés/);
    expect(refus.reason).toContain("git");

    const permis = new ShellGuardService({ workspace: ws, policy: { allowedPrograms: ["node"] } });
    expect(planDe(await permis.plan('node -e "1"', { cwd: ws })).mode).toBe("shell");
  });

  it("refuse un programme invérifiable plutôt que de le laisser passer", async () => {
    const ws = tempDir();
    const strict = new ShellGuardService({ workspace: ws, policy: { allowedPrograms: ["node"] } });
    const refus = refusDe(await strict.plan("pas-un-vrai-outil-xyz --version", { cwd: ws }));
    expect(refus.reason).toMatch(/introuvable/);
  });

  it("refuse un programme de la liste noire", async () => {
    const ws = tempDir();
    const garde = new ShellGuardService({ workspace: ws, policy: { deniedPrograms: ["node"] } });
    expect(refusDe(await garde.plan('node -e "1"', { cwd: ws })).reason).toMatch(/refusé par la politique/);
  });

  it("lit le programme au premier mot, guillemets et préfixe d'environnement compris", () => {
    expect(firstToken('  "C:\\Program Files\\outil.exe" -a')).toBe("C:\\Program Files\\outil.exe");
    expect(firstToken("QUIET=1 node -v")).toBe("node");
    expect(firstToken("")).toBe("");
    expect(programKey("node.exe")).toBe("node");
    expect(programKey("/usr/bin/GIT")).toBe("git");
  });
});

describe("garde du shell — l'accord passe par la porte existante du cœur", () => {
  it("sans porte branchée, un accord impossible vaut un refus, pas une exécution", async () => {
    const ws = tempDir();
    const cible = join(ws, "accord.txt");
    const garde = new ShellGuardService({ workspace: ws, policy: { askPrograms: ["node"] } });
    const refus = refusDe(await garde.plan(commandeEcriture(cible), { cwd: ws }));
    expect(refus.reason).toMatch(/exige l'accord de l'utilisateur/);
    expect(refus.reason).toMatch(/aucun canal d'approbation/);
    expect(existsSync(cible)).toBe(false);
  });

  it("sans accord, la commande ne s'exécute pas ; avec, elle s'exécute", async () => {
    const ws = tempDir();
    const cible = join(ws, "accord.txt");
    const commande = commandeEcriture(cible);
    const demandes: { call: ToolCall; description: string }[] = [];
    let decision = false;
    const porte = async (sessionId: string, call: ToolCall, description: string) => {
      demandes.push({ call, description });
      expect(sessionId).toBe("s1");
      return decision;
    };

    const garde = new ShellGuardService({
      workspace: ws,
      policy: { askPrograms: ["node"] },
      approve: porte,
      sessionId: "s1",
    });
    const refus = refusDe(await garde.plan(commande, { cwd: ws }));
    expect(refus.reason).toMatch(/n'a pas donné son accord/);
    expect(existsSync(cible)).toBe(false);
    // La porte a bien été consultée, et elle nomme le programme concerné.
    expect(demandes).toHaveLength(1);
    expect(demandes[0]!.description).toContain("node");
    expect(demandes[0]!.call.name).toBe("run_shell");

    decision = true;
    const plan = planDe(await garde.plan(commande, { cwd: ws }));
    expect(demandes).toHaveLength(2);
    const r = await runShell(commande, ws, undefined, 120_000, plan);
    expect(r.code).toBe(0);
    expect(existsSync(cible)).toBe(true);
  });

  it("une porte qui échoue refuse, elle n'autorise pas", async () => {
    const ws = tempDir();
    const cible = join(ws, "accord.txt");
    const porte = async () => {
      throw new Error("porte cassée");
    };
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { askPrograms: ["node"] },
      approve: porte,
      sessionId: "s1",
    });
    expect(refusDe(await garde.plan(commandeEcriture(cible), { cwd: ws })).reason).toMatch(/n'a pas donné son accord/);
    expect(existsSync(cible)).toBe(false);
  });
});

describe("garde du shell — un refus ne peut pas passer pour un succès", () => {
  it("à travers la porte du cœur, le refus ressort en erreur, sans code de sortie", async () => {
    const core = await makeCore();
    const ws = tempDir();
    const dehors = join(tempDir(), "interdit.txt");
    const settings: Settings = { ...DEFAULT_SETTINGS, workspace: ws, shellGuard: { writeScope: "workspace" } };
    const r = await executeGuardedTool(
      core.tools,
      "s1",
      { id: "t1", name: "run_shell", args: { command: commandeEcriture(dehors) } },
      new AbortController().signal,
      { approve: async () => true },
      settings,
      // Le portail du garde unifié vient de plugin-permissions en production ; ici on teste le garde du
      // shell, donc on l'ouvre — son absence vaut « deny » (AV2-008), pas « laisse passer ».
      { gate: { decide: () => "allow" as const } },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Erreur : Refusé/);
    // La forme d'un succès (« code de sortie : 0 ») ne peut pas être confondue avec un refus.
    expect(r.content).not.toMatch(/code de sortie/);
    expect(existsSync(dehors)).toBe(false);
  });

  it("l'outil lève au lieu de rendre un résultat, même quand tout le reste est vert", async () => {
    const core = await makeCore();
    const ws = tempDir();
    const dehors = join(tempDir(), "interdit.txt");
    const outil = core.tools.get("run_shell")!;
    await expect(
      outil.run(
        { command: commandeEcriture(dehors), isolation: "workspace" },
        { sessionId: "s1", workspace: ws, shellGuard: { writeScope: "workspace" } },
      ),
    ).rejects.toThrow(/^Refusé/);
    expect(existsSync(dehors)).toBe(false);
  });
});

describe("garde du shell — la politique en vigueur se lit", () => {
  it("montre les programmes, les écritures et les accords, sans rien inventer", () => {
    const ws = tempDir();
    mkdirSync(join(ws, "sous"));
    const garde = new ShellGuardService({
      workspace: ws,
      policy: {
        writeScope: "workspace",
        writableRoots: ["sous"],
        allowedPrograms: ["git", "node"],
        deniedPrograms: ["curl"],
        askPrograms: ["rm"],
      },
    });
    const vue = garde.view();
    expect(vue.platform).toBe(process.platform);
    expect(vue.writeScope).toBe("workspace");
    expect(vue.writableRoots).toEqual([realpathSync.native(ws), realpathSync.native(join(ws, "sous"))]);
    expect(vue.allowedPrograms).toEqual(["git", "node"]);

    const texte = garde.describe();
    expect(texte).toContain("Garde du shell");
    expect(texte).toContain(process.platform);
    expect(texte).toContain("git, node");
    expect(texte).toContain("curl");
    expect(texte).toContain("rm");
    expect(texte).toContain("Sans réglage");
    expect(texte).toMatch(/Mécanisme de confinement/);
  });

  it("se lit depuis la conversation, sans interface ni réglage caché", async () => {
    const core = await makeCore();
    const r = await core.commands.execute("/shell-guard", { sessionId: null });
    expect(r?.text).toContain("Garde du shell");
    expect(r?.text).toContain(process.platform);
    expect(r?.text).toContain("Sans réglage");
    expect(r?.text).toMatch(/Écritures autorisées/);
  });

  it("un réglage partiel ne remplace pas le défaut", () => {
    const garde = new ShellGuardService({ workspace: tempDir(), policy: { deniedPrograms: ["x"] } });
    expect(garde.policy()).toEqual({ ...DEFAULT_SETTINGS.shellGuard, deniedPrograms: ["x"] });
  });
});

describe("garde du shell — Windows : AppContainer (jarod-sandbox) ou refus", () => {
  const sondeWindows = (ok: boolean): ShellProbe => (input) =>
    input.id === "jarod-sandbox"
      ? { ok, path: ok ? "C:\\outils\\jarod-sandbox.exe" : null, detail: ok ? "présent (simulé)" : "absent (simulé)" }
      : { ok: false, path: null, detail: `n'existe pas sur win32` };

  it("avec le mécanisme, la ligne part telle quelle vers `jarod-sandbox exec`, dossier de travail en tête", async () => {
    const ws = tempDir();
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "win32",
      probe: sondeWindows(true),
    });
    const ligne = 'echo "a b"> "c d.txt"';
    const plan = planDe(await garde.plan(ligne, { cwd: ws }));
    const racine = realpathSync.native(ws);

    expect(plan.mechanism).toBe("jarod-sandbox");
    expect(plan.mode).toBe("exec");
    expect(plan.bin).toBe("C:\\outils\\jarod-sandbox.exe");
    expect(plan.args.slice(0, 4)).toEqual(["exec", "--workspace", racine, "--cwd"]);
    // La ligne est le dernier argument, entière, guillemets compris : aucun recollage.
    expect(plan.args.slice(-2)).toEqual(["--", ligne]);
    expect(plan.writableRoots).toEqual([racine]);
  });

  it("sans le binaire, le confinement demandé est refusé et la raison nomme jarod-sandbox", async () => {
    const ws = tempDir();
    const cible = join(tempDir(), "interdit.txt");
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "win32",
      probe: sondeWindows(false),
    });
    const refus = refusDe(await garde.plan(commandeEcriture(cible), { cwd: ws }));
    expect(refus.reason).toMatch(/jarod-sandbox/);
    expect(refus.reason).toMatch(/PAS été lancée/);
    expect(existsSync(cible)).toBe(false);
  });

  it("l'ancien nom de variable (HERALD_SANDBOX_BIN) est encore lu, le nouveau passe avant", () => {
    const def = { id: "jarod-sandbox" as const, binary: "jarod-sandbox", platforms: ["win32" as const], versionArg: "selftest", mustExitZero: true, envPath: "JAROD_SANDBOX_BIN", legacyEnvPath: "HERALD_SANDBOX_BIN" };
    // l'ancien nom seul : le binaire est trouvé (et refusé ici par son épreuve, ce qui prouve qu'il a été lancé)
    expect(probeMechanism(def, "win32", { HERALD_SANDBOX_BIN: process.execPath }).detail).toMatch(/échoué à son épreuve/);
    // le nouveau nom l'emporte sur l'ancien
    expect(probeMechanism(def, "win32", { JAROD_SANDBOX_BIN: "C:\n-existe-pas.exe", HERALD_SANDBOX_BIN: process.execPath, PATH: "" }).detail).toBe("absent du PATH");
  });

  it("par le garde : l'ancienne variable HERALD_SANDBOX_BIN désigne encore le binaire (il est lancé, donc jugé par son épreuve)", () => {
    const garde = new ShellGuardService({ workspace: tempDir(), platform: "win32", env: { HERALD_SANDBOX_BIN: process.execPath } });
    expect(garde.mechanism().detail ?? "").toMatch(/échoué à son épreuve/);
  });

  it("un binaire qui échoue à son épreuve n'est PAS retenu, même s'il démarre", () => {
    // `node selftest` démarre (le binaire existe) mais se termine en erreur : exactement le cas d'une
    // machine où l'AppContainer ne tient pas. La sonde doit le refuser.
    const sonde = probeMechanism(
      { id: "jarod-sandbox", binary: "jarod-sandbox", platforms: ["win32"], versionArg: "selftest", mustExitZero: true, envPath: "JAROD_SANDBOX_BIN" },
      "win32",
      { JAROD_SANDBOX_BIN: process.execPath },
    );
    expect(sonde.ok).toBe(false);
    expect(sonde.detail).toMatch(/échoué à son épreuve/);
  });

  const binaire = join(__dirname, "..", "..", "..", "..", "..", "host-rust", "target", "debug", "jarod-sandbox.exe");
  const reel = process.platform === "win32" && existsSync(binaire) ? it : it.skip;

  reel("pour de vrai : écrire dedans marche, écrire dehors est refusé par le noyau", async () => {
    const ws = tempDir();
    const dehors = tempDir();
    const garde = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      env: { ...process.env, JAROD_SANDBOX_BIN: binaire },
    });

    expect(garde.mechanism().available).toBe(true);

    const cibleDehors = join(dehors, "interdit.txt");
    const ligneDehors = `echo piege> "${cibleDehors}"`;
    // Témoin : la même ligne, sans le garde, écrit vraiment.
    const libre = await runShell(ligneDehors, ws);
    expect(libre.code).toBe(0);
    expect(existsSync(cibleDehors)).toBe(true);
    rmSync(cibleDehors);

    const refuse = planDe(await garde.plan(ligneDehors, { cwd: ws }));
    const dehorsRes = await runShell(ligneDehors, ws, undefined, 60_000, refuse);
    expect(dehorsRes.code).not.toBe(0);
    expect(existsSync(cibleDehors)).toBe(false);

    const dedans = planDe(await garde.plan(`echo ok> "${join(ws, "dedans.txt")}"`, { cwd: ws }));
    const dedansRes = await runShell("", ws, undefined, 60_000, dedans);
    expect(dedansRes.code).toBe(0);
    expect(existsSync(join(ws, "dedans.txt"))).toBe(true);
  });
});
