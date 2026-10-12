/**
 * ⚠ GATE VIVANTE — opt-in OBLIGATOIRE : `GATE_TELEGRAM_LIVE=1` (sinon refus, `telegram-live.ts`).
 * ⚠ Envoie un VRAI message Telegram au propriétaire du bot et attend sa réponse HUMAINE pendant
 * ⚠ `JAROD_GATE_TG_WAIT_S` secondes (défaut 600). Gate Hermes ET desktop Jarod arrêtés au préalable (getUpdates exclusif).
 * Lancement : `pnpm gate:p3-telegram` (seule) ou `pnpm gate:p3` (dictée puis Telegram).
 *
 * GATE P3 (PLAN §6) — volet Telegram : « gateways Telegram vivantes sur le nouveau kernel ».
 *
 * Processus réel `jarod serve` (serve.ts porté) → kernel cordis (plugin-gateways) → VRAI Bot API
 * Telegram (api.telegram.org), jeton du coffre du profil default. Le fournisseur LLM est le stub réseau
 * OpenAI-compatible de la gate P1 : ce qui est éprouvé ici, c'est la passerelle, pas le modèle.
 *
 * 1. Connexion : `getMe` réel → statut `running` + nom du bot, long-polling actif.
 * 2. Sortant : une tâche planifiée livrée sur Telegram au propriétaire (`runtime.deliver` →
 *    `sendMessage` réel) ; la notification « succès » prouve que l'API a répondu `ok`.
 * 3. Entrant : le message livré demande au propriétaire de répondre ; sa réponse (humaine, réelle)
 *    traverse getUpdates → liste d'autorisation → agent → réponse renvoyée, conversation en base.
 *    Attente bornée par JAROD_GATE_TG_WAIT_S (défaut 600 s) : sans réponse humaine, la gate échoue.
 *
 * Secrets (B3) : EXCLUSIVEMENT le coffre chiffré du profil default du desktop (`<userData>/data/profiles/default`,
 * base chiffrée par sa clé dbkey/DPAPI), ouvert en LECTURE SEULE. La gate n'y déchiffre rien : elle recopie la
 * valeur chiffrée `gateway:telegram:token` (`ss:`, safeStorage) telle quelle dans le coffre du profil temporaire, et
 * `jarod serve` la déchiffre lui-même (`electronSecretsCipher`, clé de `Local State`). Le propriétaire = le chat
 * appairé (`settings.telegram.allowedChatIds`). Aucun jeton dans l'environnement, le dépôt, le journal ni le
 * rapport (motif de jeton masqué) ; le profil temporaire est supprimé à la fin.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TELEGRAM_TOKEN_KEY } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { readSupervisorState, readSupervisorStatus, requestStop } from "@jarod/plugin-agent";
import { defaultKeyStores, electronUserDataDir } from "@jarod/plugin-storage";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { telegramLiveOptIn } from "./telegram-live.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "packages", "cli", "bin", "jarod.mjs");
/** Profil default du desktop (`dataRoot()` de `desktop/src/main/index.ts` sans surcharge de test). */
const SOURCE_ROOT = join(electronUserDataDir(), "data");
const SOURCE_PROFILE = join(SOURCE_ROOT, "profiles", "default");
// Refus AVANT toute lecture de secret ou tout processus, y compris lancé par `vitest run` direct.
const optIn = telegramLiveOptIn();
if (!optIn.ok) throw new Error(optIn.refusal);
console.warn(optIn.warning);
const WAIT_HUMAN_S = optIn.waitS;
const MARK = "GATE-P3-LIVRAISON";

/**
 * Coffre du profil default, LECTURE SEULE : valeur CHIFFRÉE du jeton (jamais déchiffrée ici) et chat appairé.
 * Clé de la base : magasins du profil (DPAPI, puis fichier), sans en créer.
 */
function readSourceVault(): { sealed?: string; owner?: string } {
  const key = defaultKeyStores()
    .map((s) => s.load(SOURCE_PROFILE))
    .find(Boolean);
  if (!key) return {};
  const db = new Database(join(SOURCE_PROFILE, "jarod.db"), { readonly: true, fileMustExist: true });
  try {
    db.pragma("cipher = 'chacha20'");
    db.pragma(`key = '${key.replace(/'/g, "''")}'`);
    const sealed = (db.prepare("SELECT value FROM secrets WHERE key = ?").get(TELEGRAM_TOKEN_KEY) as { value?: string } | undefined)?.value;
    const tg = db.prepare("SELECT value FROM settings WHERE key = 'telegram'").get() as { value?: string } | undefined;
    const ids = tg?.value ? ((JSON.parse(tg.value) as { allowedChatIds?: unknown }).allowedChatIds ?? []) : [];
    const owner = (Array.isArray(ids) ? ids : []).map(String).find((u) => /^-?\d+$/.test(u));
    return { ...(sealed ? { sealed } : {}), ...(owner ? { owner } : {}) };
  } finally {
    db.close();
  }
}

