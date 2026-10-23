/**
 * V-10 — les preuves du shell et du réseau (COCKPIT-LOT2, « Preuves d'exécution ») : ce que l'outil a OBSERVÉ lui-même, jamais ce que la sortie
 * prétend. `run`, qui voit le code de sortie rendu par le système ou la réponse HTTP, inscrit ses constats ici, sous l'objet des arguments de
 * l'appel ; `verify` les relit. Une commande qui imprime « code de sortie : 0 » ou une page qui écrit « HTTP 200 » ne fabriquent donc aucune
 * preuve. Un appel sans constat (outil interrompu avant) est « impossible à vérifier », jamais « constaté ».
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Proof } from "./registry.js";

export interface ShellFacts {
  kind: "shell";
  /** Le code rendu par le système ; null si le processus a été arrêté sans code. */
  code: number | null;
  stopped: "timeout" | "abort" | null;
  changes: TreeChanges | null;
}

export interface HttpFacts {
  kind: "http";
  status: number;
  requested: string;
  /** L'adresse de la réponse, après les redirections suivies. */
  final: string;
  bytes: number;
  capped: boolean;
  type: string;
  /** Une redirection NON suivie (requête qui porte un secret) : où elle menait. */
  location?: string;
}

const facts = new WeakMap<object, ShellFacts | HttpFacts>();

export function recordFacts(args: object, f: ShellFacts | HttpFacts): void {
  facts.set(args, f);
}

export function factsOf(args: object): ShellFacts | HttpFacts | undefined {
  return facts.get(args);
}

/** Les dossiers que l'instantané ne parcourt pas : volumineux, et jamais ce qu'une commande de l'agent vise à montrer. */
const SKIPPED = new Set(["node_modules", ".git", ".venv", "__pycache__"]);

export interface TreeSnapshot {
  /** chemin relatif → « taille:mtime » */
  files: Map<string, string>;
  /** Faux si l'instantané a été coupé (trop de fichiers, ou trop long) : la comparaison ne dit alors rien. */
  complete: boolean;
}

/** Instantané borné d'un dossier : taille et date de chaque fichier, au plus `maxEntries` fichiers et `budgetMs` millisecondes. */
export async function snapshotTree(root: string, o: { maxEntries?: number; budgetMs?: number } = {}): Promise<TreeSnapshot> {
  const maxEntries = o.maxEntries ?? 20_000;
  const deadline = Date.now() + (o.budgetMs ?? 1_500);
  const files = new Map<string, string>();
  let complete = true;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (!complete) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.size >= maxEntries || Date.now() > deadline) {
        complete = false;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED.has(e.name)) await walk(join(dir, e.name), r);
      } else if (e.isFile()) {
        try {
          const s = await stat(join(dir, e.name));
          files.set(r, `${s.size}:${s.mtimeMs}`);
        } catch {
          /* disparu entre la liste et la lecture : la comparaison suivante le dira */
        }
      }
    }
  };
  await walk(root, "");
  return { files, complete };
}

export interface TreeChanges {
  created: string[];
  modified: string[];
  deleted: string[];
  complete: boolean;
}

export function compareTrees(before: TreeSnapshot, after: TreeSnapshot): TreeChanges {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, sig] of after.files) {
    const old = before.files.get(path);
    if (old === undefined) created.push(path);
    else if (old !== sig) modified.push(path);
  }
  for (const path of before.files.keys()) if (!after.files.has(path)) deleted.push(path);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort(), complete: before.complete && after.complete };
}

const names = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(", ")}, …` : paths.join(", "));

export function describeChanges(c: TreeChanges | null): string {
  if (!c) return "dossier de travail non observé";
  if (!c.complete) return "changements du dossier de travail non mesurés (trop de fichiers ou trop long à parcourir)";
  const parts = [
    c.created.length ? `${c.created.length} créé${c.created.length > 1 ? "s" : ""} (${names(c.created)})` : "",
    c.modified.length ? `${c.modified.length} modifié${c.modified.length > 1 ? "s" : ""} (${names(c.modified)})` : "",
    c.deleted.length ? `${c.deleted.length} supprimé${c.deleted.length > 1 ? "s" : ""} (${names(c.deleted)})` : "",
  ].filter(Boolean);
  return parts.length ? `dans le dossier de travail : ${parts.join(", ")}` : "aucun fichier changé dans le dossier de travail";
}

/**
 * La preuve d'une commande : son code de sortie, relevé par le système, et ce qui a changé dans le dossier de travail. Un code non nul est un
 * échec dit par la commande elle-même ; une commande arrêtée (délai, interruption) n'a pas abouti.
 */
export function shellProof(f: ShellFacts): Proof {
  const changes = describeChanges(f.changes);
  if (f.stopped === "timeout") return { status: "failed", evidence: `arrêtée : délai dépassé ; ${changes}` };
  if (f.stopped === "abort") return { status: "failed", evidence: `interrompue ; ${changes}` };
  if (f.code === null) return { status: "failed", evidence: `arrêtée sans code de sortie ; ${changes}` };
  if (f.code !== 0) return { status: "failed", evidence: `code de sortie ${f.code} (relevé par le système) ; ${changes}` };
  return { status: "verified", evidence: `code de sortie 0 (relevé par le système) ; ${changes}` };
}

const host = (href: string) => {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
};

/**
 * La preuve d'une requête : la réponse reçue (statut, hôte qui l'a rendue, taille, type). 2xx = constaté ; 4xx/5xx = échec ; une redirection non
 * suivie (requête qui porte un secret) = impossible à vérifier, avec sa destination.
 */
export function httpProof(f: HttpFacts): Proof {
  const from = host(f.final);
  const moved = from !== host(f.requested) ? `, après redirection depuis ${host(f.requested)}` : "";
  const size = `${f.bytes} octets${f.capped ? " (tronqué)" : ""}${f.type ? `, ${f.type.split(";")[0]}` : ""}`;
  if (f.status >= 200 && f.status < 300) return { status: "verified", evidence: `HTTP ${f.status} reçu de ${from}${moved} : ${size}` };
  if (f.status >= 300 && f.status < 400) return { status: "unverifiable", evidence: `HTTP ${f.status} de ${from} : redirection${f.location ? ` vers ${host(f.location)}` : ""} non suivie` };
  return { status: "failed", evidence: `HTTP ${f.status} reçu de ${from}${moved}` };
}
