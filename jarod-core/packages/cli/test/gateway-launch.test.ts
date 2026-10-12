// Jarod-OS : le lanceur. La vraie passerelle sur un profil jetable, un FAUX Herald (un script Node) qui fait les appels que ferait le shell avec les
// variables qu'on lui donne, puis l'arrêt propre de la passerelle.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HERALD, DEFAULT_WORKSPACE, launch, parseArgs, readGatewayFile } from "../src/gateway/launch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

describe("parseArgs", () => {
  it("valeurs par défaut : le dossier de travail de Jarod-OS, un dossier de données propre, l'application empaquetée", () => {
    const o = parseArgs([], { LOCALAPPDATA: "C:\\Users\\moi\\AppData\\Local" });
    expect(o).toMatchObject({ workspace: DEFAULT_WORKSPACE, herald: DEFAULT_HERALD, realProfile: false, heraldArgs: [] });
    expect(o.dataDir).toBe(join("C:\\Users\\moi\\AppData\\Local", "Jarod-OS"));
    // Le nom de l'exécutable suit le productName de l'application empaquetée (renommage Herald OS -> Jarod-OS, WINDOWS-PORT-NOTES.md).
    expect(DEFAULT_HERALD).toMatch(/win-unpacked\\Jarod-OS\.exe$/);
  });
  it("les options l'emportent sur l'environnement, qui l'emporte sur les défauts ; --real-profile et --herald-arg", () => {
    const argv = ["--workspace", "E:\\W", "--data", "E:\\D", "--herald", "E:\\H.exe", "--real-profile", "--herald-arg", "a.js", "--herald-arg", "--x"];
    expect(parseArgs(argv, { JAROD_WORKSPACE: "C:\\env" })).toMatchObject({ workspace: "E:\\W", dataDir: "E:\\D", herald: "E:\\H.exe", realProfile: true, heraldArgs: ["a.js", "--x"] });
    expect(parseArgs([], { JAROD_WORKSPACE: "C:\\env", JAROD_OS_DATA: "C:\\data", HERALD_OS_EXE: "C:\\h.exe" })).toMatchObject({ workspace: "C:\\env", dataDir: "C:\\data", herald: "C:\\h.exe" });
  });
  it("un chemin relatif est refusé", () => {
    expect(() => parseArgs(["--workspace", "travail"], {})).toThrow(/absolu/);
    expect(() => parseArgs(["--herald", "herald.exe"], {})).toThrow(/absolu/);
  });
  it("readGatewayFile refuse un fichier incomplet", () => {
    const d = temp("jarod-launch-f-");
    writeFileSync(join(d, "g.json"), JSON.stringify({ url: "http://127.0.0.1:1" }));
    expect(() => readGatewayFile(join(d, "g.json"))).toThrow(/illisible/);
    writeFileSync(join(d, "g.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "t" }));
    expect(readGatewayFile(join(d, "g.json"))).toEqual({ url: "http://127.0.0.1:1", token: "t" });
  });
});

/** Un faux Herald : lit l'environnement, appelle la passerelle comme le shell, écrit ce qu'il a vu, et sort. */
const FAKE_HERALD = `
const fs = require('node:fs');
(async () => {
  const url = process.env.HERALD_OS_BACKEND_URL, token = process.env.HERALD_OS_BACKEND_TOKEN;
  const get = async (p) => { const r = await fetch(url + p, { headers: { 'x-hermes-session-token': token } }); return { status: r.status, body: await r.json() }; };
  const out = { url, hasToken: Boolean(token), hermesHome: process.env.HERMES_HOME, argv: process.argv.slice(2), status: await get('/api/status'), memory: await get('/api/memory'), config: await get('/api/config'), toolsets: await get('/api/tools/toolsets') };
  fs.writeFileSync(process.env.FAKE_HERALD_OUT, JSON.stringify(out));
})().catch((e) => { fs.writeFileSync(process.env.FAKE_HERALD_OUT, JSON.stringify({ error: String(e) })); process.exit(3); });
`;

describe("launch (vraie passerelle, faux Herald)", { timeout: 120_000 }, () => {
  it("crée le profil au premier lancement, branche Herald sur la passerelle avec l'adresse et le jeton, puis arrête la passerelle", async () => {
    const data = temp("jarod-launch-d-");
    const workspace = temp("jarod-launch-w-");
    const script = join(data, "fake-herald.cjs");
    writeFileSync(script, FAKE_HERALD);
    const out = join(data, "fake-out.json");
    const logs: string[] = [];

    const code = await launch({
      workspace,
      dataDir: join(data, "os"),
      realProfile: false,
      herald: process.execPath,
      heraldArgs: [script],
      env: { ...process.env, FAKE_HERALD_OUT: out },
      log: (l) => logs.push(l),
    });
    expect(code).toBe(0);

    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.error).toBeUndefined();
    expect(seen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.hasToken).toBe(true);
    // Herald a ses propres dossiers, et son dossier de données propre lui est donné.
    expect(seen.hermesHome).toBe(join(data, "os", "herald-home"));
    expect(seen.argv).toContain(`--user-data-dir=${join(data, "os", "herald-userdata")}`);
    // Ce que la passerelle a répondu à la façon du shell.
    expect(seen.status.body).toMatchObject({ status: "ok", backend: "jarod" });
    expect(seen.memory).toMatchObject({ status: 200, body: { builtin_files: { memory: 0 } } });
    expect(seen.config.body).toMatchObject({ approvals: { mode: "manual" } });
    expect(seen.toolsets.body.some((t: { name: string }) => t.name === "memory")).toBe(true);

    // Le profil a été créé, le journal de la passerelle écrit, la passerelle ARRÊTÉE (son port ne répond plus).
    expect(existsSync(join(data, "os", "profile"))).toBe(true);
    expect(logs.join("\n")).toMatch(/premier lancement : profil créé/);
    expect(logs.join("\n")).toMatch(/passerelle prête sur http:\/\/127\.0\.0\.1:\d+/);
    expect(readFileSync(join(data, "os", "gateway.log"), "utf8")).toMatch(/dossier de travail|non servi/);
    await expect(fetch(`${seen.url}/api/status`)).rejects.toThrow();
  });

  it("deuxième lancement : le profil existe, il n'est pas recréé", async () => {
    const data = temp("jarod-launch-d2-");
    const workspace = temp("jarod-launch-w2-");
    const script = join(data, "fake-herald.cjs");
    writeFileSync(script, `require('node:fs').writeFileSync(process.env.FAKE_HERALD_OUT, 'ok')`);
    const run = (logs: string[]) => launch({ workspace, dataDir: join(data, "os"), realProfile: false, herald: process.execPath, heraldArgs: [script], env: { ...process.env, FAKE_HERALD_OUT: join(data, "o") }, log: (l) => logs.push(l) });
    const first: string[] = [];
    const second: string[] = [];
    expect(await run(first)).toBe(0);
    expect(await run(second)).toBe(0);
    expect(first.join("\n")).toMatch(/premier lancement/);
    expect(second.join("\n")).not.toMatch(/premier lancement/);
  });

  it("le code de sortie de Herald est rendu ; un dossier de travail ou un Herald absents sont refusés AVANT de démarrer la passerelle", async () => {
    const data = temp("jarod-launch-d3-");
    const workspace = temp("jarod-launch-w3-");
    const script = join(data, "exit7.cjs");
    writeFileSync(script, "process.exit(7)");
    expect(await launch({ workspace, dataDir: join(data, "os"), realProfile: false, herald: process.execPath, heraldArgs: [script], env: process.env, log: () => {} })).toBe(7);
    mkdirSync(join(data, "x"));
    await expect(launch({ workspace: join(data, "absent"), dataDir: join(data, "os2"), realProfile: false, herald: process.execPath, heraldArgs: [], env: process.env, log: () => {} })).rejects.toThrow(/Dossier de travail introuvable/);
    await expect(launch({ workspace, dataDir: join(data, "os3"), realProfile: false, herald: join(data, "absent.exe"), heraldArgs: [], env: process.env, log: () => {} })).rejects.toThrow(/Jarod-OS introuvable/);
    expect(existsSync(join(data, "os2", "profile"))).toBe(false);
  });

  it("une passerelle qui ne démarre pas est une erreur nette, sans Herald lancé", async () => {
    const data = temp("jarod-launch-d4-");
    const workspace = temp("jarod-launch-w4-");
    const marker = join(data, "herald-ran");
    const script = join(data, "h.cjs");
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    // Des « passerelles » factices : une qui sort tout de suite, une qui ne dit jamais rien (le premier argument est le script, les autres ceux du lanceur).
    const exit5 = join(data, "exit5.cjs");
    const hang = join(data, "hang.cjs");
    writeFileSync(exit5, "process.exit(5)");
    writeFileSync(hang, "setInterval(() => {}, 1000)");
    await expect(
      launch({ workspace, dataDir: join(data, "os"), realProfile: false, herald: process.execPath, heraldArgs: [script], env: process.env, gatewayCommand: { file: process.execPath, args: [exit5] }, log: () => {} }),
    ).rejects.toThrow(/s'est arrêtée au démarrage \(code 5\)/);
    expect(existsSync(marker)).toBe(false);
    await expect(
      launch({ workspace, dataDir: join(data, "os5"), realProfile: false, herald: process.execPath, heraldArgs: [script], env: process.env, gatewayCommand: { file: process.execPath, args: [hang] }, readyTimeoutMs: 800, log: () => {} }),
    ).rejects.toThrow(/n'a pas annoncé/);
    expect(existsSync(marker)).toBe(false);
  });
});
