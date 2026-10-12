// Vérification de bout en bout du SÉLECTEUR DE MODÈLES de Jarod-OS, sans fenêtre : profil jetable, un faux serveur LM Studio (127.0.0.1, port libre), le VRAI noyau
// et la passerelle, puis le chemin que suit Herald : passerelle joignable → `model.options` (modèles découverts) → choix `/model fournisseur:modèle` →
// réglage du profil à jour (relu après réouverture du noyau) → `/api/config/raw` à jour et sans secret.
// À lancer par `scripts\verify-jarod-os.ps1` (ou `pnpm --filter @jarod/cli exec tsx src/gateway/verify.ts`). Code de sortie 0 seulement si tout passe.
// Ne touche ni au profil réel de Jarod ni à Hermes : tout vit dans un dossier temporaire supprimé à la fin.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { openCore } from "../context.js";
import { createGateway } from "./server.js";

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail: string): boolean => {
  results.push({ step, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${step}: ${detail}`);
  return ok;
};

// Une clé de la forme que la passerelle ne doit JAMAIS laisser sortir par /api/config/raw (assemblée à l'exécution).
const CANARY = ["sk", "VERIFY-0123456789abcdef0123456789"].join("-");
const MODELS = ["qwen3-8b", "gemma-3-4b-it", "text-embedding-nomic-embed-text-v1.5"];

const root = mkdtempSync(join(tmpdir(), "jarod-verify-"));
const lm = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }));
  } else res.writeHead(404).end();
});
const lmPort: number = await new Promise((ok) => lm.listen(0, "127.0.0.1", () => ok((lm.address() as { port: number }).port)));

const pm = new ProfileManager(root);
pm.create("verification");
pm.setActive("verification");
const env = { JAROD_HOME: root, JAROD_CUSTOM_API_KEY: CANARY };
let core = (await openCore({ env })).core;
core.settings.patch({ activeProvider: "custom", activeModel: "depart", providerOverrides: { lmstudio: { baseUrl: `http://127.0.0.1:${lmPort}/v1` } }, autoTitle: false });
const gateway = createGateway({ core, version: "verify" });
const port = await gateway.listen(0);
const base = `http://127.0.0.1:${port}`;

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${gateway.token}`);
const waiting = new Map<number, (f: { result?: any; error?: any }) => void>();
let nextId = 0;
ws.addEventListener("message", (m) => {
  const f = JSON.parse(String(m.data));
  if (f.id !== undefined && typeof f.method !== "string") waiting.get(f.id)?.(f);
});
await new Promise<void>((ok, bad) => {
  ws.addEventListener("open", () => ok());
  ws.addEventListener("error", () => bad(new Error("WebSocket refusé")));
});
const rpc = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<{ result?: any; error?: any }>((ok) => {
    const n = ++nextId;
    waiting.set(n, ok);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
  });
const get = async (path: string) => {
  const r = await fetch(`${base}${path}`, { headers: { "x-hermes-session-token": gateway.token } });
  return { status: r.status, text: await r.text() };
};

try {
  // 1. La passerelle répond (la sonde publique de Herald).
  const status = await fetch(`${base}/api/status`);
  check("passerelle joignable", status.ok, `GET /api/status → ${status.status}`);

  // 2. Le sélecteur voit les modèles du serveur local (profil neuf, aucune clé de fournisseur distant).
  const options = (await rpc("model.options", { include_unconfigured: false })).result;
  const lmRow = options?.providers?.find((p: { slug: string }) => p.slug === "lmstudio");
  const wanted = ["gemma-3-4b-it", "qwen3-8b"];
  check("sélecteur : modèles découverts", JSON.stringify(lmRow?.models) === JSON.stringify(wanted), `LM Studio → ${JSON.stringify(lmRow?.models)} (attendu ${JSON.stringify(wanted)}, sans l'embedding)`);
  check("sélecteur : pas de Whisper", !options?.providers?.some((p: { slug: string }) => p.slug === "local-whisper-cpp"), "le Whisper local (transcription) n'est pas proposé");

  // 3. Le choix de Herald : `/model fournisseur:modèle` dans une conversation.
  const sid = (await rpc("session.create", {})).result?.session_id as string;
  const chosen = await rpc("slash.exec", { session_id: sid, command: "/model lmstudio:qwen3-8b" });
  check("changement de fournisseur", /lmstudio \/ qwen3-8b/.test(String(chosen.result?.output)), String(chosen.result?.output ?? JSON.stringify(chosen.error)));
  const now = (await rpc("config.get", { key: "provider" })).result;
  check("réglage lu par la passerelle", now?.provider === "lmstudio" && now?.model === "qwen3-8b", `provider=${now?.provider} model=${now?.model}`);

  // 4. /api/config/raw suit le choix, sans secret.
  const raw = await get("/api/config/raw");
  const yaml = String(JSON.parse(raw.text).yaml ?? "");
  check("config/raw à jour", /provider: "lmstudio"/.test(yaml) && /default: "qwen3-8b"/.test(yaml), JSON.stringify(yaml));
  check("config/raw sans secret", !raw.text.includes(CANARY) && !raw.text.includes(String(lmPort)) && !/sk-/.test(raw.text), "ni clé, ni adresse du serveur");

  // 5. Persisté : on ferme le noyau et on le rouvre sur le même profil.
  ws.close();
  await gateway.close();
  await core.dispose();
  core = (await openCore({ env })).core;
  const [p, m] = [core.settings.get("activeProvider"), core.settings.get("activeModel")];
  check("réglage persistant", p === "lmstudio" && m === "qwen3-8b", `après réouverture : ${String(p)} / ${String(m)}`);
} catch (e) {
  check("exécution", false, e instanceof Error ? e.message : String(e));
} finally {
  await gateway.close().catch(() => {});
  await core.dispose().catch(() => {});
  lm.close();
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} étape(s) en échec sur ${results.length}.` : `\nToutes les étapes passent (${results.length}).`);
process.exit(failed.length ? 1 : 0);
