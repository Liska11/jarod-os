// Import Hermes → Jarod : lecture de `mcp_servers`, traduction (tout désactivé, jeton OAuth → Bearer), copie des skills sans écrasement.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillFolders, importFromHermes, type ImportTarget, mapMcpServers, planSkills, readMcpServers } from "../src/hermes-import.js";

const YAML = `model:
  default: x
mcp_servers:
  Sequential-Thinking:
    args:
      - C:\\Users\\San\\node_modules/server/index.js
    command: S:/Backups/bin/node.exe
    connect_timeout: 60
    enabled: true
    env: {}
  airtable:
    url: https://mcp.airtable.com/mcp
    auth: oauth
    enabled: true
  cloudflare:
    url: https://mcp.cloudflare.com/mcp?codemode=false
    auth: oauth
    tools:
      exclude:
        - docs
        - '*_radar_*'
  qwen:
    command: node
    env:
      NODE_PATH: 'a b'
      PORT: 8080
other:
  x: 1
`;

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hermes-import-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readMcpServers", () => {
  it("lit les entrées : scalaires, listes, objets vides, filtres imbriqués ; s'arrête au bloc suivant", () => {
    const servers = readMcpServers(YAML);

    expect(Object.keys(servers)).toEqual(["Sequential-Thinking", "airtable", "cloudflare", "qwen"]);
    expect(servers["Sequential-Thinking"]).toEqual({ args: ["C:\\Users\\San\\node_modules/server/index.js"], command: "S:/Backups/bin/node.exe", connect_timeout: 60, enabled: true, env: {} });
    expect(servers.cloudflare).toMatchObject({ url: "https://mcp.cloudflare.com/mcp?codemode=false", tools: { exclude: ["docs", "*_radar_*"] } });
    expect(servers.qwen).toEqual({ command: "node", env: { NODE_PATH: "a b", PORT: 8080 } });
  });

  it("rend une entrée illisible comme erreur sans perdre les autres", () => {
    const servers = readMcpServers("mcp_servers:\n  bon:\n    command: x\n  mauvais:\n    args: [a, b]\n");

    expect(servers.bon).toEqual({ command: "x" });
    expect(servers.mauvais).toMatchObject({ error: expect.stringContaining("YAML en ligne") });
  });

  it("sans bloc mcp_servers : rien", () => {
    expect(readMcpServers("model:\n  a: 1\n")).toEqual({});
  });
});

describe("mapMcpServers", () => {
  const now = Date.UTC(2026, 9, 12);
  const raw = readMcpServers(YAML);
  const tokens: Record<string, { access_token: string; token_type: string; expires_at: number }> = {
    airtable: { access_token: "AT-SECRET", token_type: "bearer", expires_at: now / 1000 + 600 },
    cloudflare: { access_token: "CF-SECRET", token_type: "bearer", expires_at: now / 1000 - 86400 },
  };

  it("importe tout DÉSACTIVÉ ; un serveur distant OAuth reçoit son jeton en Authorization: Bearer", () => {
    const { servers } = mapMcpServers(raw, (n) => tokens[n], [], now);

    expect(servers.map((s) => [s.id, s.enabled])).toEqual([["sequential-thinking", false], ["airtable", false], ["cloudflare", false], ["qwen", false]]);
    expect(servers.find((s) => s.name === "airtable")).toMatchObject({ url: "https://mcp.airtable.com/mcp", headers: { Authorization: "Bearer AT-SECRET" } });
    expect(servers.find((s) => s.name === "qwen")).toMatchObject({ command: "node", env: { NODE_PATH: "a b", PORT: "8080" } });
  });

  it("le compte rendu ne contient aucune valeur secrète et signale jeton expiré, filtre d'outils perdu, commande absente", () => {
    const absent = join(tmp(), "absent", "node.exe");
    const { notes } = mapMcpServers({ ...raw, "Sequential-Thinking": { command: absent } }, (n) => tokens[n], [], now);
    const text = notes.join("\n");

    expect(text).not.toContain("SECRET");
    expect(text).toContain("cloudflare : jeton d'accès copié — déjà expiré le 2026-10-11");
    expect(text).toContain("cloudflare : filtre d'outils (exclude)");
    expect(text).toContain(`Sequential-Thinking : la commande ${absent} n'existe pas`);
  });

  it("OAuth sans jeton chez Hermes : signalé, pas d'en-tête", () => {
    const { servers, notes } = mapMcpServers(raw, () => undefined, [], now);

    expect(servers.find((s) => s.name === "airtable")?.headers).toBeUndefined();
    expect(notes).toContain("airtable : OAuth sans jeton chez Hermes, à reconnecter");
  });

  it("ne remplace pas un serveur de même nom et donne un identifiant libre", () => {
    const existing: McpServerConfig[] = [{ id: "airtable", name: "Airtable", command: "x", args: [], env: {}, enabled: true }, { id: "qwen", name: "mien", command: "y", args: [], env: {}, enabled: true }];
    const { servers, skipped } = mapMcpServers(raw, () => undefined, existing, now);

    expect(skipped).toEqual([{ name: "airtable", reason: "un serveur de ce nom existe déjà dans Jarod" }]);
    expect(servers.find((s) => s.name === "qwen")?.id).toBe("qwen-2");
  });
});

const skill = (root: string, rel: string, body = "---\nname: x\n---\ncorps"): void => {
  mkdirSync(join(root, ...rel.split("/")), { recursive: true });
  writeFileSync(join(root, ...rel.split("/"), "SKILL.md"), body, "utf8");
};

