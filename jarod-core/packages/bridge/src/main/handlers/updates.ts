/**
 * Mises à jour (U1, gap G1) : canaux hermesAPI `check-for-updates`, `download-update`, `install-update`,
 * `get|set-auto-upgrade-enabled` et événements `update-available|download-progress|downloaded|error`,
 * aux FORMES de SANK-UI `src/main/app/updater.ts:40-110` (rév. 3aaadb0, MIT © github.com/fathah) :
 * `check` rend la version ou null, `download` rend un booléen et pousse `update-error` en cas d'échec.
 * Service : plugin-updates (canal distant de l'hôte, repli sur le dossier local hors-ligne).
 * Installation d'une version LOCALE : `stageInstaller` = `Jarod-one/packages/desktop/src/main/handlers/
 * updates.ts:6-22` (rév. 2e180305) verbatim, puis installation silencieuse (installé) ou ouverture (dev).
 *
 * Écarts assumés : `check-for-updates` rend null sur erreur comme SANK-UI, mais l'erreur est POUSSÉE
 * (`update-error`) au lieu d'être avalée ; « mise à jour automatique » = le réglage `updates.autoCheck`
 * (le DTO n'a pas d'`autoDownload` ; 5d).
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { verifyInstaller, type UpdateService } from "@jarod/plugin-updates";
import { assertProfile, type HandlerContext } from "./context.js";

/**
 * Copies the installer into the app's own temp folder, and returns the copy's path.
 *
 * A program started from a folder labelled « low integrity » runs at low integrity — and the release
 * folder can carry that label (a sandboxed tool working in the repository sets it on the whole tree).
 * Run from there, the installer cannot write to Programs and the app it restarts cannot start at all
 * (Chromium's sandbox refuses a low-integrity browser process: 0x80000003). A copy made here takes
 * the label of its new folder. It also frees the release folder: the next `pnpm release` can
 * overwrite a file that is no longer open.
 */
export function stageInstaller(installer: string, tempDir: string): string {
  const dir = join(tempDir, "jarod-one-update");
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, basename(installer));
  copyFileSync(installer, staged);
  return staged;
}

export function createUpdateHandlers(ctx: HandlerContext) {
  const updates = (): UpdateService => {
    const u = ctx.kernel().updates;
    if (!u) throw new Error("[oneai] mises à jour indisponibles (plugin updates désactivé)");
    return u;
  };
  const fail = (e: unknown) => ctx.shell.send("update-error", (e as Error)?.message ?? String(e));
  return {
    "check-for-updates": async (): Promise<string | null> => {
      try {
        return (await updates().check())?.version ?? null;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    "download-update": async (): Promise<boolean> => {
      try {
        await updates().download((percent) => ctx.shell.send("update-download-progress", { percent: Math.round(percent) }));
        ctx.shell.send("update-downloaded");
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    // Synchrone tant qu'il n'y a rien à vérifier (« vérifiez d'abord » reste une exception franche) ; le lancement d'un installeur
    // LOCAL, lui, attend la vérification de la COPIE (AV2-003) : taille et sha512 du manifeste, sinon rien ne s'exécute.
    "install-update": (): void | Promise<void> => {
      const r = updates().install();
      if (r.source !== "local") return;
      const staged = stageInstaller(r.installer, ctx.shell.tempDir());
      return verifyInstaller(staged, { sha512: r.sha512, size: r.size }).then(
        () => {
          if (ctx.shell.isInstalled()) ctx.shell.installSilently(staged);
          else void ctx.shell.openPath(staged);
        },
        (e: unknown) => {
          rmSync(staged, { force: true }); // un installeur refusé ne reste pas dans le dossier temporaire
          fail(e);
        },
      );
    },
    "get-auto-upgrade-enabled": (): boolean => ctx.kernel().agent.settings.get("updates").autoCheck,
    "set-auto-upgrade-enabled": (enabled: unknown, profile?: unknown): boolean => {
      assertProfile(ctx, profile);
      if (typeof enabled !== "boolean") throw new Error("[oneai] set-auto-upgrade-enabled : booléen attendu");
      const s = ctx.kernel().agent.settings;
      s.set("updates", { ...s.get("updates"), autoCheck: enabled });
      return true;
    },
  };
}

/** Événements kernel → fenêtre (`update-available` : `{ version, releaseNotes }` comme SANK-UI). */
export function bindUpdateEvents(
  app: { on(name: string, cb: (...args: never[]) => void): () => void },
  send: (channel: string, ...args: unknown[]) => void,
): () => void {
  const offs = [
    app.on("update:available", (c: { version: string; releaseNotes?: string | null }) =>
      send("update-available", { version: c.version, releaseNotes: c.releaseNotes ?? "" }),
    ),
    app.on("update:error", (e: { message: string }) => send("update-error", e.message)),
  ];
  return () => {
    for (const off of offs) off();
  };
}
