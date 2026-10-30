// Plancher de sécurité (30/10), INDÉPENDANT du profil d'accès : quel que soit le profil (même « Plein » avec « Tout autoriser » et une règle
// « sans accord »), ces actions demandent l'accord natif. Il ne regarde que l'action et le tour ; aucune détection de texte, donc rien à contourner par
// reformulation. Derrière le réglage `safetyFloor` (allumé par défaut ; l'éteindre demande une confirmation native).
//
// Ce qu'il impose :
//  1. écraser un fichier EXISTANT (write_file, edit_file) — avec une sauvegarde automatique du fichier AVANT, même si l'accord est donné ;
//  2. supprimer ou déplacer des fichiers (system_files : trash, move) ;
//  3. une commande shell qui supprime, déplace ou écrase (heuristique sur le nom du programme : un programme qui supprime sans le dire, comme
//     `node -e "unlinkSync(...)"`, n'est PAS reconnu — la parade est le point 5 ; voir SECURITY.md) ;
//  4. envoyer à un tiers : requête HTTP qui modifie (POST, PUT, PATCH, DELETE), tâche planifiée (elle peut écrire vers des messageries) ;
//  5. TOUTE action sensible (`dangerous`) après la lecture, dans le même tour, d'un contenu extérieur (serveur MCP, web, navigateur) : une action
//     qui suit un résultat externe n'est jamais lancée sans que la personne la voie.
// « Activer Gemini » n'est pas un outil : c'est un réglage, et les réglages qui envoient hors de la machine passent par une confirmation native
// (jarod-settings.ts, `confirm`) ; l'agent n'a aucun outil qui écrit les réglages.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface FloorInput {
  tool: string;
  args: Record<string, unknown>;
  dangerous: boolean;
  /** Le premier outil de contenu extérieur lu pendant ce tour (MCP, web, navigateur), ou null. */
  externalFrom: string | null;
  /** Le chemin RÉEL d'un fichier existant que l'outil va écraser, ou null (fichier absent, ou chemin refusé par l'outil). */
  existingTarget: string | null;
}

/** Les programmes qui suppriment, déplacent ou écrasent (cmd, PowerShell, POSIX). Reconnus comme MOT, pas comme morceau de nom. */
const DESTRUCTIVE_PROGRAMS = [
  "rm", "rmdir", "rd", "del", "erase", "unlink", "shred", "truncate", "dd", "format", "mkfs", "diskpart",
  "mv", "move", "ren", "rename", "robocopy", "xcopy", "cp", "copy",
  "remove-item", "ri", "move-item", "mi", "copy-item", "rename-item", "rni", "set-content", "clear-content", "out-file", "add-content",
];
// Un programme n'est reconnu qu'EN POSITION DE COMMANDE : en début de ligne, après `;` `&` `|` `(`, après `do` `then` `else` `sudo` `call` `start` `xargs`,
// après `cmd /c`, ou en tête d'un `-Command "…"` PowerShell — pas comme argument (`grep format fichier`).
const DESTRUCTIVE = new RegExp(
  String.raw`(?:^|[;&|(\n]|\b(?:do|then|else|sudo|call|start|xargs|exec)\s|/c\s+["']?|-command\s+["']?)\s*(?:[^\s;&|()"']*[\\/])?(?:${DESTRUCTIVE_PROGRAMS.join("|")})(?=$|[\s;&|)"'])`,
  "i",
);
/** Une redirection qui écrase (`>` ou `1>`, pas `>>`, pas `2>&1`, pas `>nul`). */
const OVERWRITE_REDIRECT = /(?:^|[^>0-9&])1?>(?!>|&)\s*(?!nul\b|\/dev\/null\b)[^\s&|]/i;

export function shellIsDestructive(command: string): boolean {
  return DESTRUCTIVE.test(command) || OVERWRITE_REDIRECT.test(command);
}

/** Pourquoi cet appel doit demander l'accord même sous « Plein », ou null. */
export function floorReason(i: FloorInput): string | null {
  if ((i.tool === "write_file" || i.tool === "edit_file") && i.existingTarget) {
    return `écrase un fichier existant (${i.existingTarget}) — une copie sera gardée avant`;
  }
  if (i.tool === "system_files") {
    const ops = Array.isArray(i.args.operations) ? (i.args.operations as { op?: unknown }[]).map((o) => o.op) : [i.args.action];
    if (ops.some((o) => o === "trash" || o === "move")) return "supprime ou déplace des fichiers";
  }
  if (i.tool === "run_shell" || i.tool === "android_shell") {
    const command = typeof i.args.command === "string" ? i.args.command : "";
    if (shellIsDestructive(command)) return "commande qui supprime, déplace ou écrase";
  }
  if (i.tool === "http_request") {
    const method = String(i.args.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return `envoie des données à un tiers (${method})`;
  }
  if (i.tool === "cronjob" && i.args.action !== "pause" && i.args.action !== "delete") return "crée une tâche qui agira plus tard, éventuellement vers une messagerie";
  if (i.dangerous && i.externalFrom) return `action sensible demandée après la lecture d'un contenu extérieur (${i.externalFrom})`;
  return null;
}

const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

/**
 * Garde une copie du fichier AVANT qu'il soit écrasé : `<dossier>/<date>/<nom>`. Rend le chemin de la copie, ou null si le fichier est trop gros
 * (la demande d'accord le dit alors telle quelle) ou illisible. Ne lève jamais : une sauvegarde manquée ne doit pas cacher l'action à la personne.
 */
export function backupBeforeOverwrite(file: string, dir: string, now: Date = new Date()): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BACKUP_BYTES) return null;
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const target = join(dir, stamp);
    mkdirSync(target, { recursive: true });
    let copy = join(target, basename(file));
    for (let n = 2; existsSync(copy); n++) copy = join(target, `${n}-${basename(file)}`);
    copyFileSync(file, copy);
    pruneBackups(dir, BACKUP_KEEP_LAST, BACKUP_KEEP_DAYS, now);
    return copy;
  } catch {
    return null;
  }
}

/** Rétention des copies : on garde les 20 plus récentes ET tout ce qui a moins de 7 jours ; le reste (plus ancien que 7 jours ET au-delà des 20 dernières) est retiré. */
export const BACKUP_KEEP_LAST = 20;
export const BACKUP_KEEP_DAYS = 7;

export function pruneBackups(dir: string, keepLast = BACKUP_KEEP_LAST, keepDays = BACKUP_KEEP_DAYS, now: Date = new Date()): string[] {
  const removed: string[] = [];
  try {
    const copies: { path: string; mtime: number; folder: string }[] = [];
    for (const d of readdirSync(dir)) {
      const folder = join(dir, d);
      if (!statSync(folder).isDirectory()) continue;
      for (const f of readdirSync(folder)) {
        const path = join(folder, f);
        const st = statSync(path);
        if (st.isFile()) copies.push({ path, mtime: st.mtimeMs, folder });
      }
    }
    copies.sort((a, b) => b.mtime - a.mtime);
    const limit = now.getTime() - keepDays * 86_400_000;
    for (const c of copies.slice(keepLast)) {
      if (c.mtime >= limit) continue;
      rmSync(c.path, { force: true });
      removed.push(c.path);
    }
    for (const folder of new Set(copies.map((c) => c.folder))) if (readdirSync(folder).length === 0) rmdirSync(folder);
  } catch {
    // la rétention ne doit jamais empêcher une sauvegarde ni cacher l'action
  }
  return removed;
}
