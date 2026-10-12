// Le fichier de jeton de la passerelle : droits restreints sous Windows (`icacls`), effacé à l'arrêt.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hardenSecretFile, removeSecretFile, writeSecretFile } from "../src/gateway/secret-file.js";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarod-secret-"));
  dirs.push(dir);
  const file = join(dir, "gateway.json");
  writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:1", token: "jeton" }));
  return file;
}

afterEach(() => {
  // Le garde `temp-dirs-cleaned` exige que le dossier créé soit supprimé, pas seulement le fichier.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Faux `icacls` : enregistre l'appel et rend le code demandé. */
function fakeRun(status = 0, error?: Error) {
  const calls: { command: string; args: string[] }[] = [];
  const run = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { status, error } as ReturnType<typeof spawnSync>;
  }) as unknown as typeof spawnSync;
  return { calls, run };
}

/** Isole les variables d'environnement du poste (compte et domaine réels) le temps d'un test. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("hardenSecretFile", () => {
  it("sous Windows, retire les droits hérités et n'accorde que le compte courant", () => {
    withEnv({ USERNAME: "Sam", USERDOMAIN: undefined }, () => {
      const file = tempFile();
      const { calls, run } = fakeRun();
      expect(hardenSecretFile(file, { platform: "win32", run })).toEqual({ applied: true, user: "Sam" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe("icacls");
      expect(calls[0]!.args).toEqual([file, "/inheritance:r", "/grant:r", "Sam:F"]);
    });
  });

  it("qualifie le compte par son domaine quand Windows en donne un", () => {
    withEnv({ USERNAME: "Sam", USERDOMAIN: "BUREAU" }, () => {
      const { calls, run } = fakeRun();
      expect(hardenSecretFile("C:\\profil\\gateway.json", { platform: "win32", run }).user).toBe("BUREAU\\Sam");
      expect(calls[0]!.args[3]).toBe("BUREAU\\Sam:F");
    });
  });

  it("ne touche à rien là où `0o600` suffit (macOS, Linux)", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { calls, run } = fakeRun();
      expect(hardenSecretFile(tempFile(), { platform, user: "Sam", run })).toEqual({ applied: false });
      expect(calls).toEqual([]);
    }
  });

  it("rapporte l'échec d'icacls sans jeter (la passerelle doit continuer de servir)", () => {
    withEnv({ USERNAME: "Sam", USERDOMAIN: undefined }, () => {
      const failed = hardenSecretFile(tempFile(), { platform: "win32", run: fakeRun(1).run });
      expect(failed.applied).toBe(false);
      expect(failed.error).toContain("code 1");
      expect(failed.user).toBe("Sam");

      const missing = hardenSecretFile(tempFile(), { platform: "win32", run: fakeRun(0, new Error("icacls introuvable")).run });
      expect(missing.applied).toBe(false);
      expect(missing.error).toContain("icacls introuvable");
    });
  });

  it("ne lance rien sans compte utilisateur connu", () => {
    withEnv({ USERNAME: undefined }, () => {
      const { calls, run } = fakeRun();
      const result = hardenSecretFile(tempFile(), { platform: "win32", run });
      expect(calls).toEqual([]);
      expect(result.applied).toBe(false);
      expect(result.error).toContain("USERNAME");
    });
  });
});

describe("writeSecretFile", () => {
  it("écrit le fichier de jeton puis le restreint (chemin unique d'écriture de la passerelle)", () => {
    withEnv({ USERNAME: "Sam", USERDOMAIN: undefined }, () => {
      const file = tempFile();
      const { calls, run } = fakeRun();
      const result = writeSecretFile(file, '{"url":"http://127.0.0.1:1","token":"jeton"}', { platform: "win32", run });
      expect(readFileSync(file, "utf8")).toBe('{"url":"http://127.0.0.1:1","token":"jeton"}');
      expect(result.applied).toBe(true);
      expect(calls[0]!.command).toBe("icacls");
      expect(calls[0]!.args.slice(0, 2)).toEqual([file, "/inheritance:r"]);
    });
  });

  it("écrit le fichier même si la restriction échoue, et le dit", () => {
    const file = tempFile();
    const result = writeSecretFile(file, "jeton-en-clair", { platform: "win32", user: "Sam", run: fakeRun(1).run });
    expect(readFileSync(file, "utf8")).toBe("jeton-en-clair");
    expect(result.applied).toBe(false);
    expect(result.error).toContain("code 1");
  });
});

describe("removeSecretFile", () => {
  it("efface le fichier, et ne jette pas s'il n'est plus là", () => {
    const file = tempFile();
    expect(existsSync(file)).toBe(true);
    removeSecretFile(file);
    expect(existsSync(file)).toBe(false);
    expect(() => removeSecretFile(file)).not.toThrow();
  });
});
