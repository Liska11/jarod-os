// Dictée « local-whisper-cpu » : whisper local d'abord (5 s max) → Groq → Gemini ; mode 100 % local = whisper seul ; causes d'échec dites clairement. Aucun réseau réel.
import { describe, expect, it, vi } from "vitest";
import { geminiFailure, transcribeWithGemini } from "../src/stt-gemini.js";
import { groqFailure, transcribeWithGroq } from "../src/stt-groq.js";
import { LOCAL_STT_TIMEOUT_MS, STT_DEFAULTS, transcribe } from "../src/voice.js";

const audio = Buffer.from("RIFFxxxxWAVE");
const settings = (provider = "local-whisper-cpu") =>
  ({ get: (k: string) => (k === "voice" ? { sttProvider: provider, sttModel: "" } : "fr"), getSecret: () => undefined }) as never;
const localDef = { id: "local-whisper-cpu", name: "Whisper CPU", protocol: "openai", baseUrl: "http://127.0.0.1:8090/v1", local: true, models: [] };
const router = { def: () => localDef } as never;
const cloudRouter = { def: () => ({ ...localDef, id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", local: false }) } as never;
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const env = { GEMINI_API_KEY: "clé-gemini-0000", GROQ_API_KEY: "gsk_clé-groq-0000" };
const off = () => false;

describe("fournisseur local-whisper-cpu", () => {
  it("est un fournisseur de transcription choisissable", () => expect(STT_DEFAULTS["local-whisper-cpu"]).toBe("large-v3-turbo-q5_0"));

  it("transcrit par le whisper local sans toucher au cloud, et journalise le fournisseur", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { text: " Bonjour Jarod. " }));
    const g = vi.fn();
    const q = vi.fn();
    const lines: string[] = [];
    expect(await transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: (l) => lines.push(l), env, localOnly: off })).toBe("Bonjour Jarod.");
    expect(g).not.toHaveBeenCalled();
    expect(q).not.toHaveBeenCalled();
    expect(String(f.mock.calls[0]![0])).toBe("http://127.0.0.1:8090/v1/audio/transcriptions");
    expect(lines.join("\n")).toMatch(/mode normal.*\n.*fournisseur=whisper-local/);
    f.mockRestore();
  });

  it("whisper local en panne : Groq répond, Gemini n'est pas touché, le journal dit lequel", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const lines: string[] = [];
    const q = vi.fn().mockResolvedValue("Bonjour par Groq");
    const g = vi.fn();
    expect(await transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: (l) => lines.push(l), env, localOnly: off })).toBe("Bonjour par Groq");
    expect(q).toHaveBeenCalledOnce();
    expect(g).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/whisper local indisponible.*repli sur Groq/);
    expect(lines.join("\n")).toMatch(/fournisseur=groq/);
    f.mockRestore();
  });

  it("Groq échoue aussi (clé invalide) : Gemini répond en n°3", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const lines: string[] = [];
    const q = vi.fn().mockRejectedValue(new Error("clé Groq invalide ou refusée (HTTP 401)"));
    const g = vi.fn().mockResolvedValue("Bonjour par Gemini");
    expect(await transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: (l) => lines.push(l), env, localOnly: off })).toBe("Bonjour par Gemini");
    expect(lines.join("\n")).toMatch(/Groq indisponible \(clé Groq invalide.*repli sur Gemini/);
    expect(lines.join("\n")).toMatch(/fournisseur=gemini/);
    f.mockRestore();
  });

  it("le délai local est de 5 s", () => expect(LOCAL_STT_TIMEOUT_MS).toBe(5000));

  it("les trois échouent : l'erreur nomme les trois causes", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const q = vi.fn().mockRejectedValue(new Error("GROQ_API_KEY absente"));
    const g = vi.fn().mockRejectedValue(new Error("quota Gemini dépassé (HTTP 429)"));
    await expect(transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: () => undefined, env, localOnly: off })).rejects.toThrow(/whisper local.*Groq \(GROQ_API_KEY absente\).*Gemini \(quota Gemini dépassé/s);
    f.mockRestore();
  });

  it("mode 100 % local : whisper seul, ni Groq ni Gemini, même si le local est en panne", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const q = vi.fn();
    const g = vi.fn();
    const lines: string[] = [];
    await expect(transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: (l) => lines.push(l), env, localOnly: () => true })).rejects.toThrow(/ne répond pas/);
    expect(q).not.toHaveBeenCalled();
    expect(g).not.toHaveBeenCalled();
    // Le seul appel réseau est le whisper local (127.0.0.1).
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual(["http://127.0.0.1:8090/v1/audio/transcriptions"]);
    expect(lines.join("\n")).toMatch(/mode 100 % local actif/);
    f.mockRestore();
  });

  it("mode 100 % local : le whisper local répond, journal « fournisseur=whisper-local »", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply(200, { text: "ok" }));
    const lines: string[] = [];
    expect(await transcribe(router, settings(), audio, "audio/wav", { log: (l) => lines.push(l), env, localOnly: () => true })).toBe("ok");
    expect(lines.join("\n")).toMatch(/100 % local.*\n.*fournisseur=whisper-local/);
    f.mockRestore();
  });

  it("le mode est relu à chaque requête (bascule sans redémarrage)", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    let local = false;
    const q = vi.fn().mockResolvedValue("par Groq");
    const deps = { groq: q, log: () => undefined, env, localOnly: () => local };
    expect(await transcribe(router, settings(), audio, "audio/wav", deps)).toBe("par Groq");
    local = true;
    await expect(transcribe(router, settings(), audio, "audio/wav", deps)).rejects.toThrow();
    expect(q).toHaveBeenCalledOnce();
    f.mockRestore();
  });

  it("mode 100 % local : un fournisseur qui sort de la machine est refusé avant tout envoi", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await expect(transcribe(cloudRouter, settings("openai"), audio, "audio/wav", { log: () => undefined, env, localOnly: () => true })).rejects.toThrow(/Mode 100 % local actif.*hors de ce PC/);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it("un autre fournisseur ne passe jamais par le cloud de repli", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const g = vi.fn();
    const q = vi.fn();
    await expect(transcribe({ def: () => ({ ...localDef, id: "x", name: "X" }) } as never, settings("custom"), audio, "audio/wav", { groq: q, gemini: g, log: () => undefined, env, localOnly: off })).rejects.toThrow(/ne répond pas/);
    expect(g).not.toHaveBeenCalled();
    expect(q).not.toHaveBeenCalled();
    f.mockRestore();
  });

  it("aucune clé n'apparaît dans le journal, même si un message d'erreur la contient", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const lines: string[] = [];
    const q = vi.fn().mockRejectedValue(new Error(`rejeté pour gsk_clé-groq-0000`));
    const g = vi.fn().mockResolvedValue("ok");
    await transcribe(router, settings(), audio, "audio/wav", { groq: q, gemini: g, log: (l) => lines.push(l), env, localOnly: off });
    expect(lines.join("\n")).not.toContain("gsk_clé-groq-0000");
    expect(lines.join("\n")).toContain("«GROQ_API_KEY»");
    f.mockRestore();
  });
});

