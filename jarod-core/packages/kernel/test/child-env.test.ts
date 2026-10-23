// L'environnement des enfants (2026-10-22) : des FAUX secrets sentinelles (aucune vraie valeur) montrent ce qui descend, et dans quel enfant.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { childEnv, DEAD_PROXY, isInternalSecretName, isSecretShapedName, scrubbedNames } from "../src/child-env.js";
import { DEFAULT_POLICY, type NetworkPolicy } from "../src/network.js";

const S = (n: string) => `SENTINELLE-${n}-0000`;
const base: NodeJS.ProcessEnv = {
  Path: "C:/Windows/System32",
  SystemRoot: "C:/Windows",
  TEMP: "C:/Temp",
  APPDATA: "C:/Users/x/AppData/Roaming",
  ELECTRON_RUN_AS_NODE: "1",
  SSH_AUTH_SOCK: "//./pipe/openssh-ssh-agent",
  JAROD_GATEWAY_TOKEN: S("gateway"),
  JAROD_OS_CONTROL_TOKEN: S("control"),
  JAROD_OS_CONTROL_SOCKET: "//./pipe/jarod-control",
  HERMES_OS_CONTROL_TOKEN: S("hermes"),
  JAROD_SLACK_BOT_TOKEN: S("slack"),
  ANTHROPIC_API_KEY: S("anthropic"),
  GITHUB_TOKEN: S("github"),
  AWS_SECRET_ACCESS_KEY: S("aws"),
  DB_PASSWORD: S("db"),
  PATHEXT: ".COM;.EXE",
};

const values = (env: NodeJS.ProcessEnv) => Object.values(env).filter((v): v is string => typeof v === "string");
const leaks = (env: NodeJS.ProcessEnv) => values(env).filter((v) => v.startsWith("SENTINELLE-"));

describe("childEnv", () => {
  it("MCP tiers : ni jeton interne, ni clé de fournisseur, ni variable en forme de secret ; Windows et le lancement empaqueté intacts", () => {
    const env = childEnv("mcp", { base });
    expect(leaks(env)).toEqual([]);
    expect(env.Path).toBe(base.Path);
    expect(env.SystemRoot).toBe(base.SystemRoot);
    expect(env.APPDATA).toBe(base.APPDATA);
    expect(env.PATHEXT).toBe(base.PATHEXT);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.SSH_AUTH_SOCK).toBeDefined();
  });

  it("MCP : ce que SA configuration nomme reste utilisable, même en forme de secret, et seulement pour lui", () => {
    const allowed = childEnv("mcp", { base, explicit: { GITHUB_TOKEN: S("configuré") } });
    expect(allowed.GITHUB_TOKEN).toBe(S("configuré"));
    expect(leaks(allowed)).toEqual([S("configuré")]);
    // Un autre serveur, sans cette configuration, ne le reçoit pas.
    expect(childEnv("mcp", { base }).GITHUB_TOKEN).toBeUndefined();
  });

  it("un jeton interne ne passe pas, même nommé explicitement par erreur de casse ailleurs : la configuration l'emporte seulement APRÈS le filtre", () => {
    const env = childEnv("mcp", { base, explicit: { Github_Token: S("x") } });
    expect(env.Github_Token).toBe(S("x"));
    expect(env.JAROD_GATEWAY_TOKEN).toBeUndefined();
  });

  it("MCP : une configuration ne peut pas réintroduire un jeton interne filtré (toute casse) ; ses propres identifiants passent", () => {
    const env = childEnv("mcp", {
      base,
      explicit: { JAROD_GATEWAY_TOKEN: S("copie"), jarod_os_control_token: S("copie2"), JAROD_SLACK_BOT_TOKEN: S("copie3"), GITHUB_TOKEN: S("propre") },
    });
    expect(env.JAROD_GATEWAY_TOKEN).toBeUndefined();
    expect(env.jarod_os_control_token).toBeUndefined();
    expect(env.JAROD_SLACK_BOT_TOKEN).toBeUndefined();
    expect(leaks(env)).toEqual([S("propre")]);
    expect(env.GITHUB_TOKEN).toBe(S("propre"));
    // Les enfants de l'agent (secret injecté au point d'usage, choisi par l'utilisateur) gardent leur liberté.
    expect(childEnv("agent-shell", { base, explicit: { JAROD_GATEWAY_TOKEN: S("voulu") } }).JAROD_GATEWAY_TOKEN).toBe(S("voulu"));
  });

  it("agent et moteurs : sans jeton interne ni clé de fournisseur de Jarod, mais les outils de l'utilisateur gardent leurs identifiants", () => {
    for (const kind of ["agent-shell", "engine"] as const) {
      const env = childEnv(kind, { base });
      expect(env.JAROD_GATEWAY_TOKEN).toBeUndefined();
      expect(env.JAROD_OS_CONTROL_TOKEN).toBeUndefined();
      expect(env.JAROD_OS_CONTROL_SOCKET).toBeUndefined();
      expect(env.HERMES_OS_CONTROL_TOKEN).toBeUndefined();
      expect(env.JAROD_SLACK_BOT_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBe(S("github"));
      expect(env.AWS_SECRET_ACCESS_KEY).toBe(S("aws"));
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    }
  });

  it("un secret injecté au point d'usage (explicit) est présent pour cette commande seulement", () => {
    const env = childEnv("agent-shell", { base, explicit: { MON_SECRET: S("injecté") } });
    expect(env.MON_SECRET).toBe(S("injecté"));
    expect(childEnv("agent-shell", { base }).MON_SECRET).toBeUndefined();
  });

  it("n'écrit pas dans l'environnement de départ et conserve la casse d'origine des noms (Path)", () => {
    const copy = { ...base };
    const env = childEnv("mcp", { base });
    expect(base).toEqual(copy);
    expect(Object.keys(env)).toContain("Path");
    expect(Object.keys(env)).not.toContain("PATH");
  });

  it("scrubbedNames ne rend que des noms", () => {
    const names = scrubbedNames("mcp", base);
    expect(names).toContain("JAROD_GATEWAY_TOKEN");
    expect(names).toContain("GITHUB_TOKEN");
    expect(JSON.stringify(names)).not.toContain("SENTINELLE");
  });

  it("classement des noms", () => {
    for (const n of ["JAROD_GATEWAY_TOKEN", "jarod_os_control_token", "JAROD_DISCORD_TOKEN", "HERMES_FOO_API_KEY", `${["HER", "ALD"].join("")}_OS_CONTROL_TOKEN`]) expect(isInternalSecretName(n)).toBe(true);
    for (const n of ["JAROD_HOME", "JAROD_OS_ROOT", "JAROD_SHELL_EXE", "PATH", "SSH_AUTH_SOCK"]) expect(isInternalSecretName(n)).toBe(false);
    for (const n of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "NPM_TOKEN", "OPENAI_API_KEY", "client_secret", "AZURE_CREDENTIALS"]) expect(isSecretShapedName(n)).toBe(true);
    for (const n of ["PATH", "TEMP", "KEYBOARD_LAYOUT", "TOKENIZERS_PARALLELISM_X", "SSH_AUTH_SOCK", "APPDATA", "MONKEY"]) expect(isSecretShapedName(n)).toBe(false);
  });

  it("de bout en bout : un vrai processus enfant ne voit pas la sentinelle retirée et voit celle autorisée", () => {
    const env = childEnv("mcp", { base: { ...process.env, JAROD_GATEWAY_TOKEN: S("gateway"), API_TOKEN: S("ambiant") }, explicit: { TOKEN_AUTORISE: S("ok") } });
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write([process.env.JAROD_GATEWAY_TOKEN,process.env.API_TOKEN,process.env.TOKEN_AUTORISE].map(String).join('|'))"], { env, encoding: "utf8" });
    expect(r.stdout).toBe(`undefined|undefined|${S("ok")}`);
  });
});

