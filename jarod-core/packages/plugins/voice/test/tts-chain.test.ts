// Synthèse vocale : ElevenLabs → Gemini TTS → voix locale ; mode 100 % local ; compteur de quota ; jamais de silence ; aucune clé dans les journaux. Aucun réseau réel.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pcmToWav } from "../src/cloud.js";
import { synthesizeChain } from "../src/tts-chain.js";
import { elevenFailure, elevenQuota, synthesizeWithElevenLabs } from "../src/tts-elevenlabs.js";
import { synthesizeWithGemini } from "../src/tts-gemini.js";
import { readLocalOnly, scrubSecrets, writeLocalOnly } from "../src/voice-mode.js";

const env = { ELEVENLABS_API_KEY: "xi-clé-eleven-0000", GEMINI_API_KEY: "clé-gemini-0000" };
const wav = (tag: string) => Buffer.from(tag);
const local = () => vi.fn().mockResolvedValue({ wav: wav("local"), chars: 5, truncated: false, voice: "" });
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const off = () => false;
const noQuota = vi.fn().mockResolvedValue(null);
const text = "Bonjour, ceci est un essai de la voix française.";

describe("chaîne de synthèse", () => {
  it("ElevenLabs d'abord ; ni Gemini ni la voix locale ne sont appelés ; le compteur restant est journalisé", async () => {
    const lines: string[] = [];
    const el = vi.fn().mockResolvedValue(wav("eleven"));
    const gm = vi.fn();
    const lo = local();
    const quota = vi.fn().mockResolvedValueOnce({ used: 100, limit: 10_000, remaining: 9_900 }).mockResolvedValueOnce({ used: 148, limit: 10_000, remaining: 9_852 });
    const r = await synthesizeChain(text, {}, { local: lo, env, log: (l) => lines.push(l), localOnly: off, elevenlabs: el, gemini: gm, quota });
    expect(r.provider).toBe("elevenlabs");
    expect(r.wav.toString()).toBe("eleven");
    expect(gm).not.toHaveBeenCalled();
    expect(lo).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/fournisseur=elevenlabs/);
    expect(lines.join("\n")).toMatch(/9852 caractères restants sur 10000/);
  });

  it("alerte quand moins de 10 % du quota reste", async () => {
    const lines: string[] = [];
    const quota = vi.fn().mockResolvedValueOnce({ used: 8000, limit: 10_000, remaining: 2000 }).mockResolvedValueOnce({ used: 9500, limit: 10_000, remaining: 500 });
    await synthesizeChain(text, {}, { local: local(), env, log: (l) => lines.push(l), localOnly: off, elevenlabs: vi.fn().mockResolvedValue(wav("e")), quota });
    expect(lines.join("\n")).toMatch(/QUOTA PRESQUE ÉPUISÉ/);
  });

  it("quota ElevenLabs atteint (429) : Gemini TTS prend le relais", async () => {
    const lines: string[] = [];
    const el = vi.fn().mockRejectedValue(new Error(elevenFailure(429, '{"detail":{"status":"quota_exceeded","message":"no credits"}}')));
    const gm = vi.fn().mockResolvedValue(wav("gemini"));
    const r = await synthesizeChain(text, {}, { local: local(), env, log: (l) => lines.push(l), localOnly: off, elevenlabs: el, gemini: gm, quota: noQuota });
    expect(r.provider).toBe("gemini");
    expect(lines.join("\n")).toMatch(/ElevenLabs indisponible \(quota ElevenLabs atteint.*repli sur Gemini TTS/);
    expect(lines.join("\n")).toMatch(/fournisseur=gemini/);
  });

  it("quota connu insuffisant : ElevenLabs n'est même pas appelé", async () => {
    const el = vi.fn();
    const gm = vi.fn().mockResolvedValue(wav("gemini"));
    const quota = vi.fn().mockResolvedValue({ used: 9990, limit: 10_000, remaining: 10 });
    const r = await synthesizeChain(text, {}, { local: local(), env, log: () => undefined, localOnly: off, elevenlabs: el, gemini: gm, quota });
    expect(el).not.toHaveBeenCalled();
    expect(r.provider).toBe("gemini");
  });

  it("Gemini coupé aussi : la voix locale parle (jamais de silence)", async () => {
    const lines: string[] = [];
    const lo = local();
    const r = await synthesizeChain(text, { voice: "Hortense" }, {
      local: lo, env, log: (l) => lines.push(l), localOnly: off, quota: noQuota,
      elevenlabs: vi.fn().mockRejectedValue(new Error("pas de réseau vers ElevenLabs")),
      gemini: vi.fn().mockRejectedValue(new Error("quota Gemini dépassé (HTTP 429)")),
    });
    expect(r.provider).toBe("local");
    expect(r.wav.toString()).toBe("local");
    expect(lo).toHaveBeenCalledWith(text, { voice: "Hortense" });
    expect(lines.join("\n")).toMatch(/Gemini TTS indisponible.*repli sur la voix locale/);
  });

  it("tout échoue, voix locale comprise : l'erreur donne les trois causes", async () => {
    await expect(
      synthesizeChain(text, {}, {
        local: vi.fn().mockRejectedValue(new Error("SPEECH_NO_ENGINE")), env, log: () => undefined, localOnly: off, quota: noQuota,
        elevenlabs: vi.fn().mockRejectedValue(new Error("A")), gemini: vi.fn().mockRejectedValue(new Error("B")),
      }),
    ).rejects.toThrow(/ElevenLabs : A.*Gemini TTS : B.*voix locale : SPEECH_NO_ENGINE/s);
  });

  it("mode 100 % local : voix locale seule, aucun appel cloud, aucun appel réseau", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const el = vi.fn();
    const gm = vi.fn();
    const q = vi.fn();
    const lines: string[] = [];
    const r = await synthesizeChain(text, {}, { local: local(), env, log: (l) => lines.push(l), localOnly: () => true, elevenlabs: el, gemini: gm, quota: q });
    expect(r.provider).toBe("local");
    expect(el).not.toHaveBeenCalled();
    expect(gm).not.toHaveBeenCalled();
    expect(q).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/mode 100 % local actif/);
    f.mockRestore();
  });

  it("texte tronqué à la limite de lecture et signalé", async () => {
    const r = await synthesizeChain("mot ".repeat(1000), {}, { local: local(), env, log: () => undefined, localOnly: off, elevenlabs: vi.fn().mockResolvedValue(wav("e")), quota: noQuota });
    expect(r.truncated).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(1500);
  });

  it("aucune clé dans le journal, même si une erreur la contient", async () => {
    const lines: string[] = [];
    await synthesizeChain(text, {}, {
      local: local(), env, log: (l) => lines.push(l), localOnly: off, quota: noQuota,
      elevenlabs: vi.fn().mockRejectedValue(new Error("refusé : xi-clé-eleven-0000")),
      gemini: vi.fn().mockRejectedValue(new Error("refusé : clé-gemini-0000")),
    });
    const all = lines.join("\n");
    expect(all).not.toContain("xi-clé-eleven-0000");
    expect(all).not.toContain("clé-gemini-0000");
    expect(all).toContain("«ELEVENLABS_API_KEY»");
  });
});

