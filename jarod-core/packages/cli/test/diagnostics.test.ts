// SPECS-P5-CLI.md §3-§4 (c) : `jarod diagnostics` — archive MINIMALE (décision Q2 : aucune option pour y ajouter quoi que ce soit).
// BARRE D'EXPURGATION : des CANARIS plantés partout dans un profil réel (messages, mémoire, titres, documents indexés, secrets, persona, MCP, chemins,
// identifiants de messagerie, clé de la base) ne doivent figurer dans AUCUN fichier de l'archive extraite. Un seul canari présent = barre manquée.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { extractZip } from "@jarod/plugin-rag";
import { defaultKeyStores } from "@jarod/plugin-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCore } from "../src/context.js";
import { buildDiagnostics, defaultDiagnosticsName } from "../src/diagnostics.js";
import { main } from "../src/main.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-diag-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CANARIES = {
  apiKey: "sk-CANARI-CLEAPI-0123456789abcdef0123",
  // Assemblé à l'exécution : le garde du dépôt (b3-telegram-token) refuse la FORME d'un jeton de bot dans un fichier suivi.
  telegram: ["123456789", "CANARI_JETON_abcdefghijklmnopqrstuvwxyz0123"].join(":"),
  message: "PHRASE-CANARI-MESSAGE-7c1f",
  memory: "PHRASE-CANARI-MEMOIRE-9a2e",
  title: "PHRASE-CANARI-TITRE-3b8d",
  document: "PHRASE-CANARI-DOCUMENT-5d4c",
  documentName: "CANARI-NOM-DOCUMENT.pdf",
  persona: "PHRASE-CANARI-PERSONA-1e6a",
  workspace: "CANARI-DOSSIER-SECRET",
  mcp: "PHRASE-CANARI-MCP-8f0b",
  chatId: "424242424242",
  email: "canari-courriel@exemple.test",
  attachment: "CANARI-PIECE-JOINTE.png",
} as const;

const BLOB = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);

/** Profil réel : base chiffrée, rempli de canaris par le vrai cœur. */
async function plantedProfile(): Promise<{ root: string; dir: string }> {
  const root = temp();
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core, dataDir } = await openCore({ env: { JAROD_HOME: root } });
  try {
    const s = core.sessions.create(CANARIES.title);
    core.messages.add(s.id, { role: "user", content: CANARIES.message });
    core.memory.add(CANARIES.memory, "fact");
    core.settings.setSecret("provider:anthropic:apiKey", CANARIES.apiKey);
    core.settings.setSecret("gateway:telegram:token", CANARIES.telegram);
    core.settings.set("persona", CANARIES.persona);
    core.settings.set("workspace", `C:\\${CANARIES.workspace}`);
    core.settings.set("mcpServers", [
      { id: "m1", name: "x", command: "node", args: [], env: { SECRET: CANARIES.mcp }, enabled: false, headers: { Authorization: `Bearer ${CANARIES.mcp}` } },
    ] as never);
    core.settings.set("telegram", { enabled: true, allowedChatIds: [CANARIES.chatId] } as never);
    core.settings.set("email", { ...core.settings.get("email"), user: CANARIES.email, from: CANARIES.email } as never);
    (core.app as unknown as { storage: { db: { run(sql: string, ...a: unknown[]): void } } }).storage.db.run(
      "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, 0, ?, 4, ?, 'h', ?, 'm', 1)",
      CANARIES.documentName,
      CANARIES.document,
      BLOB,
      CANARIES.documentName,
    );
    mkdirSync(join(dataDir, "attachments"), { recursive: true });
    writeFileSync(join(dataDir, "attachments", CANARIES.attachment), CANARIES.message);
  } finally {
    await core.dispose();
  }
  return { root, dir: new ProfileManager(root).dirFor("travail") };
}

