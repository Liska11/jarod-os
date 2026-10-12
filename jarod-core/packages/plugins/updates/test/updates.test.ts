// Portage de packages/core/test/updates.test.ts (rév. 2e180305), + AV2-003 (intégrité du canal local).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptsVersion,
  compareVersions,
  findLocalUpdate,
  isPrerelease,
  isValidBlockmap,
  parseManifest,
  resolveChannel,
  sha512File,
  verifyInstaller,
  stageLocalFeed,
  writeChannelManifest,
} from "../src/updates.js";
import { fakeBlockmap, writeInstaller } from "../src/testing.js";

const dirs: string[] = [];
const emptyFolder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-updates-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
};
/** Un dossier tel que `pnpm dist` le laisse : installeur, blockmap valide, manifeste. */
const built = async (...versions: string[]): Promise<string> => {
  const dir = emptyFolder();
  for (const v of versions) await writeInstaller(dir, v);
  return dir;
};
/** Fichiers nus (sans blockmap ni manifeste) : ce que les anciens tests prenaient pour un installeur fini. */
const bare = (files: string[]): string => {
  const dir = emptyFolder();
  for (const file of files) writeFileSync(join(dir, file), "installeur");
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isPrerelease", () => {
  it("tells a beta from a release, with or without the leading v", () => {
    expect(isPrerelease("1.2.0")).toBe(false);
    expect(isPrerelease("1.2.0-beta.1")).toBe(true);
    expect(isPrerelease("v1.2.0-beta.1")).toBe(true);
    expect(isPrerelease("v1.2.0")).toBe(false);
    // A four-part version is not a pre-release.
    expect(isPrerelease("1.2.0.1")).toBe(false);
  });
});

describe("resolveChannel", () => {
  it("follows the running version when nothing is configured", () => {
    expect(resolveChannel("", "1.2.0")).toBe("stable");
    expect(resolveChannel(undefined, "1.2.0-beta.1")).toBe("beta");
  });

  it("lets an explicit choice win over the version", () => {
    expect(resolveChannel("stable", "1.2.0-beta.1")).toBe("stable");
    expect(resolveChannel("beta", "1.2.0")).toBe("beta");
  });

  it("ignores a value it does not understand rather than trusting it", () => {
    expect(resolveChannel("nightly", "1.2.0")).toBe("stable");
    expect(resolveChannel("nightly", "1.2.0-rc.1")).toBe("beta");
  });
});

describe("acceptsVersion", () => {
  it("keeps pre-releases away from a stable installation", () => {
    expect(acceptsVersion("stable", "1.3.0")).toBe(true);
    expect(acceptsVersion("stable", "1.3.0-beta.1")).toBe(false);
    expect(acceptsVersion("beta", "1.3.0-beta.1")).toBe(true);
    expect(acceptsVersion("beta", "1.3.0")).toBe(true);
  });
});

describe("findLocalUpdate", () => {
  it("offers a stable release, and never a beta to a stable installation", async () => {
    const dir = await built("1.2.0", "1.3.0-beta.1");
    expect(findLocalUpdate("1.1.0", dir, "stable")?.version).toBe("1.2.0");
    // The beta is the newest of the two, and still the wrong answer for a stable user.
    expect(findLocalUpdate("1.1.0", dir, "beta")?.version).toBe("1.3.0-beta.1");
  });

  it("keeps the safe default when a caller forgets to say", async () => {
    const dir = await built("1.3.0-beta.1");
    expect(findLocalUpdate("1.1.0", dir)).toBeNull();
  });

  it("offers the plain release to someone who was running a beta", async () => {
    // Switching back to stable has to hand over the release of the same base version.
    const dir = await built("1.2.0");
    expect(findLocalUpdate("1.2.0-beta.3", dir, "stable")?.version).toBe("1.2.0");
  });

  it("ignores an installer whose build had not finished", () => {
    const dir = bare(["Jarod-One-1.2.0-setup.exe"]);
    expect(findLocalUpdate("1.1.0", dir, "stable")).toBeNull();
  });

  it("takes the highest version, not the first one it reads", async () => {
    const dir = await built("1.10.0", "1.9.0", "1.2.0");
    expect(findLocalUpdate("1.1.0", dir, "stable")?.version).toBe("1.10.0");
  });

  it("ignores the portable build, which is not an installer", () => {
    const dir = bare(["Jarod-One 1.4.0.exe"]);
    expect(findLocalUpdate("1.1.0", dir, "stable")).toBeNull();
  });

  it("says nothing when the folder is unset or absent", () => {
    expect(findLocalUpdate("1.1.0", "", "stable")).toBeNull();
    expect(findLocalUpdate("1.1.0", join(tmpdir(), "jarod-dossier-absent"), "stable")).toBeNull();
  });

  it("reconnaît le nom du paquet courant (`artifactName` du builder), pas seulement les anciens noms", () => {
    const dir = emptyFolder();
    const names = ["Jarod-One-1.2.0-setup.exe", "Jarod-One-Setup-1.3.0.exe", "Jarod-One Setup 1.4.0.exe"];
    const manifest = ["version: 1.4.0", "files:"];
    for (const name of names) {
      writeFileSync(join(dir, name), "x");
      writeFileSync(join(dir, `${name}.blockmap`), fakeBlockmap(1));
      manifest.push(`  - url: ${name.replaceAll(" ", "%20")}`, "    sha512: AAAA", "    size: 1");
    }
    writeFileSync(join(dir, "latest.yml"), `${manifest.join("\n")}\n`);
    expect(findLocalUpdate("1.1.0", dir, "stable")?.version).toBe("1.4.0");
    expect(findLocalUpdate("1.3.0", dir, "stable")?.version).toBe("1.4.0");
    expect(findLocalUpdate("1.4.0", dir, "stable")).toBeNull();
  });
});