/** Refus AVANT toute connexion : le desktop (ou un `jarod serve`) sert déjà le profil default → getUpdates en conflit. */
const busy = readSupervisorStatus(SOURCE_ROOT);
if (busy.state && !busy.stale) throw new Error(`GATE P3 TELEGRAM REFUSÉE : le profil default est servi (pid ${busy.state.pid}, ${busy.state.mode}) — fermez le desktop Jarod.`);
const { sealed, owner } = readSourceVault();
/** Tout ce qui ressemble à un jeton de bot (`<id>:<35 car.>`), puis les longs nombres (id du bot, du propriétaire). */
const redact = (s: string) =>
  s.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, "<jeton>").replace(/\d{6,}/g, (d) => (d === owner ? "<propriétaire>" : d));

const report: string[] = [];
const log = (l: string) => {
  const line = redact(l);
  report.push(line);
  console.log(`[gate-p3-telegram] ${line}`);
};

interface Stub {
  port: number;
  close: () => void;
  /** Dernier message utilisateur de chaque requête reçue. */
  prompts: string[];
}

/** Stub OpenAI-compatible (gate P1) : consigne de réponse pour la livraison, accusé de réception sinon. */
function startStubProvider(): Promise<Stub> {
  const prompts: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const payload = body ? (JSON.parse(body) as { stream?: boolean; messages?: { role: string; content: unknown }[] }) : {};
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "jarod-test-model" }] }));
        return;
      }
      const last = [...(payload.messages ?? [])].reverse().find((m) => m.role === "user");
      const text =
        typeof last?.content === "string"
          ? last.content
          : Array.isArray(last?.content)
            ? (last.content as { text?: string }[]).map((p) => p.text ?? "").join("")
            : "";
      prompts.push(text);
      const reply = text.includes(MARK)
        ? "Gate P3 (volet Telegram) : ce message vient de Jarod sur le nouveau kernel cordis. Répondez-moi par n'importe quel texte (pas /start) pour valider le volet entrant."
        : `Bien reçu : « ${text.slice(0, 200)} » — Jarod (kernel cordis) vous répond via Telegram. Gate P3 : volet entrant validé.`;
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      done({ port: typeof a === "object" && a ? a.port : 0, close: () => server.close(), prompts });
    });
  });
}

type Kernel = {
  storage: { settings: { patch(v: Record<string, unknown>): unknown } };
  scheduler: { save(input: Record<string, unknown>): { id: string } };
  agent: {
    db: { get<T>(sql: string, ...args: unknown[]): T | undefined; run(sql: string, ...args: unknown[]): unknown };
    sessions: { get(id: string): { title: string } | undefined };
    messages: { list(id: string): { role: string; content: string }[] };
  };
};

/** Ouvre le profil par le kernel (sans passerelles ni verrou) : préparation, puis relecture. */
async function withKernel<T>(dataDir: string, fn: (k: Kernel) => T): Promise<T> {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir };
  plugins.scheduler = { autoStart: false };
  plugins.gateways = { autoStart: false };
  plugins.agent = { runtimeLock: false, curatorTimer: false };
  plugins.mcp = { autoSync: false };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  try {
    return fn(app as unknown as Kernel);
  } finally {
    await stop(started);
  }
}

const until = async (check: () => boolean, ms: number, step = 250): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
  return true;
};

