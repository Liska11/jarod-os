/**
 * Aides de test (`@jarod/plugin-updates/testing`) : fabrique un dossier d'installeurs tel que `pnpm dist` le laisse
 * (installeur + `.blockmap` electron-builder + manifeste), pour que les tests exercent les VRAIES vérifications.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { writeChannelManifest } from "./updates.js";

/** Un `.blockmap` v2 valide pour un installeur de `size` octets (un seul bloc : la somme des tailles = `size`). */
export function fakeBlockmap(size: number): Buffer {
  return gzipSync(JSON.stringify({ version: "2", files: [{ name: "file", offset: 0, checksums: ["AAAAAAAAAAAAAAAAAAAAAAAA"], sizes: [size] }] }));
}

/** Dépose un installeur COMPLET (`Jarod-One-<version>-setup.exe`, blockmap valide, manifeste) ; rend son chemin. */
export async function writeInstaller(folder: string, version: string, content = `installeur ${version}`): Promise<string> {
  const installer = join(folder, `Jarod-One-${version}-setup.exe`);
  writeFileSync(installer, content);
  writeFileSync(`${installer}.blockmap`, fakeBlockmap(Buffer.byteLength(content)));
  await writeChannelManifest(installer, version);
  return installer;
}
