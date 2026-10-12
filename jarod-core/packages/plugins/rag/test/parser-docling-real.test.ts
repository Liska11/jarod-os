// Lot B ⑥ : le VRAI worker Docling (venv `tools/docling-venv`, script versionné `sidecars/docling-worker/`).
// Ignoré si le venv n'est pas installé (machine sans l'opt-in Docling). Aucun téléchargement, hors ligne.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltinParser, RagService, WorkerParser, withFallback } from "../src/index.js";

afterEach(cleanup);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const WORKER = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const HAVE = existsSync(PYTHON) && existsSync(WORKER);

const HTML = Buffer.from("<html><body><h1>Titre un</h1><p>Bonjour le monde.</p><h2>Sous-titre</h2><p>Deuxieme paragraphe.</p></body></html>");

const real = () =>
  new WorkerParser({ name: "docling", command: PYTHON, args: [WORKER], extensions: [".html", ".pdf"], allowPath: () => false, timeoutMs: 120_000, startTimeoutMs: 120_000 });

describe.skipIf(!HAVE)("worker Docling réel", () => {
  it("protocole : aucune ligne spontanée au démarrage, exactement une réponse par hello", { timeout: 120_000 }, async () => {
    const proc = spawn(PYTHON, [WORKER], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: { ...process.env, HF_HUB_OFFLINE: "1" } });
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    try {
      await new Promise((r) => setTimeout(r, 4000));
      expect(out).toBe("");
      proc.stdin.write(`${JSON.stringify({ op: "hello" })}\n`);
      await new Promise((r) => setTimeout(r, 2000));
      expect(out.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(out)).toMatchObject({ ok: true, name: "docling", protocol: 1 });
    } finally {
      proc.kill();
    }
  });

  it("lit un HTML : texte, section, manifeste accepté ; deux lectures de suite (aucune ligne d'accueil en trop)", { timeout: 300_000 }, async () => {
    const p = real();
    try {
      const a = await p.parse({ bytes: HTML, name: "a.html" });
      expect(a.manifest.parser.name).toBe("docling");
      expect(a.text).toContain("Titre un");
      expect(a.manifest.sections.map((s) => s.title)).toContain("Sous-titre");
      const b = await p.parse({ bytes: Buffer.from(HTML.toString().replace("Bonjour", "Salut")), name: "b.html" });
      expect(b.text).toContain("Salut le monde");
    } finally {
      await p.close();
    }
  });

  it("les empans du manifeste désignent de VRAIES plages du texte (sections, tableau) : l'adaptateur accepte, le titre se relit", { timeout: 300_000 }, async () => {
    const html = Buffer.from("<html><body><h1>Rapport</h1><p>Intro du rapport.</p><h2>Chiffres</h2><table><tr><th>Nom</th><th>Valeur</th></tr><tr><td>alpha</td><td>42</td></tr></table><h2>Fin</h2><p>Conclusion.</p></body></html>");
    const p = real();
    try {
      const r = await p.parse({ bytes: html, name: "r.html" });
      expect(r.manifest.sections.length).toBeGreaterThanOrEqual(2);
      for (const s of r.manifest.sections) expect(r.text.slice(s.start, s.end)).toBe(s.title);
      expect(r.manifest.tables).toHaveLength(1);
      const t = r.manifest.tables[0]!;
      expect(r.text.slice(t.start, t.end)).toContain("alpha");
      for (const s of [...r.manifest.sections, ...r.manifest.tables, ...r.manifest.images]) expect(s.end).toBeLessThanOrEqual(r.text.length);
    } finally {
      await p.close();
    }
  });

  it("un document illisible est une erreur de DOCUMENT : le worker reste utilisable", { timeout: 300_000 }, async () => {
    const p = real();
    try {
      await expect(p.parse({ bytes: Buffer.from("pas un pdf"), name: "x.pdf" })).rejects.toThrow();
      const ok = await p.parse({ bytes: HTML, name: "c.html" });
      expect(ok.text).toContain("Titre un");
    } finally {
      await p.close();
    }
  });

  it("withFallback : un .pdf illisible ne donne jamais de texte (le builtin ne décode pas les PDF)", { timeout: 300_000 }, async () => {
    const p = real();
    try {
      await expect(withFallback(p, new BuiltinParser()).parse({ bytes: Buffer.from("pas un pdf"), name: "x.pdf" })).rejects.toThrow(/PARSER_UNAVAILABLE/);
    } finally {
      await p.close();
    }
  });
});

async function service(rag: Record<string, unknown>) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, chunkSize: 200, chunkOverlap: 0, ...rag });
  settings.set("ecosystem", { ...settings.get("ecosystem"), documentParser: "docling" });
  const svc = new RagService({ db, settings, providers: { def: () => ({ local: true, baseUrl: "http://127.0.0.1:1/v1" }) as never } });
  svc.setEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0])));
  return { svc, parsers: () => db.all<{ parser: string; manifest: string }>("SELECT parser, manifest FROM rag_documents") };
}

describe("RagService et le drapeau documentParser = docling", () => {
  it.skipIf(!HAVE)("chemins explicites : le document passe par le worker Docling", { timeout: 300_000 }, async () => {
    const { svc, parsers } = await service({ doclingPython: PYTHON, doclingWorker: WORKER });
    try {
      await svc.ingest(HTML.toString(), { docId: "h", source: "h.html" });
      expect(parsers().map((r) => r.parser)).toEqual(["docling"]);
    } finally {
      await svc.close();
    }
  });

  it("chemins vides ou relatifs : aucun processus, l'indexation aboutit quand même, jamais un parseur deviné", async () => {
    for (const cfg of [{}, { doclingPython: "python.exe", doclingWorker: "docling-worker.py" }]) {
      const { svc, parsers } = await service(cfg);
      const r = await svc.ingest("# Titre\n\nUn texte assez long pour être indexé correctement.", { docId: "m", source: "m.md" });
      expect(r).toBeTruthy();
      expect(parsers().every((p) => p.parser === "builtin")).toBe(true);
      await svc.close();
    }
  });
});