describe("transcribeWithGroq", () => {
  it("envoie l'audio en multipart avec la clé en en-tête Authorization (jamais dans l'adresse) et rend le texte", async () => {
    const m = vi.fn().mockResolvedValue(reply(200, { text: " Bonjour " }));
    expect(await transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: m })).toBe("Bonjour");
    const [url, init] = m.mock.calls[0]!;
    expect(String(url)).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer gsk_clé-groq-0000");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("fr");
  });
  it("sans clé : message clair, aucun appel réseau", async () => {
    const m = vi.fn();
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", {}, { fetch: m })).rejects.toThrow(/GROQ_API_KEY absente.*setx/);
    expect(m).not.toHaveBeenCalled();
  });
  it("clé invalide (401), quota (429), pas de réseau, politique réseau", async () => {
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockResolvedValue(reply(401, { error: { message: "Invalid API Key" } })) })).rejects.toThrow(/clé Groq invalide/);
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockResolvedValue(reply(429, { error: { message: "rate limit" } })) })).rejects.toThrow(/quota Groq dépassé/);
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) })).rejects.toThrow(/pas de réseau vers Groq/);
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockRejectedValue(new Error("refusé par la politique réseau")) })).rejects.toThrow(/politique réseau de Jarod/);
  });
  it("transcription vide ou illisible", async () => {
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockResolvedValue(reply(200, { text: "" })) })).rejects.toThrow(/aucune transcription/);
    await expect(transcribeWithGroq(audio, "audio/wav", "fr", env, { fetch: vi.fn().mockResolvedValue(reply(200, "pas du json")) })).rejects.toThrow(/illisible/);
  });
  it("le message d'échec ne contient jamais la clé", () => expect(groqFailure(401, '{"error":{"message":"x"}}')).not.toContain("gsk_"));
});

describe("transcribeWithGemini", () => {
  it("envoie l'audio avec la clé en en-tête (jamais dans l'adresse) et rend le texte", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, gemini("  Bonjour  ")));
    expect(await transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: fetchMock })).toBe("Bonjour");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(String(url)).not.toContain("clé-gemini");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("clé-gemini-0000");
    expect(JSON.parse(init.body).contents[0].parts[1].inline_data.mime_type).toBe("audio/wav");
  });
  it("sans clé : message clair, aucun appel réseau", async () => {
    const fetchMock = vi.fn();
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", {}, { fetch: fetchMock })).rejects.toThrow(/GEMINI_API_KEY absente.*setx/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("quota dépassé (429)", async () => {
    const m = vi.fn().mockResolvedValue(reply(429, { error: { message: "Resource has been exhausted" } }));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/quota Gemini dépassé \(HTTP 429\)/);
  });
  it("clé invalide (400 « API key not valid »)", async () => {
    const m = vi.fn().mockResolvedValue(reply(400, { error: { message: "API key not valid. Please pass a valid API key." } }));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/clé Gemini invalide/);
  });
  it("clé refusée (403)", async () => {
    const m = vi.fn().mockResolvedValue(reply(403, { error: { message: "denied" } }));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/clé Gemini refusée/);
  });
  it("pas de réseau", async () => {
    const m = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/pas de réseau vers Gemini/);
  });
  it("refus par la politique réseau de Jarod", async () => {
    const m = vi.fn().mockRejectedValue(new Error("connexion refusée par la politique réseau (generativelanguage.googleapis.com)"));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/politique réseau de Jarod/);
  });
  it("aucune transcription renvoyée", async () => {
    const m = vi.fn().mockResolvedValue(reply(200, { candidates: [] }));
    await expect(transcribeWithGemini(audio, "audio/wav", "fr", env, { fetch: m })).rejects.toThrow(/aucune transcription/);
  });
  it("le message d'échec ne contient jamais la clé", () => expect(geminiFailure(403, '{"error":{"message":"x"}}')).not.toContain("clé-gemini"));
});
