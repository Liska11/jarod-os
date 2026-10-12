/**
 * Discover (Q11 = A) et installation/retrait de skills. Sources SANK-UI : `ipc/register.ts` (`registry-fetch`,
 * `registry-fetch-models`, `registry-detail`, `registry-install`, `install-skill`, `uninstall-skill`),
 * `src/main/registry.ts:510-564` (`installRegistryItem` : skill → dossier du profil, MCP → serveur ajouté, agent →
 * profil + SOUL.md depuis son AGENT.md, workflow → dossier), `skills.ts` (`hermes skills install/uninstall`) ;
 * usages `Discover.tsx:120-330`, `Skills.tsx:80-105`, `RegistryBrowserModal.tsx:64` — rév. 3aaadb0, MIT © fathah.
 *
 * Conditions Q11 (non négociables, DECISIONS 2026-09-28) tenues ici :
 * (a) lecture par le main seul (`RegistryClient`) ; (b) confirmation EXPLICITE par paquet dans une boîte de
 * dialogue NATIVE du main (`DesktopShell.confirmInstall` : nom, source épinglée, licence, SHA-256, permissions) —
 * un renderer ne peut ni la remplir ni la valider ; sans elle, refus ; (c) paquet sans permissions déclarées ou
 * contenant du code → refusé avant la confirmation (`registry.ts` › `refusal`) ; skills passées en plus au garde
 * `skill-guard` (verdict « dangerous » = refus) ; (d) provenance consignée en JSONL dans le dossier du profil
 * servi (`registry/provenance.jsonl` : dépôt, révision, dossier, SHA-256 du paquet et de chaque fichier, empreinte
 * git, licence, permissions, cible).
 *
 * Autres écarts : skill installée dans `<skills>/<id>/` (le registre de skills de Jarod lit un niveau — la
 * catégorie Hermes n'est pas reprise) ; aucun écrasement (dossier, serveur MCP ou profil existant = refus) ;
 * `install-skill` (skills livrées avec le dépôt Hermes) : Jarod n'en a pas (`list-bundled-skills` = []) → refus ;
 * `uninstall-skill` = skill ARCHIVÉE (`SkillRegistry.archive` : `.archive/<id>-<horodatage>`, récupérable).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProfileManager } from "@jarod/plugin-persona";
import type { PreparedPackage } from "../registry.js";
import { assertProfile, type HandlerContext } from "./context.js";

type Result = { success: boolean; error?: string };

/** Ce que la boîte de confirmation affiche (et ce qui est consigné). */
export interface InstallSummary {
  kind: string;
  id: string;
  name: string;
  source: string;
  revision: string;
  license: string;
  sha256: string;
  permissions: string[];
  files: number;
  target: string;
}

const NO_REGISTRY = "Registre non consulté (mode test sans registre local).";
const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);