describe("ElevenLabs", () => {
  it("demande du PCM 24 kHz, clé en en-tête xi-api-key (pas dans l'adresse), rend un WAV valide", async () => {
    const pcm = Buffer.alloc(4800, 1);
    const m = vi.fn().mockResolvedValue(new Response(pcm, { status: 200 }));
    const out = await synthesizeWithElevenLabs("Bonjour", 1, env, { fetch: m });
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain("output_format=pcm_24000");
    expect(String(url)).not.toContain("xi-clé");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-clé-eleven-0000");
    expect(JSON.parse(init.body).model_id).toBe("eleven_multilingual_v2");
    expect(out.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.readUInt32LE(24)).toBe(24_000);
    expect(out.length).toBe(44 + 4800);
  });
  it("vitesse bornée à 0,7–1,2", async () => {
    const m = vi.fn().mockResolvedValue(new Response(Buffer.alloc(1000), { status: 200 }));
    await synthesizeWithElevenLabs("x", 3, env, { fetch: m });
    expect(JSON.parse(m.mock.calls[0]![1].body).voice_settings.speed).toBe(1.2);
  });
  it("sans clé : message clair, aucun appel", async () => {
    const m = vi.fn();
    await expect(synthesizeWithElevenLabs("x", 1, {}, { fetch: m })).rejects.toThrow(/ELEVENLABS_API_KEY absente.*setx/);
    expect(m).not.toHaveBeenCalled();
  });
  it("messages d'échec : quota, clé invalide, forfait payant", () => {
    expect(elevenFailure(401, '{"detail":{"status":"quota_exceeded","message":"x"}}')).toMatch(/quota ElevenLabs atteint/);
    expect(elevenFailure(401, '{"detail":{"status":"invalid_api_key","message":"x"}}')).toMatch(/clé ElevenLabs invalide/);
    expect(elevenFailure(402, '{"detail":{"status":"paid_plan_required","message":"x"}}')).toMatch(/forfaits payants/);
  });
  it("le compteur lit character_count / character_limit ; indisponible = null, jamais une erreur", async () => {
    const ok = vi.fn().mockResolvedValue(reply(200, { character_count: 1200, character_limit: 10_000 }));
    expect(await elevenQuota(env, { fetch: ok })).toEqual({ used: 1200, limit: 10_000, remaining: 8_800 });
    expect(await elevenQuota(env, { fetch: vi.fn().mockResolvedValue(reply(401, {})) })).toBeNull();
    expect(await elevenQuota(env, { fetch: vi.fn().mockRejectedValue(new Error("x")) })).toBeNull();
    expect(await elevenQuota({}, { fetch: ok })).toBeNull();
  });
});

