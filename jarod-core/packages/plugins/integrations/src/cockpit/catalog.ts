/**
 * Cockpit, lot 1 : les dix intégrations du prompt maître (les neuf dépôts + Strix), chacune avec son adaptateur (provenance,
 * licence, version épinglée) et ses capacités (ce que Jarod peut dire savoir faire, et la sonde qui le vérifie).
 *
 * Au lot 1, AUCUNE n'est exécutée par Jarod : `execution: "none"`, et les capacités sont au mieux `detection-only`, `skill` ou
 * `external-app`. Une sonde ne lance que le programme de l'intégration avec un argument de diagnostic constant.
 */
import type { AdapterManifest } from "../adapters.js";
import { PLUS3_ADAPTERS, PLUS3_INTEGRATIONS } from "./catalog-plus3.js";
import { cli, notInstalled, type ProbeHost, versionOf, which } from "./probe.js";
import type { CapabilityManifest, ProbeResult } from "./types.js";

/** Ce qu'une sonde peut lire en plus de l'hôte : l'état déclaré dans Jarod, jamais un document. */
export interface ProbeContext {
  /** Vague G : un réglage de Jarod, lu par sa clé (valeur non sensible : jamais le coffre). */
  setting?: (key: string) => unknown;
  skills: string[];
  mcpServers: { name: string; command: string; args: string[]; enabled: boolean }[];
  /** Lot 4 : le proxy de compression branché au transport (réglage `contextProxy`) et sa santé mesurée ; absent = non branché. */
  contextProxy?: { enabled: boolean; url: string; providers: string[]; healthy: boolean };
}

export type Probe = (host: ProbeHost, ctx: ProbeContext) => Promise<ProbeResult>;

export interface CockpitIntegration {
  adapter: string;
  capabilities: (CapabilityManifest & { probe: Probe })[];
}

const CHECKED = "2026-10-20";
const FALLBACK = "capacité affichée comme indisponible ; aucune action";
const adapter = (id: string, repo: string, license: string, pinned: string, notes: string): AdapterManifest => ({
  id,
  repo,
  wave: "F",
  license,
  licenseCheckedAt: CHECKED,
  adapterVersion: "0.1.0",
  pinned,
  status: "adapter-ready",
  mode: "disabled",
  fallback: FALLBACK,
  execution: "none",
  perfSensitive: false,
  notes,
});

export const COCKPIT_ADAPTERS: AdapterManifest[] = [
  adapter("F1", "ranxianglei/billion-context", "MIT", "39fb841d318f6a8b47c7ab9a17803eaa980936c3", "compression de l'historique par proxy local ; détecté, pas encore branché au transport"),
  adapter("F2", "mksglu/context-mode", "Elastic-2.0", "b31c7ee853cb9ea76121e24d368599390972a997", "serveur MCP d'indexation des sorties ; ELv2 (usage personnel)"),
  adapter("F3", "heygen-com/hyperframes", "Apache-2.0", "50e7a59aef592e262238edfa2df2a6d96af2476f", "vidéo à partir de HTML ; exige FFmpeg ; télémétrie coupée dans les sondes"),
  adapter("F4", "NationalSecurityAgency/ghidra", "Apache-2.0", "Ghidra_12.1.4_build", "analyse statique ; exige un JDK 21 ; détection seule"),
  adapter("F5", "cathrynlavery/diagram-design", "MIT", "47620270fc671a078fdbb06f91a4d7e7b9499333", "skill de diagrammes"),
  adapter("F6", "mattpocock/skills", "MIT", "5beb35b040e3de97e54fa9e386d7e42d15c295c2", "skills d'ingénierie (sélection)"),
  adapter("F7", "boykopovar/AnyPS5", "GPL-2.0-only", "6d89a7bd8abdac9b01f6202aa9539d1fb4e6e3dd", "expérimental ; détection seule"),
  adapter("F8", "storytold/artcraft", "MIT OR Apache-2.0", "7a2935cf9e3922e90e4ed5f3556b1cb107013148", "application séparée ; génération distante"),
  adapter("F9", "morluto/rea", "MIT", "b4938aed58737293a6987630476632619713f5cd", "analyse statique en ligne de commande ; détection seule"),
  adapter("F10", "usestrix/strix", "Apache-2.0", "a0f8ea2cd379c4bf56e665d3db2ba8a4f7c0683c", "tests de sécurité applicative ; exige Docker et un modèle configuré ; détection seule"),
  // Vague G (2026-10-20) : les 17 dépôts du prompt « plus3 », même registre (catalog-plus3.ts).
  ...PLUS3_ADAPTERS,
];

// ---- aides de sonde ----