export function createRegistryHandlers(ctx: HandlerContext) {
  const agent = () => ctx.kernel().agent;
  const client = () => ctx.registry ?? null;

  /** Écrit les fichiers dans un dossier de transit puis le renomme en cible (jamais de cible à moitié écrite). */
  const writeFolder = async (p: PreparedPackage, target: string) => {
    const staging = `${target}.installation-${Date.now()}`;
    try {
      for (const f of p.files) {
        const dest = join(staging, ...f.path.split("/"));
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.data);
      }
      await rename(staging, target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };

  const recordProvenance = async (p: PreparedPackage, target: string) => {
    const k = ctx.kernel();
    const dir = join(new ProfileManager(k.dataRoot).dirFor(k.profile), "registry");
    await mkdir(dir, { recursive: true });
    const line = {
      installedAt: new Date().toISOString(),
      kind: p.kind,
      id: p.id,
      name: p.name,
      repo: p.repo,
      revision: p.revision,
      path: p.path,
      source: p.source,
      license: p.license,
      permissions: p.permissions,
      sha256: p.sha256,
      files: p.files.map((f) => ({ path: f.path, sha256: f.sha256, gitBlob: f.gitBlob, bytes: f.data.length })),
      target,
    };
    await appendFile(join(dir, "provenance.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
  };

  /** Contrôles propres à la cible (sans écrire) ; rend la cible ou lève. */
  const targetOf = (p: PreparedPackage): string => {
    const k = ctx.kernel();
    if (p.kind === "skills") {
      const target = join(agent().skills.dir, p.id);
      if (existsSync(target) || agent().skills.get(p.id)) throw new Error(`Une skill « ${p.id} » existe déjà : rien n'a été remplacé.`);
      const scan = k.skillsHub?.scan({ files: p.files.filter((f) => isText(f.data)).map((f) => ({ path: f.path, data: f.data })) });
      if (!scan) throw new Error("Analyse des skills (skill-guard) indisponible : installation refusée.");
      if (scan.verdict === "dangerous") throw new Error("Installation refusée : l'analyse skill-guard a trouvé des motifs dangereux.");
      return target;
    }
    if (p.kind === "mcps") {
      if (agent().settings.get("mcpServers").some((s) => s.name === p.id)) throw new Error(`Serveur MCP « ${p.id} » déjà configuré.`);
      return `mcpServers › ${p.id}`;
    }
    if (p.kind === "agents") {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id)) throw new Error(`Identifiant « ${p.id} » inutilisable comme nom de profil.`);
      const profiles = new ProfileManager(k.dataRoot);
      if (profiles.list().includes(p.id)) throw new Error(`Le profil « ${p.id} » existe déjà.`);
      return profiles.dirFor(p.id);
    }
    throw new Error("Type d'entrée non installable");
  };

  const install = async (p: PreparedPackage, target: string) => {
    if (p.kind === "skills") {
      await writeFolder(p, target);
      await agent().skills.reload();
      return;
    }
    if (p.kind === "mcps") {
      const settings = agent().settings;
      const list = [...settings.get("mcpServers"), { id: randomUUID(), name: p.id, command: "", args: [], env: {}, enabled: true, url: p.manifest!.url! }];
      settings.set("mcpServers", list);
      await ctx.kernel().mcp?.sync(list);
      return;
    }
    // Agent : un profil neuf (dossier vide, comme `create-profile`) dont la persona est le fichier d'entrée.
    const profiles = new ProfileManager(ctx.kernel().dataRoot);
    const id = profiles.create(p.id);
    const dir = profiles.dirFor(id);
    const entry = p.manifest?.entry || "AGENT.md";
    await writeFile(join(dir, "SOUL.md"), p.files.find((f) => f.path === entry)!.data);
    await writeFile(join(dir, "profile-meta.json"), JSON.stringify({ name: p.name.slice(0, 80) }, null, 2), "utf8");
  };

  return {
    /** `fetchRegistry` : catalogue lu par le main (cache 5 min), erreur → catalogue vide + `error`. */
    "registry-fetch": async (force?: unknown) => {
      const c = client();
      return c ? c.catalog(force === true) : { skills: [], mcps: [], agents: [], workflows: [], error: NO_REGISTRY };
    },
    "registry-fetch-models": async (force?: unknown) => {
      const c = client();
      return c ? c.models(force === true) : { providers: [], error: NO_REGISTRY };
    },
    "registry-detail": async (kind: unknown, item: unknown) => {
      const c = client();
      if (!c) return { description: NO_REGISTRY };
      try {
        return await c.detail(kind, item);
      } catch (err) {
        return { description: (err as Error).message };
      }
    },
    "registry-install": async (kind: unknown, item: unknown, profile?: unknown): Promise<Result> => {
      assertProfile(ctx, profile);
      const c = client();
      if (!c) return { success: false, error: NO_REGISTRY };
      const confirm = ctx.shell.confirmInstall;
      if (!confirm) return { success: false, error: "Confirmation indisponible : installation refusée." };
      try {
        const p = await c.prepare(kind, (item as { id?: unknown } | null)?.id);
        const target = targetOf(p);
        const summary: InstallSummary = {
          kind: p.kind,
          id: p.id,
          name: p.name,
          source: p.source,
          revision: p.revision,
          license: p.license,
          sha256: p.sha256,
          permissions: p.permissions,
          files: p.files.length,
          target,
        };
        if (!(await confirm(summary))) return { success: false, error: "Installation annulée." };
        await install(p, target);
        await recordProvenance(p, target);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message || "Install failed" };
      }
    },
    "install-skill": (_identifier: unknown, profile?: unknown): Result => {
      assertProfile(ctx, profile);
      return { success: false, error: "Jarod-One n'a pas de skills livrées à installer : passez par Discover (registre) ou le Skills Hub." };
    },
    "uninstall-skill": async (name: unknown, profile?: unknown): Promise<Result> => {
      assertProfile(ctx, profile);
      const skills = agent().skills;
      const skill = skills.list().find((s) => s.id === name) ?? skills.list().find((s) => s.name === name);
      if (!skill) return { success: false, error: `Skill « ${String(name)} » introuvable` };
      try {
        await skills.archive(skill.id);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  };
}
