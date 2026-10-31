// L'agent se règle lui-même : liste blanche, types respectés, un chemin pointé ne remplace qu'une feuille, jamais de valeur de clé API.
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@jarod/contracts";
import { AGENT_SETTINGS, planSetting, settingsTools } from "../src/settings-tools.js";

const ctx = {} as never;

function fake(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const sets: [string, unknown][] = [];
  const store = {
    get: (k: string) => (data.has(k) ? data.get(k) : (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]),
    set: (k: string, v: unknown) => {
      sets.push([k, v]);
      data.set(k, v);
    },
    secretKeys: () => ["GROQ_API_KEY", "ELEVENLABS_API_KEY"],
  };
  return { store, sets };
}

describe("liste blanche des réglages de l'agent", () => {
  it("chaque réglage ouvert existe dans le schéma", () => {
    for (const k of AGENT_SETTINGS) expect(Object.hasOwn(DEFAULT_SETTINGS, k), k).toBe(true);
  });

  it("ce qui donne des droits ou ouvre un canal reste fermé", () => {
    for (const k of ["autoApproveTools", "alwaysAllowTools", "permissionsRules", "pluginTrust", "shellGuard", "machineFiles", "safetyFloor", "mcpServers", "vault", "remote", "mobile", "phoneApprovals", "apiServer", "webhooks", "connectedBrowser", "telegram", "discord", "slack", "email", "whatsapp", "contextProxy", "providerOverrides", "workspace", "terminalShell", "accessProfile", "lsp", "android", "localEngine", "rag"]) {
      expect(AGENT_SETTINGS.has(k), k).toBe(false);
    }
  });
});

describe("planSetting", () => {
  it("refuse une clé réservée en le disant, et une clé inconnue", () => {
    expect(() => planSetting("autoApproveTools", true, false)).toThrow(/réservé à l'utilisateur/);
    expect(() => planSetting("nimporte", 1, undefined)).toThrow(/inconnu/);
  });

  it("exige le type du réglage", () => {
    expect(() => planSetting("thinking", "oui", true)).toThrow(/boolean/);
    expect(() => planSetting("fallbacks", "x", [])).toThrow(/liste/);
    expect(planSetting("maxAgentSteps", 40, 25)).toEqual({ root: "maxAgentSteps", next: 40 });
  });

  it("un chemin pointé ne change que la feuille et garde le reste de l'objet", () => {
    const voice = { sttProvider: "openai", sttModel: "whisper-1", autoSpeak: false, ttsVoice: "", ttsRate: 1 };
    expect(planSetting("voice.sttProvider", "groq", voice)).toEqual({ root: "voice", next: { ...voice, sttProvider: "groq" } });
    expect(() => planSetting("voice.inconnu", "x", voice)).toThrow(/n'a pas de/);
    expect(() => planSetting("voice.autoSpeak", "oui", voice)).toThrow(/boolean/);
    expect(() => planSetting("voice.a.b", "x", voice)).toThrow(/seul/);
  });

  it("un dictionnaire (objet par défaut vide) accepte toute clé", () => {
    expect(planSetting("capabilityRouting.vision", { provider: "x" }, {}).next).toEqual({ vision: { provider: "x" } });
  });
});

describe("outils settings_read et settings_write", () => {
  it("settings_read liste les réglages ouverts et les NOMS des clés API, sans valeur", async () => {
    const { store } = fake({ voice: { sttProvider: "groq", sttModel: "whisper-large-v3-turbo", autoSpeak: false, ttsVoice: "", ttsRate: 1 } });
    const [read] = settingsTools(store);
    expect(read!.dangerous).toBe(false);
    const out = await read!.run({}, ctx);
    expect(out).toContain('"sttProvider":"groq"');
    expect(out).toContain("GROQ_API_KEY, ELEVENLABS_API_KEY");
    expect(out).not.toContain("autoApproveTools =");
  });

  it("settings_read d'une clé réservée n'en dit pas la valeur ; d'une feuille la donne", async () => {
    const { store } = fake({ voice: { sttProvider: "groq", sttModel: "m", autoSpeak: false, ttsVoice: "", ttsRate: 1 } });
    const [read] = settingsTools(store);
    expect(await read!.run({ key: "shellGuard" }, ctx)).toMatch(/réservé/);
    expect(await read!.run({ key: "voice.sttProvider" }, ctx)).toBe('voice.sttProvider = "groq"');
  });

  it("settings_write : accord demandé, ancienne et nouvelle valeur dans la demande, écriture de la racine complète", async () => {
    const { store, sets } = fake();
    const [, write] = settingsTools(store);
    expect(write!.dangerous).toBe(true);
    expect(await write!.precheck!({ key: "voice.sttProvider", value: "groq" }, ctx)).toBe('Régler voice.sttProvider : "openai" → "groq"');
    const out = await write!.run({ key: "voice.sttProvider", value: "groq" }, ctx);
    expect(out).toContain('"openai" → "groq"');
    expect(sets).toEqual([["voice", { sttProvider: "groq", sttModel: "whisper-1", autoSpeak: false, ttsVoice: "", ttsRate: 1 }]]);
  });

  it("settings_write refuse une clé réservée dès la garde, avant toute demande d'accord, et n'écrit rien", () => {
    const { store, sets } = fake();
    const [, write] = settingsTools(store);
    expect(() => write!.precheck!({ key: "autoApproveTools", value: true }, ctx)).toThrow(/réservé/);
    expect(sets).toEqual([]);
  });
});
