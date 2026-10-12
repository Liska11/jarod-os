// Passerelle compatible Hermes : la voix du shell (`/api/audio/transcribe`, `/api/audio/speak`, `/api/audio/speak-stream`). Le vrai noyau et la vraie passerelle ; la voix est factice
// (le vrai moteur vocal et le vrai fournisseur de transcription sont vérifiés à part).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { AudioError, MAX_AUDIO_BYTES, MAX_SPEAK_CHARS, parseDataUrl, speakText, wavDataUrl } from "../src/gateway/audio.js";
import { openCore } from "../src/context.js";
import { createGateway } from "../src/gateway/server.js";

const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WAVEfmt "), Buffer.alloc(24)]);
const KEY = ["sk", "CANARI-AUDIO-0123456789abcdef0123"].join("-");
const b64 = (b: Buffer) => b.toString("base64");

describe("parseDataUrl", () => {
  it("lit un énoncé WAV en base64 ; le type vient de l'URL, sinon de la demande ; les paramètres (codecs) sont ignorés", () => {
    expect(parseDataUrl(`data:audio/wav;base64,${b64(WAV)}`)).toEqual({ mime: "audio/wav", bytes: WAV });
    expect(parseDataUrl(`data:audio/webm;codecs=opus;base64,${b64(WAV)}`).mime).toBe("audio/webm");
    expect(parseDataUrl(`data:;base64,${b64(WAV)}`, "audio/ogg; codecs=opus").mime).toBe("audio/ogg");
  });

  it("refuse ce qui n'est pas une data URL base64, un type qui n'est pas de l'audio, le vide et l'énorme", () => {
    const fails = (value: unknown, status: number, mime?: unknown) => {
      try {
        parseDataUrl(value, mime);
        throw new Error("aurait dû refuser");
      } catch (e) {
        expect(e).toBeInstanceOf(AudioError);
        expect((e as AudioError).status).toBe(status);
      }
    };
    fails(42, 400);
    fails("https://example.org/a.wav", 400);
    fails("data:audio/wav,AAAA", 400);
    fails("data:audio/wav;base64,@@@@", 400);
    fails(`data:text/html;base64,${b64(WAV)}`, 415);
    fails(`data:;base64,${b64(WAV)}`, 415);
    fails("data:audio/wav;base64,", 400);
    expect(() => parseDataUrl(`data:audio/wav;base64,${b64(Buffer.alloc(MAX_AUDIO_BYTES + 1))}`)).toThrow(/trop long/);
  });
});

describe("speakText / wavDataUrl", () => {
  it("un texte non vide et borné ; le WAV revient en data URL", () => {
    expect(speakText("Bonjour")).toBe("Bonjour");
    expect(() => speakText("   ")).toThrow(AudioError);
    expect(() => speakText(7)).toThrow(AudioError);
    expect(() => speakText("x".repeat(MAX_SPEAK_CHARS + 1))).toThrow(/trop long/);
    expect(wavDataUrl(WAV)).toBe(`data:audio/wav;base64,${b64(WAV)}`);
  });
});

const dirs: string[] = [];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(voice?: { transcribe(a: Buffer, m: string): Promise<string>; synthesize(t: string): Promise<Buffer> }) {
  const root = mkdtempSync(join(tmpdir(), "jarod-gw-audio-"));
  dirs.push(root);
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  const gw = createGateway({ core, version: "t", ...(voice ? { voice } : {}) });
  const port = await gw.listen(0);
  closers.push(async () => {
    await gw.close();
    await core.dispose();
  });
  const post = async (path: string, body: unknown, token: string | null = gw.token) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-hermes-session-token": token } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  return { gw, port, post };
}

