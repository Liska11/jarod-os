// E2 — effacement d'un profil jetable : le marqueur de propriété part EN DERNIER. Si Windows garde un fichier du navigateur verrouillé, le
// dossier reste AVEC son marqueur, et le prochain balayage peut finir le travail. Avant : `rmSync` récursif effaçait `owner.json` puis butait
// sur le profil verrouillé, laissant un dossier sans marqueur que plus rien ne nettoyait (14 dossiers de ~20 Mo trouvés dans %TEMP% le 2026-10-18).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDisposableProfile } from "../src/index.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-e2-"));
  made.push(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ ownerPid: 1, chromePid: 0, createdAt: 1 }));
  mkdirSync(join(dir, "chrome", "Default"), { recursive: true });
  writeFileSync(join(dir, "chrome", "Default", "Cookies"), "x");
  return dir;
}

describe("removeDisposableProfile", () => {
  it("efface tout, marqueur compris, quand rien n'est verrouillé", () => {
    const dir = profile();
    expect(removeDisposableProfile(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("garde le marqueur tant qu'une partie du profil résiste (fichier verrouillé)", () => {
    const dir = profile();
    const locked = (path: string, o: { recursive?: boolean; force?: boolean }) => {
      if (path.includes("chrome")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      rmSync(path, o);
    };
    expect(removeDisposableProfile(dir, locked)).toBe(false);
    expect(existsSync(join(dir, "owner.json"))).toBe(true);
    // une fois le verrou levé, le même appel termine
    expect(removeDisposableProfile(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("ne touche à rien hors d'un profil jetable", () => {
    const other = mkdtempSync(join(tmpdir(), "autre-"));
    made.push(other);
    writeFileSync(join(other, "gardien.txt"), "x");
    expect(removeDisposableProfile(other)).toBe(false);
    expect(existsSync(join(other, "gardien.txt"))).toBe(true);
  });
});