// V-05 : Internet coupé, l'enfant reçoit un proxy mort (couche pour les programmes qui suivent les variables de proxy ; pas un isolement).
describe("enfants et interrupteur Internet (V-05)", () => {
  const offline: NetworkPolicy = { ...DEFAULT_POLICY, internet: false };

  it("Internet coupé : proxy mort dans toutes les casses, boucle locale et machines distantes autorisées en exception, Node le suit", () => {
    const env = childEnv("agent-shell", { base: { PATH: "x", https_proxy: "http://corp:3128", Http_Proxy: "http://corp:3128" }, policy: { ...offline, remoteMachines: true, remoteHosts: ["100.64.0.7"] } });
    for (const n of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[n]).toBe(DEAD_PROXY);
    expect(env.Http_Proxy).toBeUndefined();
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.localhost,100.64.0.7");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
    expect(env.PATH).toBe("x");
  });

  it("une configuration ne réintroduit pas son propre proxy pour sortir ; Internet actif, rien n'est ajouté", () => {
    expect(childEnv("mcp", { base: {}, explicit: { HTTPS_PROXY: "http://sortie:8080" }, policy: offline }).HTTPS_PROXY).toBe(DEAD_PROXY);
    const on = childEnv("mcp", { base: { PATH: "x" }, explicit: { HTTPS_PROXY: "http://corp:3128" }, policy: DEFAULT_POLICY });
    expect(on).toEqual({ PATH: "x", HTTPS_PROXY: "http://corp:3128" });
    // Sans politique fournie et sans lecteur branché : celle du processus, Internet permis comme avant.
    expect(childEnv("engine", { base: { PATH: "x" } })).toEqual({ PATH: "x" });
  });

  // `NODE_USE_ENV_PROXY` (fetch et http de Node suivent HTTP(S)_PROXY) : vérifié avec Node 24 ; une version plus ancienne l'ignore peut-être,
  // c'est pourquoi l'essai n'y est pas présenté comme une preuve.
  it.runIf(Number(process.versions.node.split(".")[0]) >= 24)("de bout en bout : un vrai enfant Node passe par le proxy mort et échoue AUSSITÔT (aucune adresse publique n'est jointe)", () => {
    // TEST-NET-3 n'est jamais routé : sans proxy, l'essai attendrait son délai ; par le proxy mort, refus immédiat sur 127.0.0.1:9.
    const js = "fetch('http://203.0.113.9/',{signal:AbortSignal.timeout(8000)}).then(()=>console.log('OK'),e=>console.log(String(e.cause?.code??e.name)))";
    const started = Date.now();
    const r = spawnSync(process.execPath, ["-e", js], { env: childEnv("engine", { policy: offline }), encoding: "utf8", timeout: 20_000 });
    expect(r.stdout.trim()).toBe("ECONNREFUSED");
    expect(Date.now() - started).toBeLessThan(6_000);
  });
});