const join = (...parts: string[]) => parts.join("\\");

function ghidraRoot(host: ProbeHost): string | null {
  const candidates = [
    host.env.GHIDRA_INSTALL_DIR,
    host.env.USERPROFILE && join(host.env.USERPROFILE, "scoop", "apps", "ghidra", "current"),
    host.env.ProgramFiles && join(host.env.ProgramFiles, "Ghidra"),
  ];
  for (const c of candidates) if (c && host.exists(join(c, "support", "analyzeHeadless.bat"))) return c;
  return null;
}

async function javaMajor(host: ProbeHost): Promise<{ file: string; major: number } | null> {
  const file = host.env.JAVA_HOME && host.exists(join(host.env.JAVA_HOME, "bin", "java.exe")) ? join(host.env.JAVA_HOME, "bin", "java.exe") : which(host, "java");
  if (!file) return null;
  const r = await host.run(file, ["-version"], 8000);
  const m = /version "(\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return m ? { file, major: Number(m[1]) } : null;
}

const MATT_SKILLS = ["diagnosing-bugs", "tdd", "code-review", "codebase-design", "to-spec", "handoff"];

// ---- capacités ----

const base = {
  tools: [] as string[],
  artifacts: [] as string[],
  timeoutMs: 8000,
  cancel: "rien à annuler : la sonde a un délai court",
};

