/**
 * Extraits à l'identique de packages/core/src/services/lsp.ts:77-103 (rév. 2e180305) : `findOnPath`
 * est importé par android, github, speech, terminal — plusieurs plugins, donc ici (comme `util.ts`).
 * Le module LSP (plugin-tools, Q1 = A) le ré-exportera quand il sera porté.
 */
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Finds an executable on PATH (with PATHEXT on Windows). */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | null {
  if (isAbsolute(command)) return isFile(command) ? command : null;
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
