/**
 * UpdateService sur un VRAI kernel (storage : réglages + notifications). Premier test : portage de
 * `packages/core/test/round3.test.ts:320-355` (rév. 2e180305 — `new JarodCore({ appVersion, updateFolder })`
 * → plugin `updates` configuré pareil). Ensuite : canal distant + repli local (G1, Jarod-cordis).
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { fakeBlockmap, writeInstaller } from "../src/testing.js";
import { findLocalUpdate, isUnreachable, type RemoteUpdater, type UpdateCandidate, type UpdateService } from "../src/index.js";

afterEach(cleanup);
const testKeys = memoryKeyStore();

async function core(updates: Record<string, unknown> = {}) {
  const app = (await bootApp({ storage: { dataDir: tempDir(), keyStores: [testKeys] }, updates: { appVersion: "0.1.0", ...updates } })) as unknown as {
    updates: UpdateService;
    storage: { settings: import("@jarod/plugin-storage").SettingsService; notifications: import("@jarod/plugin-storage").NotificationService };
    on(name: string, cb: (...a: never[]) => void): () => void;
  };
  return app;
}

describe("updates (round3.test.ts:320-355)", () => {
  it("finds the newest finished installer in the local folder and notifies once", async () => {
    const folder = tempDir();
    const touch = (name: string) => writeFileSync(join(folder, name), "x");
    await writeInstaller(folder, "0.2.0");
    // 0.3.0 : l'installeur et son manifeste sont là, mais le .blockmap (écrit en dernier par le builder) pas encore.
    const trois = await writeInstaller(folder, "0.3.0");
    rmSync(`${trois}.blockmap`);
    touch("Jarod-One 0.4.0.exe"); // portable build, not an installer
    touch("notes.txt");

    const app = await core({ updateFolder: folder });
    const c = app.updates;
    expect(c.checkUpdates()).toMatchObject({
      version: "0.2.0",
      installer: join(folder, "Jarod-One-0.2.0-setup.exe"),
    });
    expect(app.storage.notifications.list()).toHaveLength(1);
    c.checkUpdates();
    expect(app.storage.notifications.list()).toHaveLength(1); // same version: no second notification

    writeFileSync(`${trois}.blockmap`, fakeBlockmap(Buffer.byteLength("installeur 0.3.0")));
    expect(c.checkUpdates()?.version).toBe("0.3.0");
    expect(app.storage.notifications.list()).toHaveLength(2);

    // A folder chosen in the settings wins over the default one.
    app.storage.settings.patch({ updates: { ...app.storage.settings.get("updates"), folder: tempDir() } });
    expect(c.checkUpdates()).toBeNull();
    expect(findLocalUpdate("0.3.0", folder)).toBeNull();
    await expect((async () => (await core()).updates.checkUpdates({ force: true }))()).rejects.toThrow(/dossier des installeurs/);
  });
});

function remote(behaviour: { check?: () => Promise<{ version: string; releaseNotes?: string } | null>; download?: () => Promise<void> }) {
  const calls: string[] = [];
  const r: RemoteUpdater = {
    check: async () => (calls.push("check"), behaviour.check ? behaviour.check() : null),
    download: async (p) => {
      calls.push("download");
      p?.(50);
      p?.(100);
      if (behaviour.download) await behaviour.download();
    },
    install: () => void calls.push("install"),
  };
  return { r, calls };
}

const localFolder = async (version: string) => {
  const folder = tempDir();
  await writeInstaller(folder, version);
  return folder;
};

describe("updates : canal distant et repli local (G1)", () => {
  it("version distante : proposée, téléchargée par l'hôte, installée par l'hôte ; événement une fois", async () => {
    const app = await core({ updateFolder: await localFolder("0.9.0") });
    const seen: UpdateCandidate[] = [];
    app.on("update:available", (c: UpdateCandidate) => void seen.push(c));
    const { r, calls } = remote({ check: async () => ({ version: "0.2.0", releaseNotes: "notes" }) });
    app.updates.setRemote(r);
    expect(await app.updates.check()).toEqual({ source: "remote", version: "0.2.0", releaseNotes: "notes" });
    await app.updates.check();
    expect(seen).toHaveLength(1); // même version : pas de second événement
    const progress: number[] = [];
    expect(await app.updates.download((p) => progress.push(p))).toMatchObject({ source: "remote", version: "0.2.0" });
    expect(progress).toEqual([50, 100]);
    expect(app.updates.install()).toEqual({ source: "remote" });
    expect(calls).toEqual(["check", "check", "download", "install"]);
    // Le flux fait foi : le dossier local (0.9.0) n'est pas lu quand le distant répond.
    expect(app.storage.notifications.list()).toHaveLength(0);
  });

  it("flux à jour (rien de neuf) : aucune version, dossier local ignoré", async () => {
    const app = await core({ updateFolder: await localFolder("0.9.0") });
    app.updates.setRemote(remote({ check: async () => null }).r);
    expect(await app.updates.check()).toBeNull();
    expect(app.updates.remoteError()).toBeNull();
  });

  it("hors-ligne : repli sur le dossier local, la raison est gardée", async () => {
    const app = await core({ updateFolder: await localFolder("0.3.0") });
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    app.updates.setRemote(remote({ check: async () => Promise.reject(err) }).r);
    const c = await app.updates.check();
    expect(c).toMatchObject({ source: "local", version: "0.3.0" });
    expect(app.updates.remoteError()).toMatch(/ENOTFOUND/);
    // Version locale : rien à télécharger ; l'installeur est rendu à l'hôte.
    expect(await app.updates.download()).toMatchObject({ source: "local" });
    const local = c as { installer: string; sha512: string; size: number };
    expect(app.updates.install()).toEqual({ source: "local", installer: local.installer, sha512: local.sha512, size: local.size });
  });

  it("erreur d'intégrité ou de signature : remonte, AUCUN repli silencieux", async () => {
    const app = await core({ updateFolder: await localFolder("0.3.0") });
    app.updates.setRemote(remote({ check: async () => Promise.reject(new Error("New version 0.2.0 is not signed by the application owner")) }).r);
    await expect(app.updates.check()).rejects.toThrow(/not signed/);
    app.updates.setRemote(
      remote({ check: async () => ({ version: "0.2.0" }), download: async () => Promise.reject(new Error("sha512 checksum mismatch")) }).r,
    );
    await app.updates.check();
    await expect(app.updates.download()).rejects.toThrow(/sha512 checksum mismatch/);
  });

  it("sans canal distant (CLI, dev) : dossier local seul ; rien à installer sans vérification préalable", async () => {
    const app = await core({ updateFolder: await localFolder("0.2.0") });
    expect(() => app.updates.install()).toThrow(/vérifiez d'abord/);
    expect(await app.updates.check()).toMatchObject({ source: "local", version: "0.2.0" });
    expect(app.updates.hasRemote()).toBe(false);
  });

  it("isUnreachable : réseau et flux absent oui ; intégrité, signature, HTTP 404 non", () => {
    for (const m of ["getaddrinfo ENOTFOUND x", "connect ECONNREFUSED 127.0.0.1:9", "net::ERR_INTERNET_DISCONNECTED", "ENOENT app-update.yml", "NO_FEED"]) {
      expect(isUnreachable(new Error(m)), m).toBe(true);
    }
    for (const m of ["sha512 checksum mismatch", "is not signed by the application owner", "HttpError: 404", "Cannot parse update info"]) {
      expect(isUnreachable(new Error(m)), m).toBe(false);
    }
  });

  it("vérification périodique : seulement si `updates.autoCheck`", async () => {
    const app = await core({ updateFolder: await localFolder("0.2.0"), timer: true, firstDelayMs: 10, intervalMs: 60_000 });
    const seen: UpdateCandidate[] = [];
    app.on("update:available", (c: UpdateCandidate) => void seen.push(c));
    await new Promise((r) => setTimeout(r, 80));
    expect(seen.map((c) => c.version)).toEqual(["0.2.0"]);
    const off = await core({ updateFolder: await localFolder("0.2.0"), timer: true, firstDelayMs: 10 });
    off.storage.settings.patch({ updates: { ...off.storage.settings.get("updates"), autoCheck: false } });
    const none: unknown[] = [];
    off.on("update:available", (c: never) => void none.push(c));
    await new Promise((r) => setTimeout(r, 80));
    expect(none).toEqual([]);
  });
});
