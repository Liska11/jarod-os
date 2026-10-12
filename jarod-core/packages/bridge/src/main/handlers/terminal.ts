/**
 * Les shells de cette machine (liste fermée) : ce que le réglage `terminalShell` accepte. Le terminal intégré lui-même (pseudo-terminal `node-pty`) n'est
 * PAS porté dans Jarod-OS (décision de l'utilisateur : pty écarté) ; seule la détection reste, parce que le réglage existe dans le noyau.
 */
import { readFileSync } from "node:fs";
import { detectShells, type ShellInfo } from "../terminal.js";
import type { HandlerContext } from "./context.js";

/** Les shells de cette machine (liste fermée) ; injectable pour les tests. */
export function shellsOf(ctx: HandlerContext): ShellInfo[] {
  return (
    ctx.terminals?.shells?.() ??
    detectShells(process.platform, undefined, process.env, (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return "";
      }
    })
  );
}