function readAll(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: p.slice(dir.length), text: readFileSync(p).toString("latin1") + readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

describe("jarod diagnostics — barre d'expurgation", () => {
  it("AUCUN canari dans aucun fichier de l'archive extraite (ni la clé de la base)", { timeout: 120_000 }, async () => {
    const { root, dir } = await plantedProfile();
    const { entries } = buildDiagnostics({ dataRoot: root, profile: "travail", version: "0.1.0" });
    const { createZip } = await import("@jarod/plugin-rag");
    const out = temp();
    const zip = join(out, "d.zip");
    writeFileSync(zip, createZip(entries));
    extractZip(readFileSync(zip), join(out, "x"));
    const files = readAll(join(out, "x"));
    expect(files.length).toBeGreaterThanOrEqual(5);

    const key = defaultKeyStores().map((s) => s.load(dir)).find(Boolean) as string;
    expect(key, "la clé de la base doit exister pour que le contrôle ait un sens").toBeTruthy();
    const needles = { ...CANARIES, dbKey: key };
    const leaks: string[] = [];
    for (const f of files)
      for (const [name, value] of Object.entries(needles)) if (f.text.includes(value)) leaks.push(`${name} dans ${f.path}`);
    // Même contrôle sur le ZIP brut (noms de fichiers compris).
    const raw = readFileSync(zip).toString("latin1");
    for (const [name, value] of Object.entries(needles)) if (raw.includes(value)) leaks.push(`${name} dans le ZIP brut`);
    expect(leaks, `fuites : ${leaks.join(" ; ")}`).toEqual([]);
  });

  it("le contenu : santé, versions, dossier (sans contenu), réglages non sensibles, notice", { timeout: 120_000 }, async () => {
    const { root } = await plantedProfile();
    const { entries } = buildDiagnostics({ dataRoot: root, profile: "travail", version: "9.9.9" });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["LISEZMOI.txt", "dossier.json", "reglages.json", "sante.json", "versions.json"]);
    const get = (n: string) => String(entries.find((e) => e.name === n)!.data);
    expect(JSON.parse(get("versions.json"))).toMatchObject({ jarod: "9.9.9", node: process.version, platform: process.platform });
    const settings = JSON.parse(get("reglages.json")) as Record<string, unknown>;
    expect(settings).toHaveProperty("activeProvider");
    expect(settings).toHaveProperty("ecosystem");
    expect(settings).toHaveProperty("rag");
    for (const forbidden of ["persona", "workspace", "mcpServers", "vault"]) expect(settings, forbidden).not.toHaveProperty(forbidden);
    expect(settings.telegram).toEqual({ enabled: true });
    expect(settings.email).toEqual({ enabled: false }); // jamais l'adresse ni le serveur : seulement le drapeau
    expect(JSON.parse(get("sante.json"))).toMatchObject({ checks: expect.any(Array) });
    expect(get("LISEZMOI.txt")).toMatch(/jamais/i);
    const folder = JSON.parse(get("dossier.json")) as { name: string; kind: string }[];
    expect(folder.map((f) => f.name)).toContain("jarod.db");
    expect(folder.find((f) => f.name === "attachments")).toMatchObject({ kind: "dossier" });
  });

  it("le dossier personnel est remplacé par ~ dans toute l'archive", { timeout: 120_000 }, async () => {
    const { root } = await plantedProfile();
    const { entries } = buildDiagnostics({ dataRoot: root, profile: "travail", version: "0.1.0" });
    const all = entries.map((e) => String(e.data)).join("\n");
    expect(all).not.toContain(homedir());
    expect(all).not.toContain(homedir().replace(/\\/g, "\\\\"));
    expect(all).toContain("~");
  });

  it("base illisible : l'archive se fait quand même, les réglages disent « indisponible »", { timeout: 60_000 }, () => {
    const root = temp();
    const pm = new ProfileManager(root);
    pm.create("neuf");
    pm.setActive("neuf");
    const { entries } = buildDiagnostics({ dataRoot: root, profile: "neuf", version: "0.1.0" });
    const settings = JSON.parse(String(entries.find((e) => e.name === "reglages.json")!.data)) as Record<string, unknown>;
    expect(settings).toHaveProperty("indisponible");
  });
});

describe("jarod diagnostics (ligne de commande)", () => {
  let saved: string | undefined;
  let err: string[] = [];
  beforeEach(() => {
    err = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
    saved = process.env.JAROD_HOME;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.JAROD_HOME;
    else process.env.JAROD_HOME = saved;
  });

  it("--out : écrit l'archive, refuse d'écraser un fichier existant", { timeout: 120_000 }, async () => {
    const { root } = await plantedProfile();
    process.env.JAROD_HOME = root;
    const out = join(temp(), "d.zip");
    expect(await main(["diagnostics", "--out", out])).toBe(0);
    expect(existsSync(out)).toBe(true);
    const size = statSync(out).size;
    writeFileSync(out, "pas touche");
    expect(await main(["diagnostics", "--out", out])).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("pas touche");
    expect(err.join("\n")).toMatch(/existe déjà/);
    expect(size).toBeGreaterThan(200);
  });

  it("nom par défaut : jarod-diagnostics-AAAAMMJJ-HHMMSS.zip", () => {
    expect(defaultDiagnosticsName(new Date(2026, 9, 2, 14, 5, 9))).toBe("jarod-diagnostics-20261002-140509.zip");
  });

  it("sans dossier de données : échec franc, rien d'écrit", async () => {
    process.env.JAROD_HOME = join(temp(), "inexistant");
    const out = join(temp(), "d.zip");
    expect(await main(["diagnostics", "--out", out])).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

