// SPECS-P5-MCP.md §3 bis et barre (g) : les trois gardes de l'exposition de la mémoire pleine (Q4, figées le 2026-10-02).
//  G1 démarrage MANUEL seulement · G2 stdio seulement (aucun socket) · G3 avertissement documenté dans l'aide.
// G1 et G2 statiques sont des tests de dépôt (heuristiques lexicales, dites telles) ; G2 d'exécution est dans mcp-profile.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP } from "../src/main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const SRC = (f: string) => readFileSync(join(HERE, "..", "src", f), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "out", ".git", ".work", "test", "tests", "docling-venv", "ov-bge-m3-int8"].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name) && st.size < 2_000_000) out.push(p);
  }
  return out;
}

describe("G3 — avertissement documenté dans l'aide", () => {
  it("l'aide dit : TOUTE la mémoire, fournisseur de modèle, lecture seule, démarrage manuel, stdio sans port réseau", () => {
    expect(HELP).toMatch(/AVERTISSEMENT — jarod mcp/);
    expect(HELP).toContain("TOUTE la mémoire");
    expect(HELP).toContain("fournisseur");
    expect(HELP).toMatch(/de modèle/);
    expect(HELP).toMatch(/lecture seule/i);
    expect(HELP).toMatch(/démarrage manuel/i);
    expect(HELP).toMatch(/aucun port réseau/i);
    // La ligne de la commande elle-même renvoie à l'avertissement.
    expect(HELP).toMatch(/jarod mcp .*lecture seule/);
  });
});