export const COCKPIT_INTEGRATIONS: CockpitIntegration[] = [
  {
    adapter: "F1",
    capabilities: [
      {
        ...base,
        id: "billion-context.compress-history",
        name: "Compression de l'historique",
        description: "Réduit le contexte envoyé au modèle en compressant l'historique de conversation.",
        categories: ["contexte", "modèle"],
        intents: ["compresser l'historique", "réduire le contexte de la conversation"],
        owner: "F1",
        integration: "detection-only",
        output: "état du proxy et des fournisseurs qui y passent",
        risk: "read",
        sideEffects: "aucun (détection) ; le transport, lui, passe par le proxy quand le réglage est allumé",
        locality: "local",
        requires: ["proxy bili lancé en local (ACP_AUTO_UPDATE=0)", "Réglages › Contexte : proxy allumé, fournisseurs choisis"],
        verification: "/__bili/health répond sur l'adresse de bouclage réglée",
        limits: ["option « préfixe d'URL » seulement : jamais d'interception TLS ni de certificat", "fournisseurs distants nommés seulement", "Jarod ne compacte plus ces conversations (une seule autorité)"],
        probe: async (host, ctx) => {
          const p = ctx.contextProxy;
          if (p?.enabled && p.providers.length && p.healthy) return { state: "available", detail: `proxy local ${p.url} en marche pour ${p.providers.join(", ")}` };
          if (p?.enabled && p.providers.length) return { state: "degraded", detail: `réglage allumé, mais le proxy local ${p.url} ne répond pas : les requêtes de ${p.providers.join(", ")} échoueront`, missing: ["proxy bili en marche"] };
          const c = await cli(host, "bili", "billion-context");
          if (c.kind !== "ok") return c.result;
          return { state: "installed-unconfigured", detail: "installé ; il s'utilise comme proxy local (URL de base du fournisseur) : à allumer dans Réglages › Contexte", version: c.version, found: [c.file] };
        },
      },
    ],
  },
  {
    adapter: "F2",
    capabilities: [
      {
        ...base,
        id: "context-mode.index-output",
        name: "Indexation des sorties volumineuses",
        description: "Indexe les longues sorties d'outils et permet d'y chercher sans tout charger dans le contexte.",
        categories: ["contexte", "recherche"],
        intents: ["indexer une longue sortie", "chercher dans les sorties d'outils"],
        owner: "F2",
        integration: "detection-only",
        output: "état de l'installation et de la déclaration MCP",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "local",
        requires: ["commande context-mode", "serveur MCP « context-mode » déclaré et activé dans Jarod"],
        verification: "context-mode --version répond et le serveur MCP est déclaré",
        limits: ["Jarod n'appelle ses outils qu'à travers le client MCP existant", "équivalent NATIF toujours actif : sorties volumineuses hors du contexte, output_search / output_read"],
        probe: async (host, ctx) => {
          const declared = ctx.mcpServers.some((s) => s.enabled && (s.name === "context-mode" || /context-mode/i.test([s.command, ...s.args].join(" "))));
          const c = await cli(host, "context-mode", "context-mode");
          if (c.kind === "error") return c.result;
          if (declared) return { state: "available", detail: "déclaré comme serveur MCP de Jarod", ...(c.kind === "ok" ? { version: c.version, found: [c.file] } : {}) };
          if (c.kind === "absent") return c.result;
          return { state: "installed-unconfigured", detail: "installé, mais pas déclaré comme serveur MCP de Jarod", version: c.version, found: [c.file], missing: ["serveur MCP context-mode"] };
        },
      },
    ],
  },
  {
    adapter: "F3",
    capabilities: [
      {
        ...base,
        id: "hyperframes.render-video",
        name: "Vidéo à partir de HTML",
        description: "Rend une composition HTML (projet HyperFrames) en vidéo locale, comme une tâche annulable, vérifiée et enregistrée en artefact.",
        categories: ["vidéo", "création"],
        intents: ["créer une vidéo", "générer une vidéo à partir de html", "rendre une vidéo"],
        owner: "F3",
        tools: ["video_render"],
        integration: "agent-tool",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "local",
        requires: ["commande hyperframes", "FFmpeg"],
        verification: "hyperframes --version et ffmpeg -version répondent",
        limits: ["rendu local seulement (jamais cloud)", "preuve par ffprobe ; sans ffprobe, la vérification est dite impossible", "délai de 30 min"],
        probe: async (host) => {
          const c = await cli(host, "hyperframes", "HyperFrames");
          if (c.kind !== "ok") return c.result;
          const ff = await cli(host, "ffmpeg", "FFmpeg", ["-version"]);
          if (ff.kind !== "ok") return { state: "degraded", detail: "HyperFrames trouvé, FFmpeg absent ou muet", version: c.version, found: [c.file], missing: ["FFmpeg"] };
          return { state: "available", detail: `FFmpeg ${ff.version ?? ""}`.trim(), version: c.version, found: [c.file, ff.file] };
        },
      },
    ],
  },
  {
    adapter: "F4",
    capabilities: [
      {
        ...base,
        id: "ghidra.static-analysis",
        name: "Analyse statique de binaires (Ghidra)",
        description: "Analyse statique d'un exécutable par import headless Ghidra, sans jamais le lancer (outil ghidra_analyze).",
        categories: ["analyse", "binaire"],
        intents: ["analyser un binaire", "analyser un exécutable windows", "désassembler un binaire"],
        owner: "F4",
        tools: ["ghidra_analyze"],
        integration: "agent-tool",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "local",
        requires: ["Ghidra (GHIDRA_INSTALL_DIR ou scoop)", "JDK 21"],
        verification: "fichiers de Ghidra présents et java -version ≥ 21",
        limits: ["analyse statique via ghidra_analyze : la cible est IMPORTÉE, jamais exécutée", "fichiers que vous avez le droit d'analyser", "confinés au dossier de travail"],
        probe: async (host) => {
          const root = ghidraRoot(host);
          if (!root) return notInstalled("Ghidra", "Ghidra introuvable (GHIDRA_INSTALL_DIR ou scoop)");
          const props = host.readText(join(root, "Ghidra", "application.properties")) ?? "";
          const version = /application\.version=(\S+)/.exec(props)?.[1];
          const java = await javaMajor(host);
          const v = version ? { version } : {};
          if (!java) return { state: "installed-unconfigured", detail: "Ghidra trouvé, aucun Java", ...v, found: [root], missing: ["JDK 21"] };
          if (java.major < 21) return { state: "installed-unconfigured", detail: `Java ${java.major} trop ancien`, ...v, found: [root, java.file], missing: ["JDK 21"] };
          return { state: "available", detail: `Java ${java.major}`, ...v, found: [root, java.file] };
        },
      },
    ],
  },
  {
    adapter: "F5",
    capabilities: [
      {
        ...base,
        id: "diagram-design.draw",
        tools: ["artifact_register", "diagram_export"],
        name: "Diagrammes",
        description: "Instructions pour concevoir des diagrammes clairs.",
        categories: ["diagramme", "création"],
        intents: ["dessiner un diagramme", "faire un schéma"],
        owner: "F5",
        integration: "skill",
        output: "instructions chargées par load_skill",
        risk: "read",
        sideEffects: "aucun",
        locality: "local",
        requires: ["skill diagram-design installé"],
        verification: "le skill figure dans les skills de Jarod",
        limits: ["skill embarquée : bundled:diagram-design/diagram-design (installation à la demande)", "export SVG par diagram_export ; PNG non disponible"],
        probe: async (_h, ctx) =>
          ctx.skills.includes("diagram-design") ? { state: "available", detail: "skill installé", found: ["diagram-design"] } : notInstalled("skill diagram-design"),
      },
    ],
  },
  {
    adapter: "F6",
    capabilities: [
      {
        ...base,
        id: "mattpocock-skills.engineering",
        name: "Skills d'ingénierie",
        description: "Méthodes de travail : TDD, diagnostic de bogues, revue de code, modélisation, spécification.",
        categories: ["ingénierie", "méthode"],
        intents: ["écrire des tests d'abord", "diagnostiquer un bogue", "relire du code"],
        owner: "F6",
        integration: "skill",
        output: "instructions chargées par load_skill",
        risk: "read",
        sideEffects: "aucun",
        locality: "local",
        requires: MATT_SKILLS.map((s) => `skill ${s}`),
        verification: "les skills sélectionnés figurent dans les skills de Jarod",
        limits: ["une sélection du dépôt, embarquée : bundled:mattpocock/<skill> (installation à la demande, hors ligne)"],
        probe: async (_h, ctx) => {
          const found = MATT_SKILLS.filter((s) => ctx.skills.includes(s));
          const missing = MATT_SKILLS.filter((s) => !found.includes(s));
          if (!found.length) return notInstalled("skills mattpocock", "aucun des skills sélectionnés n'est installé");
          if (missing.length) return { state: "degraded", detail: `${found.length}/${MATT_SKILLS.length} installés`, found, missing };
          return { state: "available", detail: "tous installés", found };
        },
      },
    ],
  },
  {
    adapter: "F7",
    capabilities: [
      {
        ...base,
        id: "anyps5.relink",
        name: "Reliure ELF homebrew (expérimental)",
        description: "Outil de développement homebrew : relie un exécutable ELF. Détecté seulement.",
        categories: ["développement", "homebrew"],
        intents: ["relier un elf homebrew"],
        owner: "F7",
        integration: "detection-only",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "local",
        requires: ["JAROD_ANYPS5_RELINKER désignant le programme"],
        verification: "le programme répond à --help",
        limits: ["détection seule", "aucun jeu, firmware ni clé n'est téléchargé ou traité"],
        experimental: true,
        probe: async (host) => {
          const file = host.env.JAROD_ANYPS5_RELINKER;
          if (!file || !host.exists(file)) return notInstalled("relinker", "JAROD_ANYPS5_RELINKER non réglé ou introuvable");
          const v = await versionOf(host, file, ["--help"]);
          if (!v.ok) return { state: "error", detail: v.why, found: [file] };
          return { state: "available", detail: "répond à --help", found: [file] };
        },
      },
    ],
  },
  {
    adapter: "F8",
    capabilities: [
      {
        ...base,
        id: "artcraft.create",
        tools: ["system_open"],
        name: "Création d'images et de vidéos (ArtCraft)",
        description: "Application séparée de création d'images et de vidéos ; la génération passe par des services distants.",
        categories: ["image", "vidéo", "création"],
        intents: ["créer une image", "générer une image", "créer une vidéo"],
        owner: "F8",
        integration: "external-app",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "remote",
        requires: ["ArtCraft installé"],
        verification: "ArtCraft.exe présent",
        limits: ["application externe : Jarod l'ouvre (system_open, accord et preuve d'ouverture), il ne la pilote pas", "génération distante : ce que vous y saisissez quitte la machine ; Jarod n'y envoie rien lui-même"],
        probe: async (host) => {
          const candidates = [host.env.LOCALAPPDATA && join(host.env.LOCALAPPDATA, "ArtCraft", "ArtCraft.exe"), host.env.ProgramFiles && join(host.env.ProgramFiles, "ArtCraft", "ArtCraft.exe")];
          const exe = candidates.find((c): c is string => Boolean(c && host.exists(c)));
          return exe ? { state: "available", detail: "application trouvée", found: [exe] } : notInstalled("ArtCraft");
        },
      },
    ],
  },
  {
    adapter: "F9",
    capabilities: [
      {
        ...base,
        id: "rea.investigate",
        name: "Analyse statique de binaires (REA)",
        description: "Analyse statique d'un fichier avec REA (analyze, decompile, compare), sans jamais l'exécuter (outil rea_static, sous-commandes statiques seulement).",
        categories: ["analyse", "binaire"],
        intents: ["analyser un binaire windows", "examiner un exécutable"],
        owner: "F9",
        tools: ["rea_static"],
        integration: "agent-tool",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "local",
        requires: ["commande rea"],
        verification: "rea --version répond",
        limits: ["sous-commandes STATIQUES seulement (jamais capture/debug/attach d'un processus vivant)", "fichiers que vous avez le droit d'analyser", "confinés au dossier de travail"],
        probe: async (host) => {
          const c = await cli(host, "rea", "REA");
          if (c.kind !== "ok") return c.result;
          return { state: "available", detail: "commande trouvée", version: c.version, found: [c.file] };
        },
      },
    ],
  },
  {
    adapter: "F10",
    capabilities: [
      {
        ...base,
        id: "strix.app-security",
        name: "Tests de sécurité applicative (Strix)",
        description: "Tests de sécurité de vos propres applications. Détecté seulement.",
        categories: ["sécurité", "test"],
        intents: ["tester la sécurité de mon application"],
        owner: "F10",
        integration: "detection-only",
        output: "état de l'installation",
        risk: "read",
        sideEffects: "aucun (détection)",
        locality: "mixed",
        requires: ["commande strix", "Docker en marche", "STRIX_LLM réglé"],
        verification: "strix --version et docker info répondent ; STRIX_LLM présent (valeur jamais lue)",
        limits: ["détection seule", "uniquement sur des applications que vous possédez ou êtes autorisé à tester"],
        probe: async (host) => {
          const c = await cli(host, "strix", "Strix");
          if (c.kind !== "ok") return c.result;
          const v = { version: c.version };
          const missing: string[] = [];
          const docker = which(host, "docker");
          if (!docker) missing.push("Docker");
          if (!host.env.STRIX_LLM) missing.push("STRIX_LLM");
          if (missing.length) return { state: "installed-unconfigured", detail: `manque : ${missing.join(", ")}`, ...v, found: [c.file], missing };
          const info = await host.run(docker!, ["info"], 8000);
          if (info.code !== 0 || info.timedOut || info.error) return { state: "degraded", detail: "Docker ne répond pas", ...v, found: [c.file, docker!], missing: ["Docker en marche"] };
          return { state: "available", detail: "Docker en marche, modèle réglé", ...v, found: [c.file, docker!] };
        },
      },
    ],
  },
  {
    // D1 raccordé (2026-10-21) : le pilote de fenêtres FlaUI, deux outils de l'agent sous les permissions configurables.
    adapter: "D1",
    capabilities: [
      {
        ...base,
        id: "flaui.desktop-control",
        name: "Fenêtres Windows : lire et agir (FlaUI)",
        description:
          "Lit les fenêtres de ce bureau et y agit : éléments nommés (lire, cliquer, saisir, touches), clavier brut et souris par coordonnées relatives à la fenêtre. La fenêtre (processus:titre) est la cible d'une règle de permissions, l'action son opération (read.*, ui.*, keyboard.*, mouse.*).",
        categories: ["bureau", "automatisation"],
        intents: ["cliquer dans une application", "remplir un formulaire windows", "taper dans une fenêtre", "automatiser une fenêtre windows"],
        owner: "D1",
        tools: ["desktop_windows", "desktop_control"],
        integration: "agent-tool",
        output: "fenêtres, éléments, texte lu ; actions avec accord ou règle autonome",
        risk: "act",
        sideEffects: "entrées clavier et souris dans la fenêtre visée",
        locality: "local",
        requires: ["moteur FlaUI (JAROD_FLAUI_WORKER ou JAROD_ENGINES_DIR\\flaui\\uia-flaui-worker.exe)", "runtime .NET 8 ou plus"],
        verification: "le moteur est présent (la liste des fenêtres le démarre)",
        limits: [
          "accord à chaque action, sauf règle autonome pour la fenêtre et l'opération (jarod permissions add auto desktop_control --cible \"notepad.exe:*\" --operation \"keyboard.*\")",
          "clavier brut et souris : opérations réservées, refusées sans règle de l'utilisateur",
          "un seul contrôleur actif par bureau ; arrêt d'urgence Ctrl+Alt+Fin (la reprise demande l'utilisateur)",
          "jamais : gestionnaires de mots de passe, invites d'élévation, sécurité Windows, champ de mot de passe ; ni touche Windows, Alt+Tab, Ctrl+Alt+…",
          "agit sur le VRAI bureau (pas de bureau isolé) : premier plan constaté avant les touches, point de clic constaté sur la fenêtre visée",
        ],
        probe: async (host) => {
          if (host.platform !== "win32") return { state: "not-installed", detail: "Windows seulement", missing: ["Windows"] };
          const file = [host.env.JAROD_FLAUI_WORKER, host.env.JAROD_ENGINES_DIR && `${host.env.JAROD_ENGINES_DIR}\\flaui\\uia-flaui-worker.exe`].find((p): p is string => Boolean(p) && host.exists(p!));
          return file ? { state: "available", detail: "moteur FlaUI présent", found: [file] } : notInstalled("moteur FlaUI (uia-flaui-worker.exe)");
        },
      },
    ],
  },
  ...PLUS3_INTEGRATIONS,
];
