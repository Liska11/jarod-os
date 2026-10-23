// V-15 — import Hermes complet : mémoire, persona, tâches planifiées, bots, en simulation (`--dry-run`, rien d'écrit) puis appliqué sur un
// VRAI cœur Jarod (openCore sur un profil jetable). Aucun jeton de bot n'est jamais copié ni rendu.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import { configHomeChannels, hasKey, importFromHermes, mapMcpServers, planBots, planCron, planMemory, planPersona, readDotEnv, readMcpServers, readMemoryEntries } from "../src/hermes-import.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hermes-import-full-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "123456:jeton-factice-qui-ne-doit-jamais-sortir";

const job = (over: Record<string, unknown>) => ({
  id: "j",
  name: "Veille",
  prompt: "Fais la veille",
  schedule: { kind: "cron", expr: "0 0 * * *", display: "0 0 * * *" },
  deliver: "local",
  script: null,
  no_agent: false,
  model: null,
  ...over,
});

function hermesHome(): string {
  const home = tmp();
  mkdirSync(join(home, "memories"));
  writeFileSync(join(home, "memories", "MEMORY.md"), "Le dépôt est sur D:\r\n§\r\nLes sauvegardes vont sur S:\n§\n\n§\nLe dépôt est sur D:", "utf8");
  writeFileSync(join(home, "memories", "USER.md"), "Préfère le français\n§\nRéponses courtes", "utf8");
  writeFileSync(join(home, "SOUL.md"), "Tu es un assistant posé.\n", "utf8");
  mkdirSync(join(home, "cron"));
  writeFileSync(
    join(home, "cron", "jobs.json"),
    JSON.stringify({
      jobs: [
        job({ name: "Veille", deliver: "telegram", model: "x/y" }),
        job({ name: "Hebdo", schedule: { kind: "interval", minutes: 720 }, deliver: "discord:42" }),
        job({ name: "Script", script: "backup.py", no_agent: true }),
        job({ name: "Vide", prompt: "  " }),
        job({ name: "Bizarre", schedule: { kind: "lunaire" } }),
      ],
      updated_at: "2026-10-23",
    }),
    "utf8",
  );
  writeFileSync(join(home, ".env"), `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOWED_USERS=111, 222\nDISCORD_ALLOWED_USERS="333"\nOPENAI_API_KEY=sk-factice\n`, "utf8");
  writeFileSync(join(home, "config.yaml"), "TELEGRAM_HOME_CHANNEL: '111'\nmcp_servers:\n  fs:\n    command: node\n    tools:\n      include:\n        - read\n        - list\n", "utf8");
  return home;
}

