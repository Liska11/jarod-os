// plugin-voice : preset local-whisper-cpp (G3) et superviseur whisper-server, sans matériel.
// La transcription réelle sur iGPU est vérifiée par la gate P3 (tests/gates/p3.test.ts).
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { STT_DEFAULTS } from "../src/voice.js";
import { INFERENCE_PATH, WhisperServerSupervisor } from "../src/whisper-server.js";

afterEach(cleanup);

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe("preset local-whisper-cpp", () => {
  it("transcrit sans aucune clé, via le point d'accès compatible OpenAI", async () => {
    const seen: string[] = [];
    const { server, port } = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? "aucune"}`);
        seen.push(/name="model"\r\n\r\nlarge-v3-turbo/.test(body) ? "model ok" : "model ?");
        seen.push(/name="language"\r\n\r\nfr/.test(body) ? "langue ok" : "langue ?");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: " Bonjour Jarod. " }));
      });
    });
    try {
      const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
      const s = app.storage.settings;
      s.set("voice", { ...s.get("voice"), sttProvider: "local-whisper-cpp", sttModel: "" });
      s.set("providerOverrides", { "local-whisper-cpp": { baseUrl: `http://127.0.0.1:${port}/v1` } });
      expect(STT_DEFAULTS["local-whisper-cpp"]).toBe("large-v3-turbo");
      expect(await app.voice.transcribe(Buffer.from("RIFF"), "audio/wav")).toBe("Bonjour Jarod.");
      expect(seen).toEqual([`POST ${INFERENCE_PATH} auth=aucune`, "model ok", "langue ok"]);
    } finally {
      server.close();
    }
  });

  it("sans whisper configuré : le démarrage le dit", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, llm: {}, voice: {} });
    await expect(app.voice.startWhisper()).rejects.toThrow(/WHISPER_NOT_CONFIGURED/);
  });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "");
    return true;
  }
}

describe("WhisperServerSupervisor", () => {
  const files = () => {
    const dir = tempDir();
    const bin = join(dir, "whisper-server.exe");
    const model = join(dir, "m.bin");
    writeFileSync(bin, "");
    writeFileSync(model, "");
    return { bin, model };
  };

  it("arguments : 127.0.0.1, chemin OpenAI, langue, périphérique Vulkan, conversion", () => {
    expect(
      WhisperServerSupervisor.args({ bin: "w", model: "m.bin", port: 8910, language: "fr", device: 1, convert: true }),
    ).toEqual(["-m", "m.bin", "--host", "127.0.0.1", "--port", "8910", "-l", "fr", "--inference-path", INFERENCE_PATH, "-dev", "1", "--convert"]);
  });

  it("refuse un binaire ou un modèle absent, et un port déjà servi par un autre", async () => {
    const sup = new WhisperServerSupervisor({ spawn: () => new FakeChild(), probe: async () => true });
    await expect(sup.start({ bin: "absent.exe", model: "m", port: 1, language: "fr" })).rejects.toThrow(/BINARY_MISSING/);
    const f = files();
    await expect(sup.start({ ...f, port: 1, language: "fr" })).rejects.toThrow(/PORT_BUSY/);
  });

  it("prêt quand /health répond, redémarre après une sortie, s'arrête proprement", async () => {
    const children: FakeChild[] = [];
    let healthy = false;
    const sup = new WhisperServerSupervisor({
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        setTimeout(() => {
          healthy = true;
        }, 50);
        return c;
      },
      probe: async (url) => url.endsWith("/health") && healthy,
      backoffMs: 10,
    });
    const f = files();
    const st = await sup.start({ ...f, port: 8910, language: "fr" });
    expect(st).toMatchObject({ running: true, ready: true, port: 8910, pid: 4242 });
    expect(sup.baseUrl()).toBe("http://127.0.0.1:8910/v1");
    children[0]!.emit("exit", 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(children).toHaveLength(2);
    expect(await sup.stop()).toBe(true);
    expect(children[1]!.killed).toEqual(["SIGTERM"]);
    expect(sup.status()).toMatchObject({ running: false, ready: false });
  });
});