describe("GATE P3 — volet Telegram : passerelle vivante sur le nouveau kernel (jarod serve)", () => {
  it(
    "getMe réel, livraison sortante réelle, message humain entrant → réponse de l'agent",
    { timeout: (WAIT_HUMAN_S + 240) * 1000 },
    async () => {
      expect(sealed, "B3 : gateway:telegram:token absent du coffre du profil default (écran Passerelles)").toBeTruthy();
      expect(sealed!.startsWith("ss:"), "B3 : jeton du coffre non chiffré par safeStorage").toBe(true);
      expect(owner, "aucun chat appairé dans le profil default (settings.telegram.allowedChatIds)").toBeTruthy();
      const stub = await startStubProvider();
      const home = mkdtempSync(join(tmpdir(), "jarod-gate-p3tg-"));
      const dataDir = join(home, "profiles", "default");
      mkdirSync(dataDir, { recursive: true });
      try {
        // Profil neuf : fournisseur stub, Telegram activé pour le seul propriétaire, une livraison planifiée, et la
        // valeur chiffrée du jeton recopiée telle quelle dans son coffre (rien de déchiffré par la gate).
        await withKernel(dataDir, (k) => {
          k.agent.db.run("INSERT INTO secrets (key, value) VALUES (?, ?)", TELEGRAM_TOKEN_KEY, sealed);
          k.storage.settings.patch({
            activeProvider: "custom",
            activeModel: "jarod-test-model",
            providerOverrides: { custom: { baseUrl: `http://127.0.0.1:${stub.port}/v1` } },
            telegram: { enabled: true, allowedChatIds: [owner] },
            autoTitle: false,
          });
          k.scheduler.save({
            name: "Gate P3",
            prompt: `${MARK} : annonce la gate au propriétaire.`,
            spec: { kind: "once", at: Date.now() + 20_000 },
            deliver: { gateway: "telegram", chatId: owner },
          });
        });

        // `jarod serve`, vrai processus : le jeton vient de SON coffre ; aucune variable de jeton dans son environnement.
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "TELEGRAM_BOT_TOKEN" && k !== "JAROD_TELEGRAM_TOKEN"),
        );
        const child = spawn(process.execPath, [CLI, "serve"], {
          cwd: home,
          env: { ...env, JAROD_HOME: home, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const lines: string[] = [];
        const onData = (c: Buffer) => {
          for (const l of c.toString("utf8").split(/\r?\n/)) {
            if (!l.trim()) continue;
            lines.push(l);
            log(`serve │ ${l}`);
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
        const has = (re: RegExp) => lines.some((l) => re.test(l));

        try {
          // 1. Connexion réelle.
          const t0 = Date.now();
          const running = await until(() => has(/Passerelle : .*"id":"telegram".*"state":"running".*"botName"/), 60_000);
          log(`1. connexion : ${running ? "running" : "ÉCHEC"} en ${Date.now() - t0} ms`);
          expect(running, "le bot n'a pas atteint l'état running (jeton du coffre illisible par jarod serve ?)").toBe(true);
          const status = JSON.parse(lines.find((l) => /"state":"running"/.test(l))!.replace(/^.*Passerelle : /, "")) as {
            botName?: string;
          };
          expect(status.botName).toBeTruthy();

          // 2. Sortant réel : la tâche planifiée est livrée (notification succès = sendMessage ok).
          const t1 = Date.now();
          const delivered = await until(() => has(/\[(success|error)\] Tâche planifiée « Gate P3 »/), 120_000);
          const ok = has(/\[success\] Tâche planifiée « Gate P3 »/);
          log(`2. livraison sortante : ${ok ? "OK" : delivered ? "ÉCHEC" : "délai dépassé"} en ${Date.now() - t1} ms`);
          expect(ok, "la livraison planifiée sur Telegram a échoué").toBe(true);
          expect(stub.prompts.some((p) => p.includes(MARK))).toBe(true);

          // 3. Entrant réel : une réponse humaine du propriétaire.
          log(`3. en attente d'un message du propriétaire sur Telegram (≤ ${WAIT_HUMAN_S} s)…`);
          const t2 = Date.now();
          const human = await until(() => stub.prompts.some((p) => !p.includes(MARK)), WAIT_HUMAN_S * 1000, 1000);
          log(`3. message entrant : ${human ? `reçu en ${Math.round((Date.now() - t2) / 1000)} s` : "AUCUN (délai dépassé)"}`);
          expect(human, "aucun message humain reçu dans le délai (JAROD_GATE_TG_WAIT_S)").toBe(true);
          // Laisse partir la réponse (sendMessage) avant l'arrêt.
          await new Promise((r) => setTimeout(r, 5_000));
          expect(has(/"id":"telegram","state":"error"/)).toBe(false);
        } finally {
          requestStop(home);
          const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
          if (code === null) child.kill();
          log(`arrêt : code ${code}`);
        }
        expect(readSupervisorState(home)).toBeNull();

        // Relecture : la conversation Telegram du propriétaire est en base, avec la réponse de l'agent.
        const convo = await withKernel(dataDir, (k) => {
          const row = k.agent.db.get<{ session_id: string }>(
            "SELECT session_id FROM gateway_chats WHERE gateway = 'telegram' AND chat_id = ?",
            owner,
          );
          return row ? { title: k.agent.sessions.get(row.session_id)?.title, msgs: k.agent.messages.list(row.session_id) } : null;
        });
        log(`base : ${JSON.stringify(convo && { title: convo.title, msgs: convo.msgs.map((m) => [m.role, m.content.slice(0, 80)]) })}`);
        expect(convo).not.toBeNull();
        expect(convo!.msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(convo!.msgs[1]!.content).toMatch(/Bien reçu/);
      } finally {
        stub.close();
        // Le profil temporaire porte une copie chiffrée du jeton : supprimé.
        rmSync(home, { recursive: true, force: true });
        mkdirSync(join(ROOT, ".work"), { recursive: true });
        writeFileSync(join(ROOT, ".work", `gate-p3-telegram-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
      }
    },
  );
});