describe("Gemini TTS", () => {
  const body = (rate: string) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: Buffer.alloc(2400, 2).toString("base64") } }] } }] });
  it("demande de l'audio, clé en en-tête, rend un WAV à la cadence annoncée", async () => {
    const m = vi.fn().mockResolvedValue(reply(200, body("24000")));
    const out = await synthesizeWithGemini("Bonjour", env, { fetch: m });
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toContain("gemini-2.5-flash-preview-tts:generateContent");
    expect(String(url)).not.toContain("clé-gemini");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("clé-gemini-0000");
    const sent = JSON.parse(init.body);
    expect(sent.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(out.subarray(0, 4).toString()).toBe("RIFF");
    expect(out.readUInt32LE(24)).toBe(24_000);
  });
  it("sans clé, quota 429, aucun son", async () => {
    await expect(synthesizeWithGemini("x", {}, { fetch: vi.fn() })).rejects.toThrow(/GEMINI_API_KEY absente/);
    await expect(synthesizeWithGemini("x", env, { fetch: vi.fn().mockResolvedValue(reply(429, { error: { message: "exhausted" } })) })).rejects.toThrow(/quota Gemini dépassé/);
    await expect(synthesizeWithGemini("x", env, { fetch: vi.fn().mockResolvedValue(reply(200, { candidates: [] })) })).rejects.toThrow(/aucun son/);
  });
});

describe("mode 100 % local (qwen-flash.json)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "voix-mode-"));
  it("absent ou illisible = mode normal ; s'écrit en gardant les autres champs ; se relit à chaque appel", () => {
    const d = dir();
    const e = { JAROD_OS_CONFIG_DIR: d };
    try {
      expect(readLocalOnly(e)).toBe(false);
      writeFileSync(join(d, "qwen-flash.json"), JSON.stringify({ autoStart: true, whisper: { port: 8090 } }));
      expect(readLocalOnly(e)).toBe(false);
      writeLocalOnly(true, e);
      expect(readLocalOnly(e)).toBe(true);
      expect(JSON.parse(readFileSync(join(d, "qwen-flash.json"), "utf8"))).toEqual({ autoStart: true, whisper: { port: 8090 }, localOnly: true });
      writeLocalOnly(false, e);
      expect(readLocalOnly(e)).toBe(false);
      writeFileSync(join(d, "qwen-flash.json"), "{pas du json");
      expect(readLocalOnly(e)).toBe(false);
      expect(() => writeLocalOnly(true, e)).toThrow(/illisible/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("scrubSecrets masque les trois clés mais pas les valeurs courtes", () => {
    const e = { GEMINI_API_KEY: "AIzaSyABCDEFGH", GROQ_API_KEY: "gsk_12345678", ELEVENLABS_API_KEY: "sk_abcdefgh", X: "ab" };
    expect(scrubSecrets("a AIzaSyABCDEFGH b gsk_12345678 c sk_abcdefgh", e)).toBe("a «GEMINI_API_KEY» b «GROQ_API_KEY» c «ELEVENLABS_API_KEY»");
  });
  it("pcmToWav : en-tête RIFF de 44 octets cohérent", () => {
    const w = pcmToWav(Buffer.alloc(100), 16_000);
    expect(w.readUInt32LE(4)).toBe(136);
    expect(w.readUInt32LE(24)).toBe(16_000);
    expect(w.readUInt32LE(40)).toBe(100);
  });
});
