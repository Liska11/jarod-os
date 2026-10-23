// G5 contre yt-dlp réel (engines/yt-dlp/yt-dlp.exe, 2026.08.19, sha256 = SHA2-256SUMS de la release) sur un serveur LOCAL fabriqué :
// page HTML5 avec une piste de sous-titres, fichier audio. Aucun site réel, aucun cookie. Le bouclage n'est permis que par l'option de test.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterRefused } from "../../src/impl/common.js";
import { fetchMediaText, mediaTool } from "../../src/impl/media.js";
import { ROOT } from "./helpers.js";

const BIN = process.env.JAROD_YTDLP ?? join(ROOT, "engines", "yt-dlp", "yt-dlp.exe");
const has = existsSync(BIN);
if (!has) console.warn(`[moteurs] ${BIN} absent : les tests yt-dlp réels sont ignorés (voir engines.lock/README.md)`);

const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<c>Bonjour</c>, ceci est un sous-titre fabriqué.\n\n00:00:02.000 --> 00:00:04.000\nDeuxième ligne.\n";
const AUDIO = Buffer.alloc(64 * 1024, 7);
const seen: { url: string; cookie: boolean }[] = [];
let srv: Server;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "jarod-ytdlp-"));

beforeAll(async () => {
  srv = createServer((req, res) => {
    seen.push({ url: req.url ?? "", cookie: Boolean(req.headers.cookie) });
    if (req.url?.startsWith("/page.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end('<html><head><title>Vidéo de test</title></head><body><video controls><source src="/media.mp4" type="video/mp4"><track kind="subtitles" src="/fr.vtt" srclang="fr"></video></body></html>');
    }
    if (req.url === "/fr.vtt") {
      res.writeHead(200, { "content-type": "text/vtt" });
      return res.end(VTT);
    }
    if (req.url?.startsWith("/media")) {
      res.writeHead(200, { "content-type": req.url.endsWith(".m4a") ? "audio/mp4" : "video/mp4", "content-length": AUDIO.length });
      return res.end(req.method === "HEAD" ? undefined : AUDIO);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!has)("G5 contre yt-dlp réel (serveur local fabriqué)", () => {
  it("métadonnées : titre, langues des sous-titres originaux et automatiques distinguées, rien d'écrit, requête jamais reprise", async () => {
    const out = join(dir, "meta");
    const r = await fetchMediaText({ bin: BIN, url: `${base}/page.html?jeton=secret-0042`, mode: "metadata", outDir: out, allowPrivateHosts: true });
    expect(r.info.title).toMatch(/Vidéo de test/);
    expect(r.info.subtitles).toEqual(["fr"]);
    expect(r.info.automaticCaptions).toEqual([]);
    expect(r.info.page).toBe(`${base}/page.html`);
    expect(JSON.stringify(r)).not.toContain("secret-0042");
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it("sous-titres : piste ORIGINALE, texte sans horodatage ni balise", async () => {
    const r = await fetchMediaText({ bin: BIN, url: `${base}/page.html`, mode: "subtitles", outDir: join(dir, "subs"), langs: ["fr"], allowPrivateHosts: true });
    expect(r).toMatchObject({ textOrigin: "original", language: "fr" });
    expect(r.text).toBe("Bonjour, ceci est un sous-titre fabriqué.\nDeuxième ligne.");
    expect(existsSync(r.file!)).toBe(true);
  }, 120_000);

  it("langue absente : aucun texte inventé, la raison est dite", async () => {
    const r = await fetchMediaText({ bin: BIN, url: `${base}/page.html`, mode: "subtitles", outDir: join(dir, "subs-de"), langs: ["de"], allowPrivateHosts: true });
    expect(r).toMatchObject({ textOrigin: "aucun", note: expect.stringMatching(/aucun sous-titre/) });
    expect(r.text).toBeUndefined();
  }, 120_000);

  it("audio : un fichier, borné ; au-delà de la taille permise, rien n'est gardé", async () => {
    const r = await fetchMediaText({ bin: BIN, url: `${base}/media.m4a`, mode: "audio", outDir: join(dir, "audio"), allowPrivateHosts: true, limits: { minFreeBytes: 0 } });
    expect(r).toMatchObject({ mode: "audio", textOrigin: "aucun" });
    expect(existsSync(r.file!)).toBe(true);
    await expect(fetchMediaText({ bin: BIN, url: `${base}/media.m4a`, mode: "audio", outDir: join(dir, "audio-big"), allowPrivateHosts: true, limits: { maxBytes: 1024, minFreeBytes: 0 } })).rejects.toThrow();
    expect(readdirSync(join(dir, "audio-big")).filter((f) => !f.endsWith(".part"))).toEqual([]);
  }, 120_000);

  it("aucun cookie n'a jamais été envoyé au serveur", () => {
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.cookie)).toBe(false);
  });

  it("refus : hôte local sans l'option de test, identifiants dans l'URL, schéma autre que http(s) ; annulation", async () => {
    await expect(fetchMediaText({ bin: BIN, url: `${base}/page.html`, mode: "metadata", outDir: dir })).rejects.toBeInstanceOf(AdapterRefused);
    await expect(fetchMediaText({ bin: BIN, url: "https://u:p@video.example/x", mode: "metadata", outDir: dir })).rejects.toThrow(/identifiants/);
    await expect(fetchMediaText({ bin: BIN, url: "file:///C:/Windows/win.ini", mode: "metadata", outDir: dir })).rejects.toThrow(/http/);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fetchMediaText({ bin: BIN, url: `${base}/page.html`, mode: "metadata", outDir: dir, allowPrivateHosts: true, signal: ctrl.signal })).rejects.toThrow(/annulé/);
  }, 60_000);

  it("l'outil de l'agent : cible = l'hôte, bouclage refusé (l'option de test n'est pas un argument), moteur absent dit", async () => {
    const tool = mediaTool(() => BIN);
    expect(tool.dangerous).toBe(true);
    expect(tool.targetOf({ url: "https://video.example/watch?v=1" })).toBe("video.example");
    expect(await tool.run({ url: `${base}/page.html`, mode: "metadata", allowPrivateHosts: true }, { sessionId: "s", workspace: dir })).toMatch(/hôte local ou privé refusé/);
    expect(await mediaTool(() => null).run({ url: "https://x.example", mode: "metadata" }, { sessionId: "s", workspace: dir })).toMatch(/Indisponible/);
  });
});