describe("AV2-003 — un `.blockmap` vide ne suffit plus", () => {
  it("blockmap vide, texte, gzip non JSON, version inconnue, sans bloc, somme fausse ou taille négative : pas proposé", async () => {
    const mauvais: [string, Buffer | string][] = [
      ["vide", ""],
      ["texte", "x"],
      ["gzip non JSON", gzipSync("pas du json")],
      ["version inconnue", gzipSync(JSON.stringify({ version: "9", files: [{ sizes: [10], checksums: ["a"] }] }))],
      ["aucun bloc", gzipSync(JSON.stringify({ version: "2", files: [{ sizes: [], checksums: [] }] }))],
      ["somme fausse", gzipSync(JSON.stringify({ version: "2", files: [{ sizes: [3], checksums: ["a"] }] }))],
      ["taille négative", gzipSync(JSON.stringify({ version: "2", files: [{ sizes: [-5, 100], checksums: ["a", "b"] }] }))],
    ];
    for (const [quoi, contenu] of mauvais) {
      const dir = await built("1.2.0");
      writeFileSync(join(dir, "Jarod-One-1.2.0-setup.exe.blockmap"), contenu);
      expect(findLocalUpdate("1.1.0", dir, "stable"), quoi).toBeNull();
    }
  });

  it("isValidBlockmap : valide pour la bonne taille, invalide pour une autre ou un fichier absent", () => {
    const dir = emptyFolder();
    const f = join(dir, "x.blockmap");
    writeFileSync(f, fakeBlockmap(42));
    expect(isValidBlockmap(f, 42)).toBe(true);
    expect(isValidBlockmap(f, 43)).toBe(false);
    expect(isValidBlockmap(join(dir, "absent.blockmap"), 42)).toBe(false);
  });

  it("sans manifeste, installeur absent du manifeste, ou taille différente : pas proposé", async () => {
    const dir = await built("1.2.0");
    rmSync(join(dir, "latest.yml"));
    expect(findLocalUpdate("1.1.0", dir, "stable")).toBeNull();

    const autre = await built("1.2.0");
    writeFileSync(join(autre, "latest.yml"), "version: 1.2.0\nfiles:\n  - url: Jarod-One-1.9.9-setup.exe\n    sha512: abc\n    size: 5\n");
    expect(findLocalUpdate("1.1.0", autre, "stable")).toBeNull();

    const gros = await built("1.2.0");
    writeFileSync(join(gros, "Jarod-One-1.2.0-setup.exe"), "contenu de taille différente de celle du manifeste");
    expect(findLocalUpdate("1.1.0", gros, "stable")).toBeNull();
  });

  it("l'offre porte la taille et le sha512 du manifeste", async () => {
    const dir = await built("1.2.0");
    const info = findLocalUpdate("1.1.0", dir, "stable")!;
    expect(info.sha512).toBe(await sha512File(info.installer));
    expect(info.size).toBe(Buffer.byteLength("installeur 1.2.0"));
  });
});

