// Portage de packages/cli/test/serve.test.ts (rév. 2e180305).
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DISCORD_TOKEN_KEY, TELEGRAM_TOKEN_KEY } from "@jarod/contracts";
import { JarodApp, start, stop } from "@jarod/kernel";
import { RUNTIME_LOCK_FILE, readRuntimeLock, readSupervisorState, requestStop } from "@jarod/plugin-agent";
import { DEFAULT_ENGINE_CONFIG, type LocalEngineConfig, newPreset } from "@jarod/plugin-llm";
import { ProfileManager } from "@jarod/plugin-persona";
import { dpapiProtect, osCryptEncrypt } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";
import type { CliCore } from "../src/context.js";
import { engineAutoStartBlock, remoteLine, type ServeEngine, serve, webhooksLine } from "../src/serve.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-serve-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function profileRoot(): Promise<{ root: string; dataDir: string }> {
  const root = temp();
  const pm = new ProfileManager(root);
  const dataDir = pm.dirFor(pm.active());
  // Create the profile's database once, as the desktop app would. (`new JarodCore({ dataDir })` →
  // kernel avec plugin-storage.)
  await stop(await start(new JarodApp({ plugins: { storage: { dataDir } } })));
  return { root, dataDir };
}

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("jarod serve", { timeout: 60_000 }, () => {
  it("serves the profile, publishes itself, and stops cleanly on a stop request", async () => {
    const { root, dataDir } = await profileRoot();
    const lines: string[] = [];
    const running = serve({ version: "test", env: { JAROD_HOME: root }, pollMs: 20, log: (l) => lines.push(l) });

    await waitFor(() => readSupervisorState(root)?.mode === "serve");
    expect(readSupervisorState(root)).toMatchObject({ pid: process.pid, mode: "serve", dataDir });
    expect(readRuntimeLock(dataDir)).toMatchObject({ pid: process.pid, mode: "serve" });
    expect(lines.join("\n")).toMatch(/servi \(pid/);
    expect(lines.join("\n")).toMatch(/Outils sensibles : refusés/);

    expect(requestStop(root)).toBe(true);
    expect(await running).toBe(0);
    expect(readSupervisorState(root)).toBeNull();
    expect(existsSync(join(dataDir, RUNTIME_LOCK_FILE))).toBe(false);
  });

  it("annonce les déclencheurs entrants tels qu'ils sont — non démarrés, même quand le réglage est activé — et ne suggère pas que le moteur local tourne", async () => {
    const { root, dataDir } = await profileRoot();
    const kernel = new JarodApp({ plugins: { storage: { dataDir } } });
    const started = await start(kernel);
    (kernel as unknown as { storage: { settings: { set(k: string, v: unknown): void } } }).storage.settings.set("webhooks", { enabled: true, port: 8790 });
    await stop(started);
    const lines: string[] = [];
    const running = serve({ version: "test", env: { JAROD_HOME: root }, pollMs: 20, log: (l) => lines.push(l) });
    await waitFor(() => readSupervisorState(root)?.mode === "serve");
    const text = lines.join("\n");
    expect(text).toMatch(/Déclencheurs entrants : non démarrés : réglage activé mais service non lancé/);
    expect(text).not.toMatch(/Déclencheurs entrants : actif/);
    // Le moteur réel du kernel (câblage) : réglage éteint ⇒ « non démarré », jamais « actif ».
    expect(text).toMatch(/Moteur local : non démarré \(démarrage automatique non demandé\)/);
    expect(text).not.toMatch(/Moteur local : actif/);
    requestStop(root);
    expect(await running).toBe(0);
  });

  it("webhooksLine : lit l'état RÉEL du service, jamais le seul réglage", async () => {
    // Service non monté (plugin-scheduler absent du kernel de test).
    const bare = { settings: { get: () => undefined } } as unknown as Parameters<typeof webhooksLine>[0];
    expect(await webhooksLine(bare)).toBe("non démarrés (service non disponible)");
    // Réglage éteint, service non lancé.
    const off = {
      settings: { get: (k: string) => (k === "webhooks" ? { enabled: false } : undefined) },
      webhooks: { status: () => ({ running: false, port: 0, hooks: [] }) },
    } as unknown as Parameters<typeof webhooksLine>[0];
    expect(await webhooksLine(off)).toBe("non démarrés : réglage éteint");
    // Réglage allumé mais service non lancé : jamais « actif ».
    const on = {
      settings: { get: (k: string) => (k === "webhooks" ? { enabled: true } : undefined) },
      webhooks: { status: () => ({ running: false, port: 0, hooks: [] }) },
    } as unknown as Parameters<typeof webhooksLine>[0];
    expect(await webhooksLine(on)).toContain("réglage activé mais service non lancé");
    expect(await webhooksLine(on)).not.toContain("actif (");
    // Service réellement lancé : la ligne dit le port et le nombre de déclencheurs.
    const live = {
      settings: { get: (k: string) => (k === "webhooks" ? { enabled: true } : undefined) },
      webhooks: { status: () => ({ running: true, port: 8079, hooks: [{}, {}] }) },
    } as unknown as Parameters<typeof webhooksLine>[0];
    expect(await webhooksLine(live)).toBe("actif (127.0.0.1:8079, 2 déclencheur(s))");
  });

  it("annonce l'accès distant tel qu'il est — non démarré, même quand le réglage est activé", async () => {
    const { root, dataDir } = await profileRoot();
    const kernel = new JarodApp({ plugins: { storage: { dataDir } } });
    const started = await start(kernel);
    const settings = (kernel as unknown as { storage: { settings: { get(k: string): unknown; set(k: string, v: unknown): void } } }).storage.settings;
    settings.set("remote", { ...(settings.get("remote") as object), enabled: true, relayUrl: "https://relais.invalide" });
    await stop(started);
    const lines: string[] = [];
    const running = serve({ version: "test", env: { JAROD_HOME: root }, pollMs: 20, log: (l) => lines.push(l) });
    await waitFor(() => readSupervisorState(root)?.mode === "serve");
    const text = lines.join("\n");
    expect(text).toMatch(/Accès distant : non démarré \(reporté P4\) — le réglage est activé mais ignoré/);
    expect(text).not.toMatch(/Accès distant : actif/);
    requestStop(root);
    expect(await running).toBe(0);
  });

  it("remoteLine : réglage éteint ou allumé, jamais « actif » tant que le démarrage n'existe pas", () => {
    expect(remoteLine(false)).toBe("non démarré (reporté P4)");
    expect(remoteLine(true)).toContain("ignoré");
    expect(remoteLine(true)).not.toContain("actif");
  });

  describe("moteur local (autoStart)", () => {
    const ELSEWHERE = resolve("/jarod-hors-du-dossier-temporaire");
    const installed = { tag: "b1", backend: "cpu" as const, dir: "x", bin: "x", at: 1 };
    const engineOn: Partial<LocalEngineConfig> = {
      autoStart: true,
      installed,
      presets: [newPreset({ id: "p", name: "qwen", model: "x" })],
      activePreset: "p",
    };

    async function profileWithEngine(over: Partial<LocalEngineConfig>): Promise<string> {
      const { root, dataDir } = await profileRoot();
      const kernel = new JarodApp({ plugins: { storage: { dataDir } } });
      const started = await start(kernel);
      (kernel as unknown as { storage: { settings: { set(k: string, v: unknown): void } } }).storage.settings.set("localEngine", { ...DEFAULT_ENGINE_CONFIG, ...over });
      await stop(started);
      return root;
    }

    /** Un moteur dont seul le processus est faux : la config vient du réglage du profil, comme pour `EngineService`. */
    function fake(how: "ok" | "fail") {
      const probe = { starts: 0, up: false };
      const make = (core: CliCore): ServeEngine => ({
        config: () => ({ ...DEFAULT_ENGINE_CONFIG, ...core.settings.get("localEngine") }),
        start: async () => {
          probe.starts++;
          if (how === "fail") throw new Error("LLAMA_NOT_READY: aucune réponse sur le port 8080");
          probe.up = true;
          return { running: true, ready: true, port: 8080, pid: 1, model: "x", restarts: 0, lastError: null };
        },
        running: () => probe.up,
      });
      return { probe, make };
    }

    async function serveOnce(root: string, extra: Parameters<typeof serve>[0] extends infer O ? Partial<O> : never): Promise<{ code: number; text: string }> {
      const lines: string[] = [];
      const running = serve({ version: "test", env: { JAROD_HOME: root }, pollMs: 20, log: (l) => lines.push(l), ...extra });
      await waitFor(() => lines.some((l) => /^Moteur local : (actif|non démarré)/.test(l)));
      expect(readSupervisorState(root)?.mode).toBe("serve");
      requestStop(root);
      const code = await running;
      return { code, text: lines.join("\n") };
    }

    it("démarre le moteur quand tout l'autorise, et l'annonce d'après son état", async () => {
      const root = await profileWithEngine(engineOn);
      const f = fake("ok");
      const { code, text } = await serveOnce(root, { engine: f.make, tmpRoot: ELSEWHERE });
      expect(code).toBe(0);
      expect(f.probe.starts).toBe(1);
      expect(text).toMatch(/Moteur local : actif \(port 8080, préréglage « qwen »\)/);
    });

    it("garde (a) : un échec de démarrage n'est pas fatal — journalisé, serve continue et s'arrête proprement, l'annonce dit « non démarré »", async () => {
      const root = await profileWithEngine(engineOn);
      const f = fake("fail");
      const { code, text } = await serveOnce(root, { engine: f.make, tmpRoot: ELSEWHERE });
      expect(code).toBe(0);
      expect(f.probe.starts).toBe(1);
      expect(text).toMatch(/Moteur local : échec du démarrage — LLAMA_NOT_READY/);
      expect(text).toMatch(/Moteur local : non démarré \(échec du démarrage : LLAMA_NOT_READY.*\) — serve continue sans moteur local/);
      expect(text).not.toMatch(/Moteur local : actif/);
      expect(text).toMatch(/Arrêté\./);
      expect(readSupervisorState(root)).toBeNull();
    });

    it("garde (b) : désactivé en JAROD_TEST_MODE, même réglage activé — aucun démarrage tenté, l'annonce dit « ignoré »", async () => {
      const root = await profileWithEngine(engineOn);
      const f = fake("ok");
      const { text } = await serveOnce(root, { engine: f.make, tmpRoot: ELSEWHERE, env: { JAROD_HOME: root, JAROD_TEST_MODE: "1" } });
      expect(f.probe.starts).toBe(0);
      expect(text).toMatch(/Moteur local : non démarré — le démarrage automatique est activé mais ignoré \(mode test\)/);
      expect(text).not.toMatch(/Moteur local : actif/);
    });

    it("garde (b) : désactivé pour un profil temporaire (celui des gates et des tests, sous le dossier temporaire du système)", async () => {
      const root = await profileWithEngine(engineOn);
      const f = fake("ok");
      const { text } = await serveOnce(root, { engine: f.make }); // tmpRoot par défaut = os.tmpdir() : le profil y est
      expect(f.probe.starts).toBe(0);
      expect(text).toMatch(/activé mais ignoré \(profil temporaire\)/);
      expect(text).not.toMatch(/Moteur local : actif/);
    });

    it("garde (c) : l'annonce reflète l'état du moteur, jamais le réglage — réglage activé sans moteur installé ni préréglage, ou éteint", async () => {
      const f = fake("ok");
      const noEngine = await serveOnce(await profileWithEngine({ autoStart: true }), { engine: f.make, tmpRoot: ELSEWHERE });
      expect(f.probe.starts).toBe(0);
      expect(noEngine.text).toMatch(/Moteur local : non démarré — .* ignoré \(moteur llama\.cpp non installé\)/);
      const noPreset = await serveOnce(await profileWithEngine({ autoStart: true, installed }), { engine: f.make, tmpRoot: ELSEWHERE });
      expect(f.probe.starts).toBe(0);
      expect(noPreset.text).toMatch(/ignoré \(aucun préréglage actif\)/);
      const off = await serveOnce(await profileWithEngine({ ...engineOn, autoStart: false }), { engine: f.make, tmpRoot: ELSEWHERE });
      expect(f.probe.starts).toBe(0);
      expect(off.text).toMatch(/Moteur local : non démarré \(démarrage automatique non demandé\)/);
      for (const r of [noEngine, noPreset, off]) expect(r.text).not.toMatch(/Moteur local : actif/);
    });

    it("engineAutoStartBlock : mode test, sous le dossier temporaire, ailleurs", () => {
      expect(engineAutoStartBlock(ELSEWHERE, { JAROD_TEST_MODE: "1" }, ELSEWHERE)).toBe("mode test");
      expect(engineAutoStartBlock(join(ELSEWHERE, "profil"), {}, ELSEWHERE)).toBe("profil temporaire");
      expect(engineAutoStartBlock(resolve("/autre-racine/profil"), {}, ELSEWHERE)).toBeNull();
      // Un dossier frère dont le nom commence pareil n'est pas « sous » le dossier temporaire.
      expect(engineAutoStartBlock(`${ELSEWHERE}-voisin`, {}, ELSEWHERE)).toBeNull();
    });
  });

  it("refuses a profile another live process already serves", async () => {
    const { root, dataDir } = await profileRoot();
    // The parent process of the test runner is alive and is not us: it stands for the desktop app.
    writeFileSync(
      join(dataDir, RUNTIME_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, mode: "desktop", startedAt: 1 }),
    );
    const lines: string[] = [];
    expect(await serve({ version: "test", env: { JAROD_HOME: root }, log: (l) => lines.push(l) })).toBe(1);
    expect(lines.join("\n")).toMatch(/application de bureau, pid/);
    expect(readSupervisorState(root)).toBeNull();
  });

  it("reads messaging tokens from the environment — except Telegram (B3 : coffre du profil seulement)", async () => {
    const { root } = await profileRoot();
    const { core } = await openCore({
      env: { JAROD_HOME: root, JAROD_USER_DATA: temp(), DISCORD_BOT_TOKEN: "d:abc", TELEGRAM_BOT_TOKEN: "123:abc", JAROD_TELEGRAM_TOKEN: "456:def" },
    });
    expect(core.settings.getSecret(DISCORD_TOKEN_KEY)).toBe("d:abc");
    expect(core.settings.getSecret(TELEGRAM_TOKEN_KEY)).toBeUndefined();
    await core.dispose();
  });

  it.runIf(process.platform === "win32")(
    "B3 : jeton Telegram lu dans le coffre chiffré du profil (safeStorage du desktop, clé de Local State via DPAPI), l'environnement ignoré",
    async () => {
      const { root, dataDir } = await profileRoot();
      // `Local State` comme l'écrit Electron (clé os_crypt protégée par le DPAPI du compte), dans un userData de test.
      const userData = temp();
      const key = randomBytes(32);
      const encrypted_key = Buffer.concat([Buffer.from("DPAPI", "latin1"), dpapiProtect(key)]).toString("base64");
      writeFileSync(join(userData, "Local State"), JSON.stringify({ os_crypt: { encrypted_key } }));
      const FAKE = "000000:jarod-test-fake-token";
      // Écriture « desktop » : safeStorage → `ss:` + v10 (policies.ts) dans la base chiffrée du profil.
      const desktop = new JarodApp({
        plugins: { storage: { dataDir, cipher: { encrypt: (s: string) => `ss:${osCryptEncrypt(key, s).toString("base64")}`, decrypt: () => "" } } },
      });
      const started = await start(desktop);
      (desktop as unknown as { storage: { settings: { setSecret(k: string, v: string): void } } }).storage.settings.setSecret(TELEGRAM_TOKEN_KEY, FAKE);
      await stop(started);

      const { core } = await openCore({ env: { JAROD_HOME: root, JAROD_USER_DATA: userData, TELEGRAM_BOT_TOKEN: "123:env", JAROD_TELEGRAM_TOKEN: "456:env" } });
      expect(core.settings.getSecret(TELEGRAM_TOKEN_KEY)).toBe(FAKE);
      await core.dispose();
      // Autre clé os_crypt (autre compte, Local State absent) : absent — jamais de repli sur l'environnement.
      const { core: other } = await openCore({ env: { JAROD_HOME: root, JAROD_USER_DATA: temp(), TELEGRAM_BOT_TOKEN: "123:env" } });
      expect(other.settings.getSecret(TELEGRAM_TOKEN_KEY)).toBeUndefined();
      await other.dispose();
    },
  );
});
