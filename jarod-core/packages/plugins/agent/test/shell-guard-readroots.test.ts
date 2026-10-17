/**
 * `readRoots` : des dossiers (ceux des outils : node, git…) que la commande confinée peut LIRE et EXÉCUTER, sans pouvoir y écrire.
 *
 * Le confinement d'écriture reste entier ; ce réglage ne l'assouplit que pour la lecture, et seulement pour des dossiers que l'utilisateur nomme. Il est refusé en bloc
 * (jamais ignoré en silence) s'il désigne ce qu'il ne faut jamais ouvrir : racine d'un lecteur, dossier personnel, dossiers de clés.
 */
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ShellGuardService, type ShellLaunchPlan, type ShellPlanResult, type ShellProbe, type ShellRefusal } from "@jarod/plugin-permissions";
import { runShell } from "@jarod/plugin-tools";
import { tempDir } from "./helpers.js";

const planDe = (r: ShellPlanResult): ShellLaunchPlan => {
  if (r.kind !== "plan") throw new Error(`attendu un plan, reçu un refus : ${r.reason}`);
  return r;
};
const refusDe = (r: ShellPlanResult): ShellRefusal => {
  if (r.kind !== "refuse") throw new Error(`attendu un refus, reçu un plan (${r.mode})`);
  return r;
};
const sonde: ShellProbe = (input) => (input.id === "jarod-sandbox" ? { ok: true, path: "C:\\outils\\jarod-sandbox.exe", detail: "présent (simulé)" } : { ok: false, path: null, detail: "n'existe pas sur win32" });

