// Outils système, phase 3 (modification et destruction) : `system_files_plan` (essai à blanc, lecture), `system_files` (mkdir, move, copy, trash, lot)
// et `system_kill_process`. Portés de Herald OS (MIT, licenses/HERALD-OS.md) vers TypeScript. Windows seulement.
//
// Politique : `dangerous`, donc un accord à chaque appel ; une seule demande par lot (un lot de 50 déplacements se confirme une fois). Ce que la
// politique interdit est refusé par `precheck` AVANT toute demande. La demande dit ce qui va se passer (le plan, les processus visés), pas le mode
// d'emploi de l'outil. Rien n'est jamais supprimé pour de bon : `trash` passe par la corbeille avec des contrôles préalables (scripts-act.ts, TRASH),
// `move` et `copy` n'écrasent rien. Le plan montré par l'essai à blanc EST le plan appliqué (files.ts).
import { cp, mkdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ToolDef } from "../registry.js";
import { protectedRoots } from "./disk.js";
import { forbiddenReason, type FileOp, operationTargets, planFiles, type Plan } from "./files.js";
import { parseListeners } from "./parse.js";
import { prepared } from "./prepared.js";
import { protectedReason, stopErrorMessage } from "./proc.js";
import { asList, powershellExe, type PsRunner, realPsRunner } from "./ps.js";
import * as A from "./scripts-act.js";
import * as S from "./scripts.js";
import type { SystemToolDeps } from "./tools.js";
import type { UndoStack } from "./undo.js";

export interface SystemDestroyDeps extends SystemToolDeps {
  /** Des pid qu'aucun outil n'arrêtera, en plus du processus de Jarod et de son parent. */
  protectedPids?: readonly number[];
  /** Q6 : la pile d'annulation où un lot réussi (ou en partie) dépose son inverse. */
  undo?: UndoStack;
  /** Q5 : attentes successives avant de constater qu'un processus s'est arrêté (défaut : 0,5 s, 1 s, 1,5 s, 2 s). */
  verifyDelaysMs?: readonly number[];
}

const json = (v: unknown) => JSON.stringify(v);
const exists = (p: string) => stat(p).then(() => true, () => false);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const FILES_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["mkdir", "move", "copy", "trash", "batch"] },
    path: { type: "string", description: "Chemin absolu (ou ~) pour mkdir, move, copy, trash." },
    to: { type: "string", description: "Pour move et copy : un dossier existant (la source y entre sous son nom) ou le nouveau chemin complet." },
    paths: { type: "array", items: { type: "string" }, description: "Pour trash : plusieurs éléments." },
    operations: {
      type: "array",
      description: "Pour batch : les opérations, dans l'ordre (200 au plus). Une opération voit ce que les précédentes ont fait.",
      items: {
        type: "object",
        properties: { op: { type: "string", enum: ["mkdir", "move", "copy", "trash"] }, path: { type: "string" }, to: { type: "string" } },
        required: ["op", "path"],
      },
    },
  },
  required: ["action"],
};