describe("AV2-003 — verifyInstaller : aucune exécution sans empreinte exacte", () => {
  it("la copie identique passe ; un octet changé, une taille changée, ou un fichier absent : refus", async () => {
    const dir = await built("1.2.0");
    const { installer, sha512, size } = findLocalUpdate("1.1.0", dir, "stable")!;
    await expect(verifyInstaller(installer, { sha512, size })).resolves.toBeUndefined();

    writeFileSync(installer, "installeur 1.2.1"); // même longueur, un caractère change
    await expect(verifyInstaller(installer, { sha512, size })).rejects.toThrow(/sha512 différent/);
    writeFileSync(installer, "installeur 1.2.0 + charge");
    await expect(verifyInstaller(installer, { sha512, size })).rejects.toThrow(/taille/);
    rmSync(installer);
    await expect(verifyInstaller(installer, { sha512, size })).rejects.toThrow();
  });
});

describe("manifeste (format electron-updater)", () => {
  it("parseManifest : lit files[], décode les noms, ignore ce qui n'est pas files", () => {
    const text = [
      "version: 1.0.0",
      "files:",
      "  - url: Jarod-One%20Setup%201.0.0.exe",
      "    sha512: AAA=",
      "    size: 12",
      "  - url: 'b.exe'",
      '    sha512: "BBB="',
      "    size: 7",
      "path: b.exe",
      "sha512: ZZZ=",
      "",
    ].join("\n");
    expect([...parseManifest(text)]).toEqual([
      ["Jarod-One Setup 1.0.0.exe", { sha512: "AAA=", size: 12 }],
      ["b.exe", { sha512: "BBB=", size: 7 }],
    ]);
  });

  it("entrée incomplète (sans sha512 ou sans taille) : ignorée, jamais devinée", () => {
    expect(parseManifest("files:\n  - url: a.exe\n    size: 3\n  - url: b.exe\n    sha512: X\n").size).toBe(0);
  });

  it("writeChannelManifest : latest.yml pour une version stable, beta.yml pour une préversion, entrées cumulées", async () => {
    const dir = emptyFolder();
    const a = join(dir, "Jarod-One-1.2.0-setup.exe");
    const b = join(dir, "Jarod-One-1.3.0-beta.1-setup.exe");
    const c = join(dir, "Jarod-One-1.2.1-setup.exe");
    writeFileSync(a, "a");
    writeFileSync(b, "bb");
    writeFileSync(c, "ccc");
    expect((await writeChannelManifest(a, "1.2.0")).endsWith("latest.yml")).toBe(true);
    expect((await writeChannelManifest(b, "1.3.0-beta.1")).endsWith("beta.yml")).toBe(true);
    await writeChannelManifest(c, "1.2.1");
    const stable = parseManifest(readFileSync(join(dir, "latest.yml"), "utf8"));
    expect([...stable.keys()]).toEqual(["Jarod-One-1.2.0-setup.exe", "Jarod-One-1.2.1-setup.exe"]);
    expect(stable.get("Jarod-One-1.2.1-setup.exe")).toEqual({ sha512: await sha512File(c), size: 3 });
  });
});

describe("stageLocalFeed", () => {
  it("monte un dossier de repli (installeur, blockmap, manifeste) SANS toucher au latest.yml du builder", async () => {
    const dist = await built("1.4.0");
    const builderManifest = join(dist, "latest.yml");
    writeFileSync(builderManifest, "propriété d'electron-builder\n");
    const installer = join(dist, "Jarod-One-1.4.0-setup.exe");
    const out = join(dist, "local-feed");
    const manifest = await stageLocalFeed(installer, "1.4.0", out);
    expect(manifest).toBe(join(out, "latest.yml"));
    expect(readFileSync(builderManifest, "utf8")).toBe("propriété d'electron-builder\n");
    expect(readdirSync(out).sort()).toEqual(["Jarod-One-1.4.0-setup.exe", "Jarod-One-1.4.0-setup.exe.blockmap", "latest.yml"]);
    expect(parseManifest(readFileSync(manifest, "utf8")).get("Jarod-One-1.4.0-setup.exe")).toEqual({ sha512: await sha512File(installer), size: statSync(installer).size });
    // Rejouable : un second passage remplace les fichiers sans échouer (lien dur déjà présent).
    await stageLocalFeed(installer, "1.4.0", out);
    // Le dossier est exploitable tel quel par le canal local.
    expect(findLocalUpdate("1.3.0", out, "stable")?.version).toBe("1.4.0");
  });
});

describe("compareVersions", () => {
  it("orders releases, pre-releases and their numbering", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBe(-1);
    expect(compareVersions("1.2.0-beta.10", "1.2.0-beta.2")).toBe(1);
    expect(compareVersions("1.2.0-alpha", "1.2.0-beta")).toBe(-1);
  });
});
