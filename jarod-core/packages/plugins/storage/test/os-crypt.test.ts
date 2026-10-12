/**
 * B3 — secrets `ss:` du desktop (Electron safeStorage = os_crypt de Chromium sous Windows) lus hors Electron
 * (CLI `jarod serve`, gates). Jetons FICTIFS seulement ; la lecture réelle par le vrai Electron est prouvée par
 * l'e2e desktop (`ui.e2e.test.ts`, visite des écrans).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dpapiProtect, dpapiUnprotect, electronSecretsCipher, electronUserDataDir, osCryptDecrypt, osCryptEncrypt, readOsCryptKey } from "../src/os-crypt.js";
import { makeCore, tempDir } from "./helpers.js";

const FAKE = "000000:jarod-test-fake-token";

/** `Local State` comme Chromium l'écrit, la « protection » DPAPI remplacée par l'identité (hors test Windows réel). */
function localState(key: Buffer, protect: (b: Buffer) => Buffer = (b) => b): string {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const encrypted_key = Buffer.concat([Buffer.from("DPAPI", "latin1"), protect(key)]).toString("base64");
  writeFileSync(join(dir, "Local State"), JSON.stringify({ os_crypt: { audit_enabled: true, encrypted_key } }));
  return dir;
}

const ss = (key: Buffer, plain: string) => `ss:${osCryptEncrypt(key, plain).toString("base64")}`;

describe("B3 — secrets safeStorage lus hors Electron", () => {
  it("userData du desktop : JAROD_USER_DATA, sinon <appData>/Jarod-One (comme app.setPath)", () => {
    expect(electronUserDataDir({ JAROD_USER_DATA: "X:\\ud", APPDATA: "C:\\A" }, "win32")).toBe("X:\\ud");
    expect(electronUserDataDir({ APPDATA: "C:\\A" }, "win32")).toBe(join("C:\\A", "Jarod-One"));
    expect(electronUserDataDir({}, "darwin", "/Users/a")).toBe(join("/Users/a", "Library", "Application Support", "Jarod-One"));
    expect(electronUserDataDir({}, "linux", "/home/a")).toBe(join("/home/a", ".config", "Jarod-One"));
  });

  it("v10 : AES-256-GCM, format « v10 » + nonce + chiffré + étiquette ; mauvaise clé ou valeur altérée → erreur", () => {
    const key = randomBytes(32);
    const blob = osCryptEncrypt(key, FAKE);
    expect(blob.subarray(0, 3).toString("latin1")).toBe("v10");
    expect(blob.length).toBe(3 + 12 + Buffer.byteLength(FAKE) + 16);
    expect(blob.includes(Buffer.from(FAKE))).toBe(false);
    expect(osCryptDecrypt(key, blob)).toBe(FAKE);
    expect(() => osCryptDecrypt(randomBytes(32), blob)).toThrow();
    const altered = Buffer.from(blob);
    altered[20]! ^= 1;
    expect(() => osCryptDecrypt(key, altered)).toThrow();
  });

  it("chiffreur : lit ss: (clé de Local State chargée une fois) et pl: ; écrit pl: ; refuse le reste", () => {
    const key = randomBytes(32);
    const unprotect = vi.fn((b: Buffer) => b);
    const c = electronSecretsCipher(localState(key), { platform: "win32", unprotect });
    // Valeur non v10 : refus AVANT de toucher à Local State.
    expect(() => c.decrypt(`ss:${Buffer.from("desktop-key").toString("base64")}`)).toThrow(/v10/);
    expect(unprotect).not.toHaveBeenCalled();
    expect(c.decrypt(ss(key, FAKE))).toBe(FAKE);
    expect(c.decrypt(ss(key, "autre"))).toBe("autre");
    expect(unprotect).toHaveBeenCalledTimes(1);
    expect(c.decrypt(c.encrypt("clair"))).toBe("clair");
    expect(c.encrypt("clair")).toMatch(/^pl:/);
    expect(() => c.decrypt("brut")).toThrow(/format inconnu/);
    expect(() => electronSecretsCipher(localState(key), { platform: "linux", unprotect }).decrypt(ss(key, FAKE))).toThrow(/Windows seulement/);
    expect(() => electronSecretsCipher(tempDir(), { platform: "win32", unprotect }).decrypt(ss(key, FAKE))).toThrow(/Local State/);
  });

  it("coffre du profil : settings.getSecret rend le jeton ss: ; clé os_crypt étrangère → absent, jamais d'exception", async () => {
    const key = randomBytes(32);
    const core = await makeCore({ cipher: electronSecretsCipher(localState(key), { platform: "win32", unprotect: (b) => b }) });
    core.db.run("INSERT INTO secrets (key, value) VALUES (?, ?)", "gateway:telegram:token", ss(key, FAKE));
    core.db.run("INSERT INTO secrets (key, value) VALUES (?, ?)", "autre", ss(randomBytes(32), FAKE));
    expect(core.settings.getSecret("gateway:telegram:token")).toBe(FAKE);
    expect(core.settings.getSecret("autre")).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("Windows : vrai DPAPI du compte (sans entropie, comme Chromium) → clé de Local State → jeton", { timeout: 60_000 }, () => {
    const key = randomBytes(32);
    const protectedKey = dpapiProtect(key);
    expect(protectedKey.equals(key)).toBe(false);
    expect(dpapiUnprotect(protectedKey).equals(key)).toBe(true);
    const dir = localState(key, () => protectedKey);
    expect(readOsCryptKey(dir).equals(key)).toBe(true);
    expect(electronSecretsCipher(dir).decrypt(ss(key, FAKE))).toBe(FAKE);
  });
});
