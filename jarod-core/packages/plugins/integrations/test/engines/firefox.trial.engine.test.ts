// Répétition de l'ESSAI GUIDÉ (page neutre) avec la VRAIE extension dans le Firefox de TEST (jamais celui de l'utilisateur). Prouve que l'hôte d'essai
// `essai.localhost` est joignable par Firefox, que le geste puis le « oui » mènent à la lecture de l'élément convenu — et de lui seul.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTrial } from "../../src/impl/firefox-trial.js";
import { FirefoxTest, hasFirefoxTest } from "./firefox_driver.js";
import { ROOT } from "./helpers.js";

const HAS = hasFirefoxTest(ROOT) && existsSync(join(ROOT, "jarod-core", "sidecars", "firefox-reader", "manifest.json"));
const CLICK = `Services.wm.getMostRecentWindow("navigator:browser").document.getElementById("jarod-reader_jarod_os-BAP").click(); return 1`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS)("essai guidé — vraie extension, Firefox de test, page neutre", () => {
  let ff: FirefoxTest;
  beforeAll(async () => {
    ff = await FirefoxTest.start(ROOT);
    await ff.installAddon(join(ROOT, "jarod-core", "sidecars", "firefox-reader"));
  }, 180_000);
  afterAll(async () => {
    await ff?.quit();
  }, 60_000);

  it("geste + « oui » : titre et élément convenu lus ; le leurre et l'autre paragraphe ne sont jamais lus", async () => {
    const lines: string[] = [];
    const asked: string[] = [];
    const done = runTrial({ out: (l) => lines.push(l), ask: async (s) => (asked.push(s), true), pollMs: 50 });
    for (let i = 0; i < 100 && !lines.some((l) => l.startsWith("Canal ouvert")); i++) await wait(50);
    const pageUrl = /http:\/\/[^\s]+/.exec(lines[0]!)![0];
    const [, port, key] = /jarod1\.(\d+)\.([0-9a-f]{64})/.exec(lines.join("\n"))!;

    const uuid = (JSON.parse(await ff.chrome<string>(`return JSON.stringify({ u: WebExtensionPolicy.getByID("jarod-reader@jarod.os").mozExtensionHostname })`)) as { u: string }).u;
    await ff.newTab(`moz-extension://${uuid}/options.html`);
    await ff.pageAsync(`const done = arguments[arguments.length - 1]; browser.storage.local.set({ pairing: { port: ${port}, key: "${key}" } }).then(() => done("ok"))`);
    const target = await ff.newTab(pageUrl);
    await ff.select(target);
    await ff.chrome(CLICK);

    const res = await done;

    expect(asked).toHaveLength(1);
    expect(res.read).toMatchObject({ host: "essai.localhost", title: "Page d'essai JAROD-OS (neutre)" });
    expect(res.read!.text).toBe("Bonjour : ceci est le texte convenu pour le premier essai de lecture ponctuelle.");
    const everything = JSON.stringify({ lines, res: res.audits });
    expect(everything).not.toContain("valeur-de-leurre");
    expect(everything).not.toContain("ne doit jamais être lu");
  }, 120_000);
});