function garde(readRoots: string[], over: { home?: string; workspace?: string } = {}) {
  const ws = over.workspace ?? tempDir();
  return { ws, g: new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace", readRoots }, platform: "win32", probe: sonde, ...(over.home ? { home: over.home } : {}) }) };
}

describe("readRoots : le plan", () => {
  it("chaque dossier de lecture part en `--read-root <chemin RÉEL>` à jarod-sandbox, avant la ligne ; le dossier de travail reste le seul inscriptible", async () => {
    const outils = tempDir();
    const autre = tempDir();
    const { ws, g } = garde([outils, autre]);
    const plan = planDe(await g.plan("node --version", { cwd: ws }));
    const i = plan.args.indexOf("--read-root");
    expect(i).toBeGreaterThan(-1);
    const pairs = plan.args.reduce<string[]>((acc, a, k) => (a === "--read-root" ? [...acc, plan.args[k + 1]!] : acc), []);
    expect(pairs).toEqual([realpathSync.native(outils), realpathSync.native(autre)]);
    expect(plan.args.slice(-2)).toEqual(["--", "node --version"]);
    expect(plan.writableRoots).toEqual([realpathSync.native(ws)]); // lire n'est pas écrire
    expect(plan.detail).toContain("lecture seule");
  });

  it("sans readRoots, le plan est celui d'avant : aucun --read-root", async () => {
    const { ws, g } = garde([]);
    expect(planDe(await g.plan("echo a", { cwd: ws })).args).not.toContain("--read-root");
  });

  it("un doublon, un lien ou une écriture différente du même dossier ne le répète pas", async () => {
    const outils = tempDir();
    const { ws, g } = garde([outils, outils, `${outils}${process.platform === "win32" ? "\\" : "/"}`]);
    const plan = planDe(await g.plan("echo a", { cwd: ws }));
    expect(plan.args.filter((a) => a === "--read-root")).toHaveLength(1);
  });

  it("la politique effective, la vue et /shell-guard disent les dossiers de lecture", () => {
    const outils = tempDir();
    const { g } = garde([outils]);
    expect(g.policy().readRoots).toEqual([outils]);
    expect(g.view().readRoots).toEqual([realpathSync.native(outils)]);
    expect(g.describe()).toContain("Dossiers lisibles");
    expect(g.describe()).toContain(realpathSync.native(outils));
    expect(garde([]).g.describe()).toMatch(/Dossiers lisibles[^\n]*aucun/);
  });
});

describe("readRoots : refus en bloc (jamais ignoré en silence)", () => {
  /** Un faux dossier personnel, refait pour chaque essai (les dossiers temporaires sont effacés entre deux essais). */
  function monde() {
    const home = tempDir();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(home, ".aws", "sous-dossier"), { recursive: true });
    mkdirSync(join(home, "outils", "bin"), { recursive: true });
    const fichier = join(home, "outils", "fichier.txt");
    writeFileSync(fichier, "x");
    return { home, fichier };
  }

  const cas: [string, (m: { home: string; fichier: string }) => string, RegExp][] = [
    ["relatif", () => "outils", /absolu/],
    ["inexistant", (m) => join(m.home, "nexiste-pas"), /n'existe pas/],
    ["un fichier", (m) => m.fichier, /pas un dossier/],
    ["le dossier personnel lui-même", (m) => m.home, /dossier personnel/],
    ["un ancêtre du dossier personnel", (m) => dirname(m.home), /dossier personnel/],
    ["la racine d'un lecteur", (m) => (process.platform === "win32" ? `${m.home.slice(0, 2)}\\` : "/"), /racine/],
    ["un dossier de clés", (m) => join(m.home, ".ssh"), /clés|protégé/],
    ["l'intérieur d'un dossier de clés", (m) => join(m.home, ".aws", "sous-dossier"), /clés|protégé/],
  ];
  for (const [nom, valeur, motif] of cas) {
    it(`refuse ${nom}`, async () => {
      const m = monde();
      const { ws, g } = garde([join(m.home, "outils", "bin"), valeur(m)], { home: m.home });
      const refus = refusDe(await g.plan("node --version", { cwd: ws }));
      expect(refus.reason).toMatch(motif);
      expect(refus.reason).toMatch(/PAS été lancée/);
    });
  }

  it("un dossier d'outils ordinaire sous le dossier personnel est accepté", async () => {
    const { home } = monde();
    const { ws, g } = garde([join(home, "outils", "bin")], { home });
    expect(planDe(await g.plan("node --version", { cwd: ws })).args).toContain("--read-root");
  });

  it("sans confinement demandé, les dossiers de lecture ne changent rien (la commande part comme avant)", async () => {
    const { home } = monde();
    const ws = tempDir();
    const g = new ShellGuardService({ workspace: ws, policy: { writeScope: "off", readRoots: [join(home, "outils", "bin")] }, platform: "win32", probe: sonde, home });
    expect(planDe(await g.plan("echo a", { cwd: ws })).mechanism).toBe("none");
  });
});

describe("readRoots : pour de vrai, avec jarod-sandbox", () => {
  const binaire = join(__dirname, "..", "..", "..", "..", "..", "host-rust", "target", "debug", "jarod-sandbox.exe");
  const reel = process.platform === "win32" && existsSync(binaire) ? it : it.skip;

  reel("MESURE : sans readRoots, `node` n'est pas atteignable dans le conteneur ; avec son dossier (qui appartient à l'utilisateur) en lecture, il s'exécute — et il ne peut toujours pas écrire hors du dossier de travail", async () => {
    const ws = tempDir();
    const dehors = tempDir();
    // Un dossier d'outils qui APPARTIENT à l'utilisateur (comme scoop, cargo ou un Python installé pour l'utilisateur) : le droit de lecture se pose sur son ACL.
    // MESURÉ le 2026-10-17 : le dossier d'installation système de node (Program Files) n'est PAS utilisable ainsi — `node` y reste « Accès refusé » même avec le droit demandé.
    const dossierNode = tempDir();
    copyFileSync(process.execPath, join(dossierNode, "node.exe"));
    const env = { ...process.env, JAROD_SANDBOX_BIN: binaire };
    const sans = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace" }, env });
    const avec = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace", readRoots: [dossierNode] }, env });
    expect(avec.mechanism().available).toBe(true);

    const sansRes = await runShell("node --version", ws, undefined, 60_000, planDe(await sans.plan("node --version", { cwd: ws })));
    expect(sansRes.code).not.toBe(0); // le témoin : l'outil n'est pas là

    const avecRes = await runShell("node --version", ws, undefined, 60_000, planDe(await avec.plan("node --version", { cwd: ws })));
    expect(avecRes.code, avecRes.output).toBe(0);
    expect(avecRes.output).toContain(process.version);

    // lire n'est pas écrire : node, lancé avec ce droit de lecture, ne peut toujours pas écrire hors du dossier de travail…
    const cible = join(dehors, "interdit.txt").replaceAll("\\", "/");
    const ligne = `node -e "require('fs').writeFileSync('${cible}','x')"`;
    const refus = await runShell(ligne, ws, undefined, 60_000, planDe(await avec.plan(ligne, { cwd: ws })));
    expect(refus.code).not.toBe(0);
    expect(existsSync(join(dehors, "interdit.txt"))).toBe(false);
    // …ni dans le dossier de node lui-même
    const dedans = join(dossierNode, `jarod-essai-${process.pid}.txt`).replaceAll("\\", "/");
    const ligneNode = `node -e "require('fs').writeFileSync('${dedans}','x')"`;
    const refus2 = await runShell(ligneNode, ws, undefined, 60_000, planDe(await avec.plan(ligneNode, { cwd: ws })));
    expect(refus2.code).not.toBe(0);
    expect(existsSync(dedans)).toBe(false);
    // et dans le dossier de travail, il écrit
    const bon = join(ws, "ok.txt").replaceAll("\\", "/");
    const ligneBon = `node -e "require('fs').writeFileSync('${bon}','x')"`;
    const ok = await runShell(ligneBon, ws, undefined, 60_000, planDe(await avec.plan(ligneBon, { cwd: ws })));
    expect(ok.code, ok.output).toBe(0);
    expect(existsSync(join(ws, "ok.txt"))).toBe(true);
  });
});
