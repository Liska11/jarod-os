/**
 * Q13-2/3 — sauvegarde et import (Réglages › Données ; SANK-UI `useSettingsData.ts:705-736`, `register.ts`
 * `run-hermes-backup` / `run-hermes-import`, rév. 3aaadb0, MIT © github.com/fathah). Décisions utilisateur 2026-09-28 :
 * - `run-hermes-backup` = VRAIE sauvegarde du profil complet (`profile-backup.ts` : base chiffrée vérifiée, fichiers
 *   du profil, manifeste + SHA-256, relecture), destination par boîte NATIVE uniquement, sous la garde Q12 ;
 * - `run-hermes-import(archivePath)` = le chemin du renderer n'est PAS cru : le fichier est choisi dans la boîte
 *   native du main (garde Q12 : jamais un chemin protégé), puis `PortabilityService` (fusion, ne supprime rien)
 *   après confirmation native (souvenirs ajoutés, clés de réglages écrites, personas).
 * - Q14 : le `manifest.json` d'une SAUVEGARDE COMPLÈTE choisi au même endroit = restauration dans un profil NEUF
 *   (`profile-restore.ts`), après confirmation native ; le profil servi n'est jamais touché ni remplacé.
 * Écarts : l'import lit le format natif de Jarod — un dossier de portabilité (`manifest.json`, `PortabilityService.
 * export`) ; archives `.zip` / `.tar.gz` d'Hermes non lues (différé en P4, décision utilisateur Q14 : le zip de
 * plugin-rag n'est pas une dépendance du desktop, l'ajouter = `pnpm install` + série vocale) ; le réglage
 * `workspace` d'un paquet est ignoré (Q12 : une racine ne vient jamais du contenu d'un fichier).
 */
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import { type FileGate, GateDenied } from "../file-gate.js";
import { BACKUP_FORMAT, type BackupManifest, createProfileBackup } from "../profile-backup.js";
import { restoredProfileName, restoreProfileBackup } from "../profile-restore.js";
import { assertProfile, type HandlerContext } from "./context.js";

type Result = { success: boolean; path?: string; error?: string };