describe("G2 — localhost seulement : aucun module réseau dans le serveur et son transport", () => {
  it("jsonrpc-stdio.ts et mcp-server.ts n'importent ni net, http, https, http2, tls, dgram, dns, ni n'appellent fetch/WebSocket", () => {
    for (const f of ["jsonrpc-stdio.ts", "mcp-server.ts"]) {
      const src = SRC(f);
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, f).not.toMatch(/from\s+["'](?:node:)?(?:net|http|https|http2|tls|dgram|dns|cluster)["']/);
      expect(code, f).not.toMatch(/require\(\s*["'](?:node:)?(?:net|http|https|http2|tls|dgram|dns)["']\s*\)/);
      expect(code, f).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/);
      expect(code, f).not.toMatch(/\.listen\s*\(/);
    }
  });
});

describe("G1 — démarrage manuel : aucun chemin de code ne lance `jarod mcp`", () => {
  it("hors main.ts et mcp-server.ts, aucune source n'appelle mcpCommand/createMcpHandlers ni ne lance une sous-commande `mcp`", () => {
    const allowed = new Set([join(HERE, "..", "src", "main.ts"), join(HERE, "..", "src", "mcp-server.ts")]);
    const offenders: string[] = [];
    for (const root of ["packages", "scripts"]) {
      for (const file of walk(join(ROOT, root))) {
        if (allowed.has(file)) continue;
        const text = readFileSync(file, "utf8");
        if (/\bmcpCommand\s*\(|\bcreateMcpServerHandlers\s*\(|from\s+["'][^"']*\/mcp-server(?:\.js)?["']/.test(text)) offenders.push(`${relative(ROOT, file)} (appel direct)`);
        // spawn/exec/fork dont la liste d'arguments contient la sous-commande "mcp" de Jarod (main.ts … "mcp"), à quelques lignes près.
        if (/(?:spawn|exec|execFile|fork)\w*\s*\([\s\S]{0,300}main\.(?:ts|js)[\s\S]{0,120}["']mcp["']/.test(text)) offenders.push(`${relative(ROOT, file)} (lancement)`);
        if (/["']jarod["']\s*,\s*\[?\s*["']mcp["']/.test(text)) offenders.push(`${relative(ROOT, file)} (commande jarod mcp)`);
      }
    }
    expect(offenders, offenders.join(" ; ")).toEqual([]);
  });

  it("le serveur n'écrit dans aucune configuration de client MCP (Claude, Cursor, Codex…)", () => {
    for (const f of ["jsonrpc-stdio.ts", "mcp-server.ts"]) {
      const code = SRC(f).replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/claude_desktop_config|\.claude|\.cursor|\.codex|mcp\.json|\.mcp\b|settings\.json/i);
    }
    // Les seules écritures de fichier du serveur : le journal d'audit.
    const code = SRC("mcp-server.ts").replace(/\/\/.*$/gm, "");
    expect([...new Set(code.match(/(?:writeFile|appendFile|createWriteStream|renameSync|mkdirSync)\w*/g))].sort()).toEqual(["appendFileSync", "mkdirSync", "renameSync"]);
  });

  it("aucune écriture de base : la source de données du serveur n'expose que des lectures", () => {
    const code = SRC("mcp-server.ts").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.(?:add|set|delete|update|remove|create|run|rename|setPinned|setSecret)\s*\(/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Mêmes gardes pour `jarod acp` (SPECS-P5-ACP.md §3, §4) : démarrage MANUEL (lancé par l'éditeur de l'utilisateur), stdio seulement, aucune
// écriture dans la configuration de l'éditeur, aide qui dit ce qu'il fait.
describe("acp — démarrage manuel, stdio seulement, aide", () => {
  const ACP_FILES = ["acp-agent.ts", "acp-events.ts", "acp-permission.ts", "jsonrpc-stdio.ts"];

  it("aucun module réseau dans l'agent ACP, ses événements, ses autorisations ni le transport", () => {
    for (const f of ACP_FILES) {
      const code = SRC(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, f).not.toMatch(/from\s+["'](?:node:)?(?:net|http|https|http2|tls|dgram|dns|cluster)["']/);
      expect(code, f).not.toMatch(/\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/);
      expect(code, f).not.toMatch(/\.listen\s*\(/);
    }
  });

  it("l'agent ACP n'importe pas le SDK ACP (dépendance de TEST seulement) ni le SDK MCP", () => {
    for (const f of ACP_FILES.concat(["mcp-server.ts"])) {
      const code = SRC(f).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/import type[^;]*;/g, "");
      expect(code, f).not.toMatch(/@agentclientprotocol\/sdk|@modelcontextprotocol\//);
    }
  });

  it("hors main.ts et acp-agent.ts, aucune source n'appelle acpCommand ni ne lance la sous-commande `acp`", () => {
    const allowed = new Set([join(HERE, "..", "src", "main.ts"), join(HERE, "..", "src", "acp-agent.ts")]);
    const offenders: string[] = [];
    for (const root of ["packages", "scripts"]) {
      for (const file of walk(join(ROOT, root))) {
        if (allowed.has(file)) continue;
        const text = readFileSync(file, "utf8");
        if (/\bacpCommand\s*\(|\bcreateAcpHandlers\s*\(|from\s+["'][^"']*\/acp-agent(?:\.js)?["']/.test(text)) offenders.push(`${relative(ROOT, file)} (appel direct)`);
        if (/(?:spawn|exec|execFile|fork)\w*\s*\([\s\S]{0,300}main\.(?:ts|js)[\s\S]{0,120}["']acp["']/.test(text)) offenders.push(`${relative(ROOT, file)} (lancement)`);
        if (/["']jarod["']\s*,\s*\[?\s*["']acp["']/.test(text)) offenders.push(`${relative(ROOT, file)} (commande jarod acp)`);
      }
    }
    expect(offenders, offenders.join(" ; ")).toEqual([]);
  });

  it("aucune écriture dans la configuration d'un éditeur (Zed, JetBrains, VS Code) ni aucun fichier hors cœur dans le code ACP", () => {
    for (const f of ACP_FILES) {
      const code = SRC(f).replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\.config\/zed|settings\.json|\.idea|\.vscode|acp\.json|agent_servers/i);
      expect(code, f).not.toMatch(/\b(?:writeFile|appendFile|createWriteStream|mkdirSync|renameSync|unlink|rmSync)\w*/);
    }
  });

  it("l'aide dit ce que fait `acp` : accord dans l'éditeur, refus après 300 s, MCP et fichiers de l'éditeur non utilisés, démarrage manuel, stdio", () => {
    expect(HELP).toMatch(/jarod acp .*Agent ACP/);
    expect(HELP).not.toMatch(/jarod acp .*pas encore disponible/);
    expect(HELP).toContain("DANS l'éditeur");
    expect(HELP).toContain("300 s");
    expect(HELP).toMatch(/jamais « toujours »/);
    expect(HELP).toMatch(/ne sont pas utilisés/);
  });
});