describe("skills", () => {
  it("découvre comme Jarod : catégories, pas de descente dans un skill, dossiers pointés ignorés", async () => {
    const root = tmp();
    skill(root, "plat");
    skill(root, "creative/ascii-art");
    skill(root, "creative/sub/deep");
    skill(root, "plat/interne");
    skill(root, ".archive/vieux");

    const found = await discoverSkillFolders(root);

    expect(found.map((f) => f.rel)).toEqual(["plat", "creative/ascii-art", "creative/sub/deep"]);
  });

  it("plan : le premier gagne, un identifiant déjà chez Jarod n'est pas recopié, un dossier d'arrivée existant est laissé", () => {
    const a = [{ id: "x", rel: "cat/x", path: "/a/cat/x" }, { id: "y", rel: "y", path: "/a/y" }, { id: "z", rel: "z", path: "/a/z" }];
    const b = [{ id: "x", rel: "x", path: "/b/x" }, { id: "w", rel: "w", path: "/b/w" }];

    const plan = planSkills([{ label: "A", folders: a }, { label: "B", folders: b }], new Set(["y"]), (rel) => rel === "z");

    expect(plan.copy.map((f) => f.rel)).toEqual(["cat/x", "w"]);
    expect(plan.duplicates).toEqual([{ id: "y", rel: "y", keptFrom: "Jarod" }, { id: "x", rel: "x", keptFrom: "A/cat/x" }]);
    expect(plan.present).toEqual(["z"]);
  });
});

function fakeTarget(skillsDir: string, existing: string[] = []): ImportTarget & { store: { disabledSkills: string[]; mcpServers: McpServerConfig[] } } {
  const store = { disabledSkills: [] as string[], mcpServers: [] as McpServerConfig[] };
  return {
    store,
    settings: {
      get: ((key: "mcpServers" | "disabledSkills") => store[key]) as never,
      set: ((key: "mcpServers" | "disabledSkills", value: never) => {
        store[key] = value;
      }) as never,
    },
    skills: { dir: skillsDir, list: () => existing.map((id) => ({ id })), reload: async () => {} },
  };
}

describe("importFromHermes", () => {
  function hermesHome(): string {
    const home = tmp();
    skill(join(home, "skills"), "creative/ascii-art", "---\nname: ascii\n---\nbody");
    skill(join(home, "skills"), "devops/deploy");
    writeFileSync(join(home, "skills", "devops", "deploy", "notes.txt"), "annexe", "utf8");
    writeFileSync(join(home, "config.yaml"), "mcp_servers:\n  airtable:\n    url: https://mcp.airtable.com/mcp\n    auth: oauth\n", "utf8");
    mkdirSync(join(home, "mcp-tokens"));
    writeFileSync(join(home, "mcp-tokens", "airtable.json"), JSON.stringify({ access_token: "AT", token_type: "bearer", expires_at: 9e9 }), "utf8");
    return home;
  }

  it("simulation : calcule tout, n'écrit rien", async () => {
    const dir = tmp();
    const target = fakeTarget(join(dir, "skills"));

    const result = await importFromHermes(target, { hermesHome: hermesHome(), apply: false });

    expect(result.skills.copy.map((f) => f.rel)).toEqual(["creative/ascii-art", "devops/deploy"]);
    expect(result.mcp.servers).toHaveLength(1);
    expect(existsSync(join(dir, "skills"))).toBe(false);
    expect(target.store).toEqual({ disabledSkills: [], mcpServers: [] });
  });

  it("applique : copie les dossiers entiers, désactive les importés (sans toucher aux autres), ajoute les MCP désactivés", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "skills"));
    const target = fakeTarget(join(dir, "skills"), ["revue-de-code"]);
    target.store.disabledSkills = ["autre"];
    target.store.mcpServers = [{ id: "mien", name: "mien", command: "x", args: [], env: {}, enabled: true }];

    const result = await importFromHermes(target, { hermesHome: hermesHome(), apply: true });

    expect(result.skills).toMatchObject({ copied: 2, disabled: 2 });
    expect(readFileSync(join(dir, "skills", "devops", "deploy", "notes.txt"), "utf8")).toBe("annexe");
    expect(target.store.disabledSkills.sort()).toEqual(["ascii-art", "autre", "deploy"]);
    expect(target.store.mcpServers.map((s) => [s.name, s.enabled])).toEqual([["mien", true], ["airtable", false]]);
    expect(target.store.mcpServers[1]!.headers).toEqual({ Authorization: "Bearer AT" });
  });

  it("rejouer l'import ne change rien (aucun doublon, aucun écrasement)", async () => {
    const dir = tmp();
    const home = hermesHome();
    const target = fakeTarget(join(dir, "skills"));
    await importFromHermes(target, { hermesHome: home, apply: true });
    writeFileSync(join(dir, "skills", "devops", "deploy", "SKILL.md"), "modifié par l'utilisateur", "utf8");
    // le registre voit maintenant les skills copiés
    target.skills.list = () => [{ id: "ascii-art" }, { id: "deploy" }];

    const again = await importFromHermes(target, { hermesHome: home, apply: true });

    expect(again.skills.copied).toBe(0);
    expect(again.mcp.servers).toHaveLength(0);
    expect(target.store.mcpServers).toHaveLength(1);
    expect(readFileSync(join(dir, "skills", "devops", "deploy", "SKILL.md"), "utf8")).toBe("modifié par l'utilisateur");
  });
});