describe("V-15 — morceaux purs", () => {
  it("mémoire : entrées séparées par §, CRLF compris ; doublons et déjà présentes comptées, jamais ajoutées", () => {
    expect(readMemoryEntries("a\r\n§\r\nb\n§\n\n§\nc")).toEqual(["a", "b", "c"]);
    const plan = planMemory({ fact: ["a", "b", "a"], preference: ["p"] }, new Set(["b"]));
    expect(plan.add).toEqual([
      { content: "a", type: "fact" },
      { content: "p", type: "preference" },
    ]);
    expect(plan.present).toBe(2);
  });

  it("persona : écrite seulement si Jarod n'en a pas ; un SOUL.md vide n'écrit rien", () => {
    expect(planPersona("Tu es…", "")).toEqual({ action: "write", chars: 6 });
    expect(planPersona("Tu es…", "déjà là")).toMatchObject({ action: "skip" });
    expect(planPersona("  ", "")).toMatchObject({ action: "skip" });
    expect(planPersona(undefined, "")).toMatchObject({ action: "skip" });
  });

  it("tâches : cron, intervalle, une fois ; script, consigne vide, horaire inconnu et nom pris ignorés avec la raison", () => {
    const plan = planCron(
      {
        jobs: [
          job({ name: "A", deliver: "telegram" }),
          job({ name: "B", schedule: { kind: "once", run_at: "2030-01-01T00:00:00Z" } }),
          job({ name: "C", script: "x.py" }),
          job({ name: "Prise" }),
          job({ name: "D", deliver: "telegram" }),
        ],
      },
      new Set(["prise"]),
      { telegram: "999" },
    );
    expect(plan.add.map((a) => [a.name, a.spec.kind, a.deliver?.chatId ?? null])).toEqual([
      ["A", "cron", "999"],
      ["B", "once", null],
      ["D", "cron", "999"],
    ]);
    expect(plan.skipped.map((s) => s.name)).toEqual(["C", "Prise"]);
    // Sans canal d'accueil, la livraison n'est pas devinée : elle est dite.
    const lost = planCron({ jobs: [job({ name: "E", deliver: "telegram" })] }, new Set(), {});
    expect(lost.add[0]!.deliver).toBeNull();
    expect(lost.notes[0]).toMatch(/pas de canal d'accueil/);
    expect(planCron(null, new Set(), {}).add).toEqual([]);
  });

  it("bots : listes d'accès lues, jetons DÉTECTÉS jamais lus ; liste de Jarod jamais remplacée", () => {
    const env = `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_ALLOWED_USERS=111,222\nDISCORD_ALLOWED_USERS=333\n`;
    expect(readDotEnv(env, ["TELEGRAM_ALLOWED_USERS"])).toEqual({ TELEGRAM_ALLOWED_USERS: "111,222" });
    expect(hasKey(env, "TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(hasKey(env, "SLACK_BOT_TOKEN")).toBe(false);
    const plan = planBots(env, {}, { telegram: [], discord: ["déjà"], slack: [] });
    expect(plan.allow).toEqual([{ gateway: "telegram", ids: ["111", "222"] }]);
    expect(plan.notes.join("\n")).toMatch(/discord : Jarod a déjà sa liste/);
    expect(plan.notes.join("\n")).toMatch(/jeton présent chez Hermes, NON copié/);
    expect(JSON.stringify(plan)).not.toContain(TOKEN);
    expect(configHomeChannels("TELEGRAM_HOME_CHANNEL: '-100'\nx: 1\n")).toEqual({ telegram: "-100" });
  });

  it("MCP : un filtre `include` de noms exacts devient la liste blanche (V-14) ; un motif ou un exclude est signalé", () => {
    const raw = readMcpServers("mcp_servers:\n  a:\n    command: node\n    tools:\n      include:\n        - read\n        - read\n  b:\n    command: node\n    tools:\n      include:\n        - 'r*'\n  c:\n    command: node\n    tools:\n      exclude:\n        - x\n");
    const r = mapMcpServers(raw, () => undefined, []);
    expect(r.servers.map((s) => [s.name, s.allowedTools ?? null])).toEqual([
      ["a", ["read"]],
      ["b", null],
      ["c", null],
    ]);
    expect(r.notes.filter((n) => /Serveurs MCP › Outils/.test(n))).toHaveLength(2);
  });
});

describe("V-15 — import complet sur un vrai cœur", () => {
  it("--dry-run n'écrit rien ; --apply importe mémoire, persona, tâches (désactivées), listes d'accès (passerelles éteintes) ; une 2e passe n'ajoute rien", async () => {
    const root = tmp();
    const pm = new ProfileManager(root);
    pm.create("essai");
    pm.setActive("essai");
    const home = hermesHome();
    const { core } = await openCore({ env: { JAROD_HOME: root } });
    try {
      const target = {
        settings: core.settings,
        skills: core.skills,
        memory: core.memory,
        ...(core.persona ? { persona: core.persona } : {}),
        scheduler: core.scheduler,
        bots: { get: (k: "telegram" | "discord" | "slack") => core.settings.get(k), set: (k: "telegram" | "discord" | "slack", v: Record<string, unknown>) => core.settings.set(k, v as never) },
      };
      const before = { memories: core.memory.list().length, schedules: core.scheduler.list().length, telegram: core.settings.get("telegram") };

      const dry = await importFromHermes(target as never, { hermesHome: home, apply: false });
      expect(dry.memory).toMatchObject({ added: 0, present: 1 });
      expect(dry.memory!.add).toHaveLength(4);
      expect(dry.cron!.add.map((c) => c.name)).toEqual(["Veille", "Hebdo"]);
      expect(dry.cron!.skipped.map((s) => s.name)).toEqual(["Script", "Vide", "Bizarre"]);
      expect(dry.bots!.allow.map((a) => a.gateway)).toEqual(["telegram", "discord"]);
      expect(dry.mcp.servers[0]!.allowedTools).toEqual(["list", "read"]);
      // Rien n'a bougé.
      expect(core.memory.list()).toHaveLength(before.memories);
      expect(core.scheduler.list()).toHaveLength(before.schedules);
      expect(core.settings.get("telegram")).toEqual(before.telegram);
      expect(core.settings.get("mcpServers")).toEqual([]);
      if (core.persona) expect(core.persona.read()).toBe("");
      expect(JSON.stringify(dry)).not.toContain(TOKEN);

      const done = await importFromHermes(target as never, { hermesHome: home, apply: true });
      expect(done.memory!.added).toBe(4);
      expect(core.memory.list("fact").map((m) => m.content).sort()).toEqual(["Le dépôt est sur D:", "Les sauvegardes vont sur S:"]);
      expect(core.memory.list("preference").map((m) => m.content).sort()).toEqual(["Préfère le français", "Réponses courtes"]);
      if (core.persona) expect(core.persona.read()).toBe("Tu es un assistant posé.\n");
      const schedules = core.scheduler.list();
      expect(schedules.map((s) => [s.name, s.enabled, s.deliver?.gateway ?? null, s.deliver?.chatId ?? null]).sort()).toEqual([
        ["Hebdo", false, "discord", "42"],
        ["Veille", false, "telegram", "111"],
      ]);
      expect(core.settings.get("telegram")).toMatchObject({ enabled: false, allowedChatIds: ["111", "222"] });
      expect(core.settings.get("discord")).toMatchObject({ enabled: false, allowedUserIds: ["333"] });
      expect(core.settings.get("mcpServers")[0]).toMatchObject({ name: "fs", enabled: false, allowedTools: ["list", "read"] });
      // Le jeton n'est arrivé nulle part : ni réglage, ni coffre.
      expect(JSON.stringify(core.settings.get("telegram"))).not.toContain(TOKEN);
      expect(core.settings.secretKeys().map((k) => core.settings.getSecret(k))).not.toContain(TOKEN);

      // Deuxième passe : tout est déjà là.
      const again = await importFromHermes(target as never, { hermesHome: home, apply: true });
      expect(again.memory).toMatchObject({ added: 0, present: 5 });
      expect(again.cron!.created).toBe(0);
      expect(again.persona).toMatchObject({ action: "skip" });
      expect(again.bots!.applied).toBe(0);
      expect(core.scheduler.list()).toHaveLength(2);
    } finally {
      await core.dispose();
    }
  }, 60_000);
});
