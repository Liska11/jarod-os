// Ce que les intégrations transmettent à leurs processus enfants : jamais `process.env` en bloc (kernel/src/child-env.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxedEnv } from "../src/impl/sandboxie.js";
import { smolvmEnv } from "../src/impl/smolvm.js";

const SRC = join(import.meta.dirname, "..", "src");

afterEach(() => {
  vi.unstubAllEnvs();
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** Chaque appel `execFile(…)`/`spawn(…)` (parenthèses équilibrées) d'un fichier source. */
function launches(text: string): string[] {
  const out: string[] = [];
  const re = /\b(execFile|execFileSync|spawn|spawnSync)\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

describe("environnement des processus lancés par les intégrations", () => {
  it("le programme d'un bac Sandboxie ne reçoit ni jeton de Jarod, ni clé de fournisseur, ni secret de l'utilisateur", () => {
    vi.stubEnv("JAROD_GATEWAY_TOKEN", "gw");
    vi.stubEnv("JAROD_OS_CONTROL_TOKEN", "ctl");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk");
    vi.stubEnv("GITHUB_TOKEN", "ghp");
    const env = sandboxedEnv();
    for (const name of ["JAROD_GATEWAY_TOKEN", "JAROD_OS_CONTROL_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) expect(env[name], name).toBeUndefined();
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it("smolvm, moteur lancé par Jarod : sans jeton de contrôle ni clé de fournisseur", () => {
    vi.stubEnv("JAROD_GATEWAY_TOKEN", "gw");
    vi.stubEnv("OPENAI_API_KEY", "sk");
    const env = smolvmEnv();
    expect(env.JAROD_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("aucun lancement des sources n'hérite de l'environnement, sauf taskkill (qui ne fait que tuer un PID)", () => {
    const bare: string[] = [];
    for (const file of sources(SRC)) {
      for (const call of launches(readFileSync(file, "utf8"))) {
        // `spawn()` sans argument : la fabrique injectée (uia-sidecar), dont l'appelant passe l'environnement.
        if (/\benv\b/.test(call) || /^\w+\(\)$/.test(call) || /^\w+\("taskkill"/.test(call)) continue;
        bare.push(`${file.slice(SRC.length + 1)}: ${call.slice(0, 80)}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
