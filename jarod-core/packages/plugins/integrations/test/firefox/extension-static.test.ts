// E2 / Firefox — ce que l'extension DÉCLARE et ce que son code PEUT faire, vérifié sur les fichiers eux-mêmes (manifeste et sources), indépendamment de tout navigateur.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "sidecars", "firefox-reader");
const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");
const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
/** Le code sans commentaires de ligne ni de bloc : les commentaires peuvent NOMMER ce qu'on interdit. */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/u)
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

describe("extension Firefox : manifeste", () => {
  it("permissions EXACTES : activeTab, scripting et (justifiée à part) storage ; aucune permission d'hôte", () => {
    expect([...(manifest.permissions as string[])].sort()).toEqual(["activeTab", "scripting", "storage"]);
    for (const k of ["host_permissions", "optional_permissions", "optional_host_permissions", "content_scripts", "web_accessible_resources", "externally_connectable", "commands", "devtools_page", "sidebar_action", "omnibox", "chrome_url_overrides", "declarative_net_request", "user_scripts", "content_security_policy"]) {
      expect(manifest, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/all_urls|\*:\/\/|<all|tabs"|cookies|history|downloads|debugger|nativeMessaging|webRequest|webNavigation|clipboard|bookmarks|management|proxy|privacy|geolocation|notifications/);
  });

  it("MV3, identifiant fixe, un bouton d'action sans fenêtre, un fond sans page persistante", () => {
    expect(manifest.manifest_version).toBe(3);
    expect((manifest.browser_specific_settings as { gecko: { id: string } }).gecko.id).toBe("jarod-reader@jarod.os");
    expect(manifest.action).toEqual({ default_title: expect.any(String) });
    expect(manifest.background).toEqual({ scripts: ["background.js"] });
    expect(Object.keys(manifest).sort()).toEqual(["action", "background", "browser_specific_settings", "description", "manifest_version", "name", "options_ui", "permissions", "version"]);
  });
});

describe("extension Firefox : ce que le code peut faire", () => {
  const bg = code("background.js");

  it("aucune énumération, aucune action sur la page ni sur le navigateur : pas de tabs.query/create/update/remove, de clic, de saisie, de navigation, de téléchargement, de cookie, d'historique", () => {
    const banned = [
      /tabs\.query/, /tabs\.create/, /tabs\.update/, /tabs\.remove/, /tabs\.reload/, /tabs\.captureTab/, /windows\./, /cookies/, /history/, /downloads/, /webRequest/, /webNavigation/, /bookmarks/, /sessions\./, /management\./,
      /\.click\(/, /\.submit\(/, /\.focus\(/, /dispatchEvent/, /\.value\s*=/, /innerHTML|outerHTML|insertAdjacent|document\.write/, /location\.(href|assign|replace)\s*=|location\.(assign|replace)\(/, /window\.open/,
      /\beval\(|new Function|importScripts|setTimeout\(\s*["'`]/, /XMLHttpRequest|sendBeacon|EventSource|WebSocket/, /allFrames|world\s*:\s*["']MAIN|files\s*:/, /querySelectorAll|document\.body|documentElement|outerText|getAttribute|\.cookie|localStorage|sessionStorage/,
    ];
    for (const re of banned) expect(bg, String(re)).not.toMatch(re);
  });

  it("deux injections seulement, toutes deux par FONCTION fixe dans le cadre principal (frameIds [0]) : poser un identifiant, puis lire l'élément convenu", () => {
    const calls = bg.match(/scripting\.executeScript\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(bg.match(/frameIds:\s*\[0\]/g)).toHaveLength(2);
    expect(bg).toMatch(/func:\s*stampDocument/);
    expect(bg).toMatch(/func:\s*readAgreedElement/);
    const read = /function readAgreedElement[\s\S]*?\n}\n/.exec(bg)![0];
    expect(read.match(/querySelector\(/g)).toHaveLength(2); // l'élément demandé (un seul) et la détection de champs enfants
    expect(read).toMatch(/closest\("form"\)/);
    expect(read).toMatch(/isContentEditable/);
    expect(read).toMatch(/slice\(0, 500\)/);
    expect(read).toMatch(/slice\(0, 200\)/);
  });

  it("le seul réseau est HTTP vers 127.0.0.1 (port d'appairage), sans cookies, jamais vers un autre hôte", () => {
    const fetches = bg.match(/fetch\(/g) ?? [];
    expect(fetches).toHaveLength(1);
    expect(bg).toMatch(/fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\$\{path\}`/);
    expect(bg).toMatch(/credentials:\s*"omit"/);
    expect(bg.match(/https?:\/\/[^\s`"')]+/g)?.filter((u) => !u.startsWith("http://127.0.0.1")) ?? []).toEqual([]);
  });

  it("la clé d'appairage reste dans storage.local : elle n'est jamais envoyée (seule la preuve HMAC l'est)", () => {
    expect(bg).toMatch(/storage\.local\.get\("pairing"\)/);
    expect(bg).not.toMatch(/storage\.local\.set/);
    expect(bg).not.toMatch(/JSON\.stringify\([^)]*pairing/);
    expect(bg).not.toMatch(/body:[^\n]*pairing\.key/);
    expect(bg).toMatch(/proof\(pairing\.key, nonce\)/);
  });

  it("le sélecteur est borné DEUX fois (côté extension et dans la page), et l'expiration est revérifiée à la lecture", () => {
    expect(bg.match(/\(\?:\[a-z\]\[a-z0-9-\]\*\)\?\(\?:#\[A-Za-z\]\[\\w-\]\*\)\?\(\?:\\\.\[A-Za-z\]\[\\w-\]\*\)\*/g)).toHaveLength(2);
    expect(bg).toMatch(/Date\.now\(\) > m\.expiresAt/);
    expect(bg).toMatch(/__jarodDoc !== docId/);
    expect(bg).toMatch(/location\.origin !== origin/);
  });

  it("la page d'options n'écrit que le code d'appairage dans storage.local et n'a aucun accès au réseau ni aux onglets", () => {
    const o = code("options.js");
    expect(o).toMatch(/storage\.local\.set\(\{ pairing: \{ port: Number\(m\[1\]\), key: m\[2\] \} \}\)/);
    expect(o).not.toMatch(/fetch|tabs\.|scripting|runtime\.sendMessage/);
  });
});
