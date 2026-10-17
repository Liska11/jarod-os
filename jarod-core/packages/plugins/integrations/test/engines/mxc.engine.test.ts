// A1 contre MXC (@microsoft/mxc-sdk, ProcessContainer réel de Windows) : matrice d'attaque sur un dossier jeton.
// Aucun profil réel : la « clé » est un fichier fabriqué dans un faux dossier personnel.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AdapterRefused, confineGeneratedScript, toMxcRequest } from "../../src/index.js";
import { ROOT } from "./helpers.js";

const SDK = join(ROOT, "engines", "mxc", "node_modules", "@microsoft", "mxc-sdk", "dist", "v1", "index.js");
type Run = (req: object) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
const sdk = existsSync(SDK) ? ((await import(pathToFileURL(SDK).href)) as { run: Run; getPlatformSupport(): { isSupported: boolean; availableMethods: string[] } }) : null;
const supported = !!sdk && sdk.getPlatformSupport().isSupported && sdk.getPlatformSupport().availableMethods.includes("processcontainer");
const root = mkdtempSync(join(tmpdir(), "jarod-mxc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NODE_DIR = dirname(process.execPath);

describe("A1 — politique de requête", () => {
  const ws = "C:\\Zone\\travail";
  it("écriture dans la zone seulement, réseau refusé, presse-papiers et injection refusés, délai borné", () => {
    const r = toMxcRequest("node a.mjs", { workspace: ws, readonlyPaths: ["C:\\Program Files\\nodejs"], deniedPaths: ["C:\\Users\\x\\.ssh"] }, 99999);
    expect(r).toMatchObject({ network: { egress: { default: "deny" } }, ui: { disable: false, clipboard: "none", allowInputInjection: false }, timeoutMs: 600_000, workingDirectory: ws });
    expect(r.filesystem.readwritePaths).toEqual([ws]);
  });
  it("refuse les chemins relatifs, avec « .. », et une zone aussi déclarée en lecture seule ou interdite", () => {
    expect(() => toMxcRequest("x", { workspace: "relatif" })).toThrow(AdapterRefused);
    expect(() => toMxcRequest("x", { workspace: ws, readonlyPaths: ["C:\\a\\..\\b"] })).toThrow(AdapterRefused);
    expect(() => toMxcRequest("x", { workspace: ws, deniedPaths: [`${ws}\\`] })).toThrow(/aussi/);
    expect(() => toMxcRequest(" ", { workspace: ws })).toThrow(/vide/);
  });
});

describe.skipIf(!supported)("A1 contre MXC réel (ProcessContainer)", () => {
  const workspace = join(root, "travail");
  const home = join(root, "faux-home");
  const outside = join(root, "dehors");
  const fakeKey = "FAUSSE-CLE-PRIVEE-mxc-0001";
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, ".ssh", "id_faux"), fakeKey);
  const policy = { workspace, readonlyPaths: [NODE_DIR], deniedPaths: [join(home, ".ssh")] };
  // MESURÉ : sans ces options, node remonte l'arborescence par lstat jusqu'à « C:\ » pour résoudre le chemin réel, et le conteneur le refuse.
  const node = `"${process.execPath}" --preserve-symlinks --preserve-symlinks-main`;

  /** Un script GÉNÉRÉ est écrit dans la zone (comme le ferait write_file) puis lancé dans le conteneur. */
  async function runGenerated(source: string) {
    const gen = confineGeneratedScript("node", source);
    const file = join(workspace, gen.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return sdk!.run(toMxcRequest(`${node} "${file}"`, policy, 60));
  }

  it("1. écrit dans la zone : autorisé", async () => {
    const r = await runGenerated(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(workspace, "ok.txt"))}, 'bien');`);
    expect(r.exitCode, `${r.stderr} ${r.stdout}`).toBe(0);
    expect(readFileSync(join(workspace, "ok.txt"), "utf8")).toBe("bien");
  }, 120_000);

  it("2. écrit hors de la zone : refusé, le fichier n'existe pas", async () => {
    const target = join(outside, "evade.txt");
    const r = await runGenerated(`import {writeFileSync} from 'node:fs'; try { writeFileSync(${JSON.stringify(target)}, 'x'); console.log('ECRIT'); } catch (e) { console.log('REFUSE'); }`);
    expect(existsSync(target)).toBe(false);
    expect(r.stdout).not.toContain("ECRIT");
  }, 120_000);

  it("3. lit la fausse clé du dossier interdit : le contenu ne sort jamais", async () => {
    const r = await runGenerated(`import {readFileSync} from 'node:fs'; try { console.log(readFileSync(${JSON.stringify(join(home, ".ssh", "id_faux"))}, 'utf8')); } catch (e) { console.log('REFUSE'); }`);
    expect(r.stdout + r.stderr).not.toContain(fakeKey);
  }, 120_000);

  it("4. ouvre une connexion réseau vers un serveur local : aucune requête n'arrive", async () => {
    let hits = 0;
    const server = createServer((_q, res) => {
      hits++;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await runGenerated(`try { const r = await fetch('http://127.0.0.1:${port}/exfil?d=secret'); console.log('ENVOYE', r.status); } catch (e) { console.log('REFUSE'); }`);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  }, 120_000);

  it("5. le délai est tenu : une boucle infinie est arrêtée", async () => {
    const gen = confineGeneratedScript("node", "while (true) {}");
    const file = join(workspace, gen.file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "while (true) {}");
    const t0 = Date.now();
    const r = await sdk!.run({ ...toMxcRequest(`${node} "${file}"`, policy, 1), timeoutMs: 3000 });
    expect(r.timedOut || r.exitCode !== 0).toBe(true);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);
});