describe("POST /api/audio/transcribe", () => {
  it("passe les octets et le type au fournisseur et rend le texte", async () => {
    const seen: { bytes: Buffer; mime: string }[] = [];
    const { post } = await rig({ transcribe: async (bytes, mime) => (seen.push({ bytes, mime }), "bonjour le monde"), synthesize: async () => WAV });
    const r = await post("/api/audio/transcribe", { data_url: `data:audio/wav;base64,${b64(WAV)}`, mime_type: "audio/wav" });
    expect(r).toMatchObject({ status: 200, json: { ok: true, transcript: "bonjour le monde" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bytes.equals(WAV)).toBe(true);
    expect(seen[0]!.mime).toBe("audio/wav");
  });

  it("une donnée invalide : 400/415 sans appeler le fournisseur ; sans jeton : 401 ; sans voix branchée : 404", async () => {
    let called = 0;
    const { post } = await rig({ transcribe: async () => (called++, "x"), synthesize: async () => WAV });
    expect((await post("/api/audio/transcribe", { data_url: "nope" })).status).toBe(400);
    expect((await post("/api/audio/transcribe", { data_url: `data:video/mp4;base64,${b64(WAV)}` })).status).toBe(415);
    expect((await post("/api/audio/transcribe", { data_url: `data:audio/wav;base64,${b64(WAV)}` }, null)).status).toBe(401);
    expect(called).toBe(0);
    const none = await rig();
    expect((await none.post("/api/audio/transcribe", { data_url: `data:audio/wav;base64,${b64(WAV)}` })).status).toBe(404);
  });

  it("une faute du fournisseur (pas de clé…) arrive en 502 avec ses mots, sans clé", async () => {
    const { post } = await rig({ transcribe: async () => { throw new Error(`Aucune clé API pour OpenAI (nécessaire pour la dictée). Authorization: Bearer ${KEY}`); }, synthesize: async () => WAV });
    const r = await post("/api/audio/transcribe", { data_url: `data:audio/wav;base64,${b64(WAV)}` });
    expect(r.status).toBe(502);
    expect(r.json.detail).toMatch(/Aucune clé API pour OpenAI/);
    expect(r.text).not.toContain("CANARI");
  });
});

describe("POST /api/audio/speak", () => {
  it("rend le WAV de la voix en data URL", async () => {
    const said: string[] = [];
    const { post } = await rig({ transcribe: async () => "", synthesize: async (t) => (said.push(t), WAV) });
    const r = await post("/api/audio/speak", { text: "Bonjour !" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, data_url: wavDataUrl(WAV) });
    expect(said).toEqual(["Bonjour !"]);
  });

  it("texte vide ou trop long : 400/413 ; moteur vocal absent : 502 avec le mot du moteur", async () => {
    const { post } = await rig({ transcribe: async () => "", synthesize: async () => { throw new Error("SPEECH_NO_ENGINE: aucun moteur vocal sur cette machine."); } });
    expect((await post("/api/audio/speak", { text: " " })).status).toBe(400);
    expect((await post("/api/audio/speak", { text: "x".repeat(MAX_SPEAK_CHARS + 1) })).status).toBe(413);
    const r = await post("/api/audio/speak", { text: "a" });
    expect(r.status).toBe(502);
    expect(r.json.detail).toMatch(/SPEECH_NO_ENGINE/);
  });
});

describe("/api/audio/speak-stream", () => {
  const open = (port: number, token: string) =>
    new Promise<{ frames: string[]; closed: Promise<void> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/audio/speak-stream?token=${token}`);
      const frames: string[] = [];
      const closed = new Promise<void>((done) => ws.addEventListener("close", () => done()));
      ws.addEventListener("message", (m) => frames.push(String(m.data)));
      ws.addEventListener("open", () => resolve({ frames, closed }));
      ws.addEventListener("error", () => reject(new Error("refusé")));
    });

  it("répond « repli » puis se ferme : la fenêtre dit alors la réponse entière", async () => {
    const { gw, port } = await rig({ transcribe: async () => "", synthesize: async () => WAV });
    const s = await open(port, gw.token);
    await s.closed;
    expect(s.frames.map((f) => JSON.parse(f).type)).toEqual(["fallback"]);
  });

  it("sans le bon jeton, la connexion est refusée", async () => {
    const { port } = await rig({ transcribe: async () => "", synthesize: async () => WAV });
    await expect(open(port, "mauvais")).rejects.toThrow("refusé");
  });
});
