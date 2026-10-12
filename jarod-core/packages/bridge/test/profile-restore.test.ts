/**
 * Q14 — exercice complet de restauration, sur le vrai kernel du desktop (`openDesktopKernel`) et le vrai magasin
 * de clés de ce compte (Windows : DPAPI) : sauvegarde (`run-hermes-backup`) → restauration dans un profil NEUF
 * (`run-hermes-import` sur le `manifest.json` de la sauvegarde) → kernel rouvert sur ce profil → données
 * identiques : empreintes du manifeste (avant toute ouverture) et requêtes réelles (conversations, messages,
 * souvenirs, pièce jointe CHIFFRÉE relue, SOUL.md, skill). Le profil servi n'est ni modifié ni remplacé.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plainCipher } from "@jarod/contracts";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterEach, describe, expect, it } from "vitest";
import { createHandlers, type DesktopKernel, type DesktopShell } from "../src/main/handlers/index.js";
import { dispatchOneaiCall } from "../src/main/ipc.js";
import { type OpenedKernel, openDesktopKernel } from "../src/main/kernel.js";
import type { BackupManifest } from "../src/main/profile-backup.js";

afterEach(cleanup);

type Services = {
  memory: { memory: { add(content: string, type: never): unknown } };
  rag: { attachments: { save(name: string, mime: string, data: Buffer): { id: string }; read(id: string): Buffer } };
  storage: { dbEncryption: { encrypted: boolean; keyStore: string | null } };
};
const services = (k: OpenedKernel) => k.app as unknown as Services;

/** Ce que l'utilisateur retrouve : conversations, messages, souvenirs (lignes complètes). */
function query(k: DesktopKernel) {
  const db = k.agent.db;
  return {
    sessions: db.all("SELECT * FROM sessions ORDER BY id"),
    messages: db.all("SELECT * FROM messages ORDER BY id"),
    memories: db.all("SELECT * FROM memories ORDER BY id"),
  };
}

function handlersFor(k: OpenedKernel, dest: string, files: string[]) {
  const logs = tempDir();
  const shell = {
    appVersion: () => "1.2.3",
    tempDir: () => tempDir(),
    logsDir: () => logs,
    pickDestinationFolder: async () => dest,
    pickFile: async () => files.shift() ?? null,
    confirm: async () => true,
  } as unknown as DesktopShell;
  const handlers = createHandlers({ kernel: () => k, shell });
  return (channel: string, ...args: unknown[]) => dispatchOneaiCall(handlers, channel, args, true) as Promise<unknown>;
}

describe("Q14 — sauvegarde → restauration (profil neuf) → kernel rouvert → données identiques", () => {
  it("vrai kernel, vraie clé du compte ; empreintes du manifeste puis requêtes réelles ; profil servi intact", async () => {
    const root = tempDir();
    const opts = { dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "stub-model" } };
    const k1 = await openDesktopKernel(opts);
    let attachmentId: string;
    let before: ReturnType<typeof query>;
    let backup: string;
    let restored: string;
    try {
      expect(services(k1).storage.dbEncryption.encrypted).toBe(true);
      const s = k1.agent.sessions.create("Projet Q14");
      k1.agent.messages.add(s.id, { role: "user", content: "question sauvegardée" });
      k1.agent.messages.add(s.id, { role: "assistant", content: "réponse sauvegardée" });
      services(k1).memory.memory.add("préfère le thé", "preference" as never);
      writeFileSync(join(k1.dataDir, "SOUL.md"), "je suis Jarod");
      mkdirSync(join(k1.dataDir, "skills", "demo"), { recursive: true });
      writeFileSync(join(k1.dataDir, "skills", "demo", "SKILL.md"), "# demo\n");
      attachmentId = services(k1).rag.attachments.save("note.txt", "text/plain", Buffer.from("pièce jointe chiffrée")).id;
      before = query(k1);

      const dest = realpathSync.native(tempDir());
      const files: string[] = [];
      const call = handlersFor(k1, dest, files);
      const b = (await call("run-hermes-backup")) as { success: boolean; path: string };
      expect(b.success).toBe(true);
      backup = b.path;
      files.push(join(backup, "manifest.json"));
      const r = (await call("run-hermes-import", "ignoré")) as { success: boolean; path: string; error?: string };
      expect(r).toEqual({ success: true, path: join(root, "profiles", "default-restaure") });
      restored = r.path;
      expect(new ProfileManager(root).active()).toBe("default");
    } finally {
      await k1.dispose();
    }

    // Empreintes : chaque fichier du manifeste, à sa place dans le profil restauré, AVANT toute ouverture.
    const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as BackupManifest;
    expect(manifest.database.keyIncluded).toBe(false);
    expect(manifest.database.note).toMatch(/même compte Windows/);
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["jarod.db", "profil/SOUL.md", "profil/skills/demo/SKILL.md"]));
    for (const f of manifest.files) {
      const at = f.path === "jarod.db" ? join(restored, "jarod.db") : join(restored, ...f.path.slice("profil/".length).split("/"));
      expect(createHash("sha256").update(readFileSync(at)).digest("hex"), f.path).toBe(f.sha256);
    }

    // Kernel rouvert sur le profil restauré : même clé (magasin du compte), mêmes données.
    const k2 = await openDesktopKernel({ ...opts, profile: "default-restaure" });
    try {
      expect(k2.profile).toBe("default-restaure");
      expect(k2.dataDir).toBe(restored);
      expect(services(k2).storage.dbEncryption.encrypted).toBe(true);
      // Clé adoptée dans le magasin du compte : sous Windows, DPAPI (fichier protégé dans le dossier du profil).
      if (process.platform === "win32") {
        expect(services(k2).storage.dbEncryption.keyStore).toBe("Windows DPAPI (compte utilisateur)");
        expect(existsSync(join(restored, "db.key.dpapi"))).toBe(true);
        expect(existsSync(join(restored, "db.key"))).toBe(false);
      }
      expect(query(k2)).toEqual(before);
      expect(services(k2).rag.attachments.read(attachmentId).toString()).toBe("pièce jointe chiffrée");
      expect(readFileSync(join(k2.dataDir, "SOUL.md"), "utf8")).toBe("je suis Jarod");
      expect(readFileSync(join(k2.dataDir, "skills", "demo", "SKILL.md"), "utf8")).toBe("# demo\n");
    } finally {
      await k2.dispose();
    }

    // Le profil d'origine s'ouvre toujours, inchangé.
    const k3 = await openDesktopKernel(opts);
    try {
      expect(k3.profile).toBe("default");
      expect(query(k3)).toEqual(before);
    } finally {
      await k3.dispose();
    }
  }, 120_000);
});