export function systemDestroyTools(deps: SystemDestroyDeps = {}): ToolDef[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  let ps: PsRunner | undefined = deps.ps;
  const runner = (): PsRunner => (ps ??= realPsRunner());
  const hasPs = () => deps.ps !== undefined || powershellExe(env) !== null;
  const roots = () => protectedRoots(env, home);
  const base = { source: "builtin" as const, audited: true, available: hasPs };

  const filesPlan: ToolDef = {
    ...base,
    name: "system_files_plan",
    description: "Essai à blanc de system_files, sans rien modifier : rend le plan exact (destinations résolues) et les problèmes qui l'empêcheraient (élément absent, destination existante, emplacement protégé). À appeler avant system_files pour un lot ou une organisation de fichiers. Mêmes arguments que system_files.",
    parameters: FILES_PARAMETERS,
    async run(args) {
      const plan = await planFiles(args, roots(), home);
      return json({ tier: plan.tier, plan: plan.descriptions, problems: plan.problems, note: plan.problems.length ? "Corriger les problèmes avant d'appliquer." : "Rien n'a été modifié. Appeler system_files avec les mêmes arguments pour appliquer ; l'utilisateur sera invité à confirmer." });
    },
  };

  /** Déplace sans jamais écraser ; d'un disque à l'autre, copie puis retire la source seulement si la copie a réussi. */
  async function moveNoClobber(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    try {
      await rename(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await rm(from, { recursive: true });
    }
  }

  /**
   * Q6 : dépose l'inverse des opérations faites (dans l'ordre inverse). Déplacement → remise en place ; dossier créé → retiré s'il est resté vide ;
   * copie → la copie part à la corbeille. Une mise à la corbeille ne s'annule pas ici (la corbeille de Windows la rend).
   */
  function recordUndo(ops: readonly FileOp[]): void {
    const reversible = ops.filter((o) => o.op !== "trash");
    if (!deps.undo || reversible.length === 0) return;
    const one = reversible[0]!;
    const label = reversible.length === 1 ? (one.op === "move" ? `déplacer ${one.path} → ${one.to}` : one.op === "copy" ? `copier ${one.path} → ${one.to}` : `créer le dossier ${one.path}`) : `${reversible.length} opérations sur des fichiers`;
    deps.undo.push(label, async () => {
      const undone: string[] = [];
      for (const o of [...reversible].reverse()) {
        const at = (what: string) => `${what}${undone.length ? `. Déjà défait : ${undone.join(" ; ")}` : ""}`;
        for (const p of [o.path, ...(o.to ? [o.to] : [])]) {
          const why = await forbiddenReason(p, roots());
          if (why) throw new Error(at(why));
        }
        if (o.op === "move") {
          if (await exists(o.path)) throw new Error(at(`${o.path} existe de nouveau : rien n'est écrasé, remise en place impossible`));
          await moveNoClobber(o.to!, o.path);
          undone.push(`${o.to} → ${o.path}`);
        } else if (o.op === "mkdir") {
          await rmdir(o.path).catch((e: NodeJS.ErrnoException) => {
            throw new Error(at(e.code === "ENOTEMPTY" ? `${o.path} n'est plus vide : il reste en place` : e.message));
          });
          undone.push(`dossier ${o.path} retiré`);
        } else {
          await runner().json(A.TRASH, { paths: [o.to!] }, { timeoutMs: 120_000 });
          undone.push(`copie ${o.to} mise à la corbeille`);
        }
      }
      return `Fait : ${undone.join(" ; ")}.`;
    });
  }

  /** Applique un plan déjà sans problème. Séquentiel ; s'arrête à la première erreur en disant ce qui a déjà été fait. */
  async function apply(plan: Plan, signal: AbortSignal | undefined, doneOps: FileOp[] = []): Promise<string[]> {
    const done: string[] = [];
    const fail = (e: unknown): never => {
      recordUndo(doneOps);
      throw new Error(`${(e as Error).message}${done.length ? `. Déjà fait : ${done.join(" ; ")}` : ". Rien n'a été modifié."}`);
    };
    for (let i = 0; i < plan.ops.length; i++) {
      if (signal?.aborted) fail(new Error("Interrompu"));
      const o: FileOp = plan.ops[i]!;
      try {
        // Les emplacements protégés sont revérifiés à l'instant d'agir : un lien a pu changer depuis la préparation.
        for (const p of [o.path, ...(o.to ? [o.to] : [])]) {
          const why = await forbiddenReason(p, roots());
          if (why) throw new Error(why);
        }
        if (o.op === "mkdir") {
          // Un dossier qui existait déjà n'est pas « créé » : l'annulation ne doit pas le retirer.
          const fresh = !(await exists(o.path));
          await mkdir(o.path, { recursive: true });
          done.push(plan.descriptions[i]!);
          if (fresh) doneOps.push(o);
        } else if (o.op === "move") {
          await moveNoClobber(o.path, o.to!);
          done.push(plan.descriptions[i]!);
          doneOps.push(o);
        } else if (o.op === "copy") {
          await mkdir(dirname(o.to!), { recursive: true });
          await cp(o.path, o.to!, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          done.push(plan.descriptions[i]!);
          doneOps.push(o);
        } else {
          // Les éléments à la corbeille qui se suivent partent en un seul appel PowerShell.
          let j = i;
          while (j + 1 < plan.ops.length && plan.ops[j + 1]!.op === "trash") j++;
          const group = plan.ops.slice(i, j + 1).map((x) => x.path);
          const res = (await runner().json(A.TRASH, { paths: group }, { timeoutMs: 120_000, signal })) as { trashed?: unknown; errors?: unknown } | null;
          // `ConvertTo-Json` écrit une chaîne seule là où il y a un seul élément.
          const strs = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String);
          const trashed = new Set(strs(res?.trashed).map((p) => p.toLowerCase()));
          const errors = strs(res?.errors);
          for (let k = i; k <= j; k++)
            if (trashed.has(plan.ops[k]!.path.toLowerCase())) {
              done.push(plan.descriptions[k]!);
              doneOps.push(plan.ops[k]!);
            }
          if (errors.length) throw new Error(`Corbeille : ${errors.join(" ; ")}`);
          i = j;
        }
      } catch (e) {
        fail(e);
      }
    }
    recordUndo(doneOps);
    return done;
  }

  /** Q5 : ce que chaque appel de `system_files` a réellement fait, pour la preuve (clé : l'objet des arguments, le même pour `run` et `verify`). */
  const performed = new WeakMap<object, FileOp[]>();

  const files = prepared(
    {
      ...base,
      name: "system_files",
      dangerous: true,
      // Q5 : la preuve relit le disque. Déplacé : la source a disparu et la destination existe ; copié ou créé : la cible existe ; à la corbeille : disparu.
      async verify(args) {
        const ops = performed.get(args) ?? [];
        if (ops.length === 0) return { status: "unverifiable", evidence: "aucune opération à constater" };
        const wrong: string[] = [];
        for (const o of ops) {
          if (o.op === "move" && ((await exists(o.path)) || !(await exists(o.to!)))) wrong.push(`${o.path} → ${o.to}`);
          else if (o.op === "copy" && !(await exists(o.to!))) wrong.push(`copie ${o.to} absente`);
          else if (o.op === "mkdir" && !(await exists(o.path))) wrong.push(`dossier ${o.path} absent`);
          else if (o.op === "trash" && (await exists(o.path))) wrong.push(`${o.path} encore là`);
        }
        return wrong.length ? { status: "failed", evidence: `relu sur le disque : ${wrong.join(" ; ")}` } : { status: "verified", evidence: `${ops.length} opération(s) constatée(s) sur le disque` };
      },
      // Autonomie configurable : chaque source et chaque destination ; une règle par dossier ne joue que si elle les couvre toutes.
      targetsOf: (args) => operationTargets(args, home),
      description: "Organise des fichiers et dossiers sur cet ordinateur (un accord est demandé, une fois par lot). action=mkdir crée un dossier ; move déplace ou renomme (path → to) ; copy copie (path → to) ; trash met à la corbeille (jamais de suppression définitive) ; batch applique une liste d'opérations dans l'ordre en une seule confirmation. N'écrase jamais rien. Appeler system_files_plan d'abord pour montrer le plan. Les emplacements protégés (clés SSH, magasins d'identifiants, dossier Windows, Program Files) sont refusés, ainsi que tout dossier qui en contient un. Pour écrire le contenu d'un fichier, utiliser write_file.",
      parameters: FILES_PARAMETERS,
    },
    async (args, signal) => {
      const plan = await planFiles(args, roots(), home);
      if (plan.problems.length) throw new Error(`Impossible : ${plan.problems.join(" ; ")}`);
      const n = plan.descriptions.length;
      const summary = n === 1 ? `Fichiers : ${plan.descriptions[0]}` : `Fichiers : ${n} opérations — ${plan.descriptions.slice(0, 5).map((d) => clip(d, 110)).join(" ; ")}${n > 5 ? ` … (+${n - 5})` : ""}`;
      // L'empreinte est le plan ENTIER : un changement d'une opération au-delà des cinq montrées dans la demande refuse aussi l'exécution.
      return {
        summary,
        fingerprint: plan.descriptions.join("\n"),
        go: async () => {
          const ops: FileOp[] = [];
          performed.set(args, ops);
          return json({ applied: await apply(plan, signal, ops) });
        },
      };
    },
  );

  interface Target {
    pid: number;
    name: string;
    path: string;
  }
  const kill = prepared(
    {
      ...base,
      name: "system_kill_process",
      dangerous: true,
      // Q5 : la preuve relit la table des processus, à quelques reprises (une fermeture polie prend un instant, ou attend un « Enregistrer ? »).
      async verify(_args, out, vctx) {
        const stopped = ((JSON.parse(out) as { stopped?: { pid: number; name: string }[] }).stopped ?? []).filter((t) => Number.isInteger(t.pid));
        if (stopped.length === 0) return { status: "failed", evidence: "aucun processus n'a été arrêté" };
        let alive = stopped;
        for (const ms of deps.verifyDelaysMs ?? [500, 1000, 1500, 2000]) {
          if (ms) await new Promise((r) => setTimeout(r, ms));
          if (vctx.signal?.aborted) break;
          const still: typeof stopped = [];
          for (const t of alive) {
            const row = (await runner().json(A.PROC_INFO, { pid: t.pid }, { timeoutMs: 20_000, signal: vctx.signal })) as Record<string, unknown> | null;
            if (row && String(row.name ?? "") === t.name) still.push(t);
          }
          alive = still;
          if (alive.length === 0) break;
        }
        return alive.length === 0
          ? { status: "verified", evidence: `${stopped.map((t) => `${t.name} (pid ${t.pid})`).join(", ")} arrêté(s)` }
          : { status: "failed", evidence: `toujours en cours : ${alive.map((t) => `${t.name} (pid ${t.pid})`).join(", ")} — une fenêtre attend peut-être « Enregistrer ? »` };
      },
      targetOf: (args) => (args.pid != null ? `pid ${String(args.pid)}` : args.port != null ? `port ${String(args.port)}` : typeof args.name === "string" ? args.name : undefined),
      description: "Arrête un processus (un accord est demandé à chaque fois). L'identifier par pid, par le port TCP/UDP sur lequel il écoute (« tue ce qui écoute sur le port 3000 »), ou par nom (un seul processus doit correspondre, sauf all=true). Sans force : demande de fermeture de sa fenêtre principale ; avec force=true : arrêt immédiat, le travail non enregistré est perdu. Refuse les processus du système, l'Explorateur et Jarod lui-même.",
      parameters: {
        type: "object",
        properties: {
          pid: { type: "integer" },
          port: { type: "integer", description: "Arrêter ce qui écoute sur ce port." },
          name: { type: "string", description: "Fragment du nom ou du chemin du programme." },
          all: { type: "boolean", description: "Pour name : arrêter toutes les correspondances au lieu d'en exiger une seule." },
          force: { type: "boolean", description: "Arrêt immédiat plutôt que demande de fermeture." },
        },
      },
    },
    async (args, signal) => {
      const opts = { timeoutMs: 40_000, signal };
      for (const k of ["pid", "port"] as const) if (args[k] !== undefined && args[k] !== null && (typeof args[k] !== "number" || !Number.isInteger(args[k]))) throw new Error(`${k} doit être un entier`);
      for (const k of ["all", "force"] as const) if (args[k] !== undefined && args[k] !== null && typeof args[k] !== "boolean") throw new Error(`${k} doit être vrai ou faux`);
      const force = args.force === true;
      const selectors = ["pid", "port", "name"].filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== "");
      if (selectors.length !== 1) throw new Error("Donner exactement un critère : pid, port ou name");
      let targets: Target[] = [];
      if (selectors[0] === "pid") {
        const pid = args.pid as number;
        const own = [process.pid, process.ppid, ...(deps.protectedPids ?? [])];
        // Les pid 0, 4 et les nôtres sont refusés AVANT toute lecture du système.
        const early = protectedReason({ pid, name: "" }, own);
        if (early) throw new Error(`pid ${pid} : ${early} ; cet outil ne l'arrête pas.`);
        const row = (await runner().json(A.PROC_INFO, { pid }, opts)) as Record<string, unknown> | null;
        if (!row) throw new Error(`Aucun processus avec le pid ${pid}`);
        targets = [{ pid, name: String(row.name ?? ""), path: String(row.path ?? "") }];
      } else if (selectors[0] === "port") {
        const port = args.port as number;
        if (port < 1 || port > 65535) throw new Error("port doit être entre 1 et 65535");
        const rows = parseListeners(await runner().json(S.LISTENERS, { port }, opts), port);
        if (rows.length === 0) throw new Error(`Rien n'écoute sur le port ${port}`);
        targets = rows.map((r) => ({ pid: Number(r.pid), name: String(r.command ?? ""), path: "" }));
      } else {
        const name = String(args.name).trim();
        if (!name) throw new Error("name ne peut pas être vide");
        const data = (await runner().json(S.PROCESSES, { sort: "memory", limit: 200, name }, opts)) as { rows?: unknown } | null;
        const rows = asList(data?.rows).filter((r) => Number(r.pid) !== process.pid);
        if (rows.length === 0) throw new Error(`Aucun processus ne correspond à « ${name} »`);
        if (rows.length > 1 && args.all !== true) {
          throw new Error(`« ${name} » correspond à ${rows.length} processus : ${rows.slice(0, 12).map((r) => `${String(r.name)} (pid ${String(r.pid)})`).join(", ")}${rows.length > 12 ? "…" : ""}. Donner le pid, ou all=true.`);
        }
        targets = rows.map((r) => ({ pid: Number(r.pid), name: String(r.name ?? ""), path: String(r.path ?? "") }));
      }
      const seen = new Set<number>();
      targets = targets.filter((t) => !seen.has(t.pid) && seen.add(t.pid));
      const own = [process.pid, process.ppid, ...(deps.protectedPids ?? [])];
      for (const t of targets) {
        const why = protectedReason(t, own);
        if (why) throw new Error(`${t.name || "pid " + t.pid} (pid ${t.pid}) : ${why} ; cet outil ne l'arrête pas.`);
      }
      const label = targets.map((t) => `${t.name || "?"} (pid ${t.pid})`).join(", ");
      return {
        summary: `${force ? "Arrêter net (travail non enregistré perdu)" : "Demander la fermeture de"} ${label}`,
        // Le pid ET le nom : si le pid est réattribué à un autre programme entre l'accord et l'exécution, l'outil refuse.
        fingerprint: `${force ? "force" : "polite"}|${targets.map((t) => `${t.pid}:${t.name}`).join(",")}`,
        go: async () => {
          const stopped: Target[] = [];
          const errors: { pid: number; name: string; error: string }[] = [];
          for (const t of targets) {
            try {
              // Le nom attendu est revérifié par le script : un pid réattribué entre-temps à un autre programme n'est pas touché.
              await runner().json(force ? A.FORCE_KILL : A.CLOSE_WINDOW, { pid: t.pid, name: t.name }, { timeoutMs: 20_000, signal });
              stopped.push(t);
            } catch (e) {
              const raw = (e as Error).message;
              if (!/NOWINDOW|NOTFOUND|CHANGED|DENIED/.test(raw)) throw e;
              errors.push({ pid: t.pid, name: t.name, error: stopErrorMessage(raw) });
            }
          }
          return json({ mode: force ? "force" : "polite", stopped: stopped.map((t) => ({ pid: t.pid, name: t.name })), errors });
        },
      };
    },
  );

  return [filesPlan, files, kill];
}