/** Réglages qu'un paquet importé n'écrit jamais : une racine de la garde fichiers ne vient pas d'un fichier (Q12). */
export function createBackupHandlers(ctx: HandlerContext, gate: FileGate) {
  const k = () => ctx.kernel();
  const profileDir = () => new ProfileManager(k().dataRoot).dirFor(k().profile);

  /** Q14 : sauvegarde complète → profil NEUF, après confirmation native ; le profil servi n'est pas modifié. */
  const restore = async (source: string, manifest: BackupManifest): Promise<Result> => {
    const keys = k().storage;
    if (!keys || !ctx.shell.confirm) return { success: false, error: "Restauration indisponible." };
    let name: string;
    try {
      name = restoredProfileName(new ProfileManager(k().dataRoot), String(manifest.profile));
    } catch (e) {
      return { success: false, error: `Restauration refusée : ${(e as Error).message}` };
    }
    const mo = (manifest.totals?.bytes ?? 0) / 1024 / 1024;
    const ok = await ctx.shell.confirm(
      `Restaurer la sauvegarde du profil « ${manifest.profile} » dans un NOUVEAU profil « ${name} » ?`,
      [
        `Source : ${source}`,
        `Créée le ${manifest.createdAt} (Jarod ${manifest.appVersion}, schéma v${manifest.database?.schemaVersion})`,
        `Fichiers : ${manifest.totals?.files ?? 0} (${mo.toFixed(1)} Mo), vérifiés contre le manifeste avant et après copie.`,
        manifest.database?.encrypted
          ? `Clé : celle du profil « ${manifest.profile} » de cette machine (même compte Windows) — la sauvegarde ne la contient pas ; sans elle, rien n'est créé.`
          : "Base en clair.",
        `Le profil servi « ${k().profile} » n'est pas modifié ; le nouveau profil s'ouvre depuis Profils.`,
      ].join("\n"),
      "Restaurer",
    );
    if (!ok) return { success: false, error: "Restauration annulée." };
    try {
      const r = restoreProfileBackup({ backupDir: source, dataRoot: k().dataRoot, activeProfile: k().profile, keys });
      gate.log({ op: "write", channel: "run-hermes-import", path: r.dir, size: r.manifest.totals.bytes });
      return { success: true, path: r.dir };
    } catch (e) {
      return { success: false, error: `Restauration refusée : ${(e as Error).message}` };
    }
  };

  return {
    "run-hermes-backup": async (profile?: unknown): Promise<Result> => {
      assertProfile(ctx, profile);
      if (!ctx.shell.pickDestinationFolder) return { success: false, error: "Sauvegarde indisponible : pas de boîte de dialogue native." };
      const chosen = await ctx.shell.pickDestinationFolder("Jarod-One — dossier de destination de la sauvegarde");
      if (!chosen) return { success: false, error: "Sauvegarde annulée." };
      let parent: string;
      try {
        parent = gate.userChosen("run-hermes-backup", chosen, true);
        if (!statSync(parent).isDirectory()) throw new GateDenied("pas un dossier");
      } catch (e) {
        return { success: false, error: e instanceof GateDenied ? e.message : String(e) };
      }
      const db = k().agent.db as unknown as { encrypted: boolean; snapshotTo(path: string): { userVersion: number } };
      try {
        const { dir, manifest } = createProfileBackup({
          profileDir: profileDir(),
          profile: k().profile,
          appVersion: ctx.shell.appVersion(),
          destParent: parent,
          encrypted: db.encrypted,
          snapshot: (target) => db.snapshotTo(target),
        });
        gate.log({ op: "write", channel: "run-hermes-backup", path: dir, size: manifest.totals.bytes });
        return { success: true, path: dir };
      } catch (e) {
        return { success: false, error: `Sauvegarde échouée : ${(e as Error).message}` };
      }
    },

    "run-hermes-import": async (archivePath: unknown, profile?: unknown): Promise<Result> => {
      assertProfile(ctx, profile);
      const portability = k().portability;
      if (!portability || !ctx.shell.pickFile || !ctx.shell.confirm) return { success: false, error: "Import indisponible." };
      // Le chemin du renderer n'est pas cru : la boîte native du main désigne le fichier.
      void archivePath;
      const chosen = await ctx.shell.pickFile({
        title: "Jarod-One — importer un paquet de portabilité (manifest.json)",
        filters: [{ name: "Paquet de portabilité Jarod", extensions: ["json"] }],
      });
      if (!chosen) return { success: false, error: "Import annulé." };
      let manifestFile: string;
      try {
        manifestFile = gate.userChosen("run-hermes-import", chosen, true);
      } catch (e) {
        return { success: false, error: e instanceof GateDenied ? e.message : String(e) };
      }
      if (basename(manifestFile).toLowerCase() !== "manifest.json") {
        return { success: false, error: "Paquet non reconnu : choisissez le manifest.json d'un paquet de portabilité Jarod (archives Hermes .zip/.tar.gz non lues)." };
      }
      const source = dirname(manifestFile);
      let manifest: { format?: unknown; version?: unknown } & Partial<BackupManifest>;
      try {
        manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as typeof manifest;
      } catch {
        return { success: false, error: "manifest.json illisible." };
      }
      if (manifest.format === BACKUP_FORMAT) return restore(source, manifest as BackupManifest);
      // Copie de travail : le paquet de l'utilisateur n'est jamais modifié. Les réglages sont filtrés par la liste
      // BLANCHE du service (Q19-5) : `workspace` (Q12), le garde, l'exécution et le réseau ne s'importent pas.
      const work = mkdtempSync(join(ctx.shell.tempDir(), "jarod-import-"));
      try {
        copyFileSync(manifestFile, join(work, "manifest.json"));
        for (const f of ["memory.json", "settings.json"]) if (existsSync(join(source, f))) copyFileSync(join(source, f), join(work, f));
        if (existsSync(join(source, "personas"))) cpSync(join(source, "personas"), join(work, "personas"), { recursive: true });
        const plan = portability.inspect(work);
        gate.log({ op: "read", channel: "run-hermes-import", path: source, size: statSync(manifestFile).size });
        const ok = await ctx.shell.confirm(
          `Importer le paquet du profil « ${plan.manifest.profile} » dans « ${k().profile} » ?`,
          [
            `Source : ${source}`,
            `Souvenirs ajoutés : ${plan.memory.added} (déjà présents : ${plan.memory.alreadyThere})`,
            `Réglages écrits : ${plan.settings.length ? plan.settings.join(", ") : "aucun"}`,
            ...(plan.ignored.length ? [`Réglages ignorés (hors liste blanche : le garde, l'exécution et le réseau ne s'importent jamais) : ${plan.ignored.join(", ")}`] : []),
            ...(plan.approval.length ? [`À approuver séparément (leurs valeurs vous sont montrées ensuite) : ${plan.approval.map((a) => a.key).join(", ")}`] : []),
            "Personas : ajoutées seulement si absentes. Rien n'est supprimé.",
          ].join("\n"),
        );
        if (!ok) return { success: false, error: "Import annulé." };
        // Q19-5 : ce qui change ce que Jarod LANCE (serveurs MCP) ne passe qu'après une seconde confirmation qui en montre le contenu.
        const approve: string[] = [];
        for (const req of plan.approval) {
          const yes = await ctx.shell.confirm(
            `Le paquet demande d'écrire « ${req.key} »`,
            [...req.lines, "", "Ces serveurs seront lancés au prochain démarrage de Jarod, avec vos droits. N'acceptez que ce que vous reconnaissez ; refuser importe le reste du paquet sans eux."].join("\n"),
            "Approuver",
          );
          if (yes) approve.push(req.key);
        }
        const r = portability.apply(work, { approve });
        gate.log({ op: "write", channel: "run-hermes-import", path: profileDir(), size: r.memory.added + r.settings + r.personas });
        return { success: true };
      } catch (e) {
        return { success: false, error: `Import échoué : ${(e as Error).message}` };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
