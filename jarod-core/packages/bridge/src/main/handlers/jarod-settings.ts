/**
 * Réglages PROPRES à Jarod que SANK-UI n'avait pas (SPECS-P5-UI-PARITE.md §2) : canaux `get-jarod-settings` /
 * `set-jarod-settings` (`JAROD_INVOKE_CHANNELS`, absents de hermesAPI).
 *
 * Règles :
 * - LISTE BLANCHE : une clé qui n'est pas dans `ENTRIES` est refusée (jamais ignorée en silence) — le renderer ne peut pas
 *   écrire un réglage arbitraire, ni un secret, ni `workspace` (boîte native seulement), ni `providerOverrides`, `mcpServers`…
 *   qui ont déjà leurs canaux gardés ;
 * - TOUT est validé AVANT la première écriture, puis écrit en une transaction (`patch`) : un patch à moitié valide n'écrit RIEN ;
 * - une valeur hors bornes LÈVE, elle n'est jamais « ramenée » à une valeur voisine ;
 * - ce qui donne PLUS de pouvoir à l'agent (`autoApproveTools`) exige une confirmation NATIVE du main, « Annuler » par défaut ;
 *   sans boîte native (mode test) : refus. Le retirer ne demande rien ;
 * - rien d'ici ne rend ni n'accepte de secret.
 * Les écrans (volet Agent…) lisent `get-jarod-settings` : une clé absente de la réponse n'est pas gérée par ce main.
 */
import { type ConnectedBrowserSettings, connectedBrowserDomainProblem, DEFAULT_DOCKER, EcosystemFlags, ecosystemFlags, PermissionRule, type Settings, type ShellPolicy } from "@jarod/contracts";
import { describeShellGuard } from "@jarod/plugin-agent";
import { isLoopbackUrl } from "@jarod/plugin-llm";
import { rulesWeakenings } from "@jarod/plugin-permissions";
import { STT_DEFAULTS } from "@jarod/plugin-voice";
import type { HandlerContext } from "./context.js";
import { launchAtLoginRefusal, launchAtLoginView, type LoginItemsPort, setLaunchAtLogin } from "../tray-policy.js";
import { shellsOf } from "./terminal.js";

type Patch = Partial<Settings>;

/** Ce que les validations demandent au kernel : un fournisseur du catalogue (lève s'il est inconnu) et s'il sort de la machine. */
interface Env {
  provider(id: string): { name: string; leavesMachine: boolean };
  /** Les shells de cette machine (liste fermée du terminal intégré). */
  shells(): { path: string; name: string }[];
  /** L'entrée de démarrage de la session (port) ; absent = indisponible (SPECS-P5-TRAY.md). */
  login: LoginItemsPort | undefined;
}

interface Confirmation {
  message: string;
  detail: string;
  action: string;
}

interface Entry {
  read(s: Settings, env: Env): unknown;
  /** Valide `value` et rend le morceau de réglages à écrire (fusionné avec l'existant pour un objet). Lève si invalide. */
  write(value: unknown, current: Settings, env: Env): Patch;
  /** Le changement accroît le pouvoir de l'agent ou envoie des données ailleurs : texte de la confirmation native, ou null si sans risque. */
  confirm?(patch: Patch, current: Settings, env: Env): Confirmation | null;
  /** Un effet HORS des réglages (le système), appliqué APRÈS toutes les confirmations et AVANT l'écriture : s'il lève, rien n'est écrit. */
  apply?(patch: Patch, current: Settings, env: Env): void;
}

const bad = (key: string, why: string): never => {
  throw new Error(`[oneai] réglage « ${key} » : ${why}`);
};

const boolean = <K extends keyof Settings>(key: K): Entry => ({
  read: (s) => s[key],
  write: (v) => (typeof v === "boolean" ? ({ [key]: v } as Patch) : bad(key, "booléen attendu")),
});

const oneOf = <K extends keyof Settings>(key: K, allowed: readonly string[]): Entry => ({
  read: (s) => s[key],
  write: (v) => (typeof v === "string" && allowed.includes(v) ? ({ [key]: v } as Patch) : bad(key, `une valeur parmi ${allowed.join(", ")}`)),
});

function integer(key: string, v: unknown, min: number, max: number, zero = false): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return bad(key, "entier attendu");
  if (zero && v === 0) return 0;
  if (v < min || v > max) return bad(key, `entre ${zero ? "0 (désactivé) ou " : ""}${min} et ${max}`);
  return v;
}

function money(key: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) return bad(key, "montant en dollars entre 0 (aucun plafond) et 1 000 000");
  return Math.round(v * 10_000) / 10_000;
}

/** Une chaîne bornée (vide autorisée sauf si `empty` est faux). */
function text(key: string, v: unknown, max: number, empty = true): string {
  if (typeof v !== "string") return bad(key, "texte attendu");
  const t = v.trim();
  if (!empty && !t) return bad(key, "ne peut pas être vide");
  if (t.length > max) return bad(key, `au plus ${max} caractères`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
  if (/[\u0000-\u001f]/.test(t)) return bad(key, "caractère de contrôle refusé");
  return t;
}

/** Un objet partiel : seules les clés connues, les autres sont refusées. */
function record(key: string, v: unknown, known: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad(key, "objet attendu");
  const extra = Object.keys(v).filter((k) => !known.includes(k));
  if (extra.length) bad(key, `clé(s) inconnue(s) : ${extra.join(", ")}`);
  return v as Record<string, unknown>;
}

const MAX_FALLBACKS = 5;
/** Plafond des règles de permissions de l'utilisateur : au-delà, c'est une liste qu'aucun écran ne peut montrer. */
const MAX_PERMISSION_RULES = 200;
/** Une autorisation temporaire dure au plus 30 jours : au-delà, c'est une règle permanente qui ne dit pas son nom. */
const MAX_TEMPORARY_MS = 30 * 24 * 3_600_000;
/** Un `tool` de règle : un nom d'outil, un segment de famille ou le joker `*`. Ni espace ni caractère de contrôle (AV2-008). */
const ruleToolOk = (s: string): boolean => /^[A-Za-z0-9_./*-]+$/.test(s);

/** Une adresse d'embeddings : http(s) sans identifiants ; elle est LOCALE (boucle locale) ou non — c'est là que partent les textes à indexer. */
function embeddingsUrlOf(key: string, v: unknown): { url: string; local: boolean } {
  const raw = text(key, v, 500);
  if (!raw) return { url: "", local: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad(key, "adresse invalide (http://hôte:port/v1)");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") bad(key, "http(s) seulement");
  if (u.username || u.password) bad(key, "sans identifiants dans l'adresse (la clé du fournisseur se règle dans Fournisseurs)");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return { url: raw.replace(/\/+$/, ""), local: host === "localhost" || host === "127.0.0.1" || host === "::1" };
}

/** Les moteurs de l'écosystème qui CHANGENT ce que la recherche sert ou ce qui s'exécute : un changement vers eux demande une confirmation native. */
function ecosystemServes(f: EcosystemFlags): string[] {
  const out: string[] = [];
  if (f.vectorIndex !== "memory") out.push(`index vectoriel : ${f.vectorIndex}`);
  if (f.documentParser !== "builtin") out.push(`analyse des documents : ${f.documentParser}`);
  if (f.sparseEmbeddings !== "off") out.push(`embeddings creux : ${f.sparseEmbeddings}`);
  if (f.reranker !== "off") out.push(`reclassement : ${f.reranker} (${f.rerankMode === "active" ? "SERVI" : "fantôme"})`);
  if (f.hybrid === "on") out.push("recherche hybride (dense + lexical)");
  if (f.decisionEngine !== "off") out.push(`moteur de décision : ${f.decisionEngine} (${f.decisionMode === "active" ? "UTILISÉ" : "fantôme"})`);
  return out;
}

// ── Garde du shell ───────────────────────────────────────────────────────────────────────────────────────
/** La politique EFFECTIVE (le défaut complété par le réglage), comme `ShellGuardService.policy()` : ce qui s'affiche est ce qui s'applique. */
function effectiveShell(p: Partial<ShellPolicy> | undefined): Required<Omit<ShellPolicy, "docker">> & { docker: NonNullable<ShellPolicy["docker"]> } {
  const q = p ?? {};
  return {
    writeScope: q.writeScope === "workspace" ? "workspace" : "off",
    writableRoots: [...(q.writableRoots ?? [])],
    readRoots: [...(q.readRoots ?? [])],
    allowedPrograms: [...(q.allowedPrograms ?? [])],
    deniedPrograms: [...(q.deniedPrograms ?? [])],
    askPrograms: [...(q.askPrograms ?? [])],
    environment: q.environment === "docker" ? "docker" : "local",
    docker: { ...DEFAULT_DOCKER, ...(q.docker ?? {}) },
  };
}

/** Une liste de textes bornée, sans doublon, sans caractère de contrôle. */
function stringList(key: string, v: unknown, max: number, itemMax: number, ok: (s: string) => string | null): string[] {
  if (!Array.isArray(v)) return bad(key, "liste attendue");
  if (v.length > max) return bad(key, `${max} entrées au plus`);
  const out: string[] = [];
  for (const [i, raw] of v.entries()) {
    const item = text(`${key}[${i}]`, raw, itemMax, false);
    const why = ok(item);
    if (why) bad(`${key}[${i}]`, why);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** Un programme : un nom (`git`, `node.exe`) ou un chemin absolu ; ni espace, ni guillemet, ni métacaractère de shell. */
const programOk = (s: string): string | null => (/^[^\s"'`;&|<>*?$%(){}[\]^!]+$/.test(s) ? null : "nom de programme ou chemin absolu, sans espace ni caractère de shell");
/**
 * Un dossier de lecture (outils : node, git…) : chemin ABSOLU, sans « .. », sans joker ni caractère interdit d'un chemin. La vérification de fond (existe, est un dossier, n'est ni
 * une racine de lecteur ni le dossier personnel ni un dossier de clés) est faite par le garde à chaque commande, sur le chemin réel : un dossier refusé là refuse la commande.
 */
const readRootOk = (s: string): string | null => {
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s)) return "chemin absolu (par exemple C:\\Users\\vous\\scoop\\shims)";
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return "sans « .. »";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intended, rejects input that contains control characters
  if (/[*?<>|"\u0000-\u001f]/.test(s)) return "sans joker ni caractère interdit dans un chemin";
  return null;
};
/** Un dossier d'écriture : RELATIF au dossier de travail, sans « .. », sans lecteur ni racine. */
const rootOk = (s: string): string | null => {
  if (/^([a-zA-Z]:|[\\/])/.test(s) || /(^|[\\/])\.\.([\\/]|$)/.test(s)) return "chemin relatif au dossier de travail, sans « .. » ni racine";
  return null;
};
/** Une référence d'image Docker : minuscules, chiffres, `._-/:@`. */
const imageOk = (s: string): string | null => (/^[a-z0-9][a-z0-9._\-/:@]*$/.test(s) && !s.includes("..") ? null : "référence d'image Docker (minuscules, chiffres, . _ - / : @)");

/** Ce qui AFFAIBLIT le garde entre deux politiques effectives (une phrase par changement) : chacun exige la confirmation native. */
export function shellWeakenings(old: ReturnType<typeof effectiveShell>, next: ReturnType<typeof effectiveShell>): string[] {
  const out: string[] = [];
  if (old.writeScope === "workspace" && next.writeScope === "off") out.push("le confinement des écritures est retiré");
  if (old.environment === "docker" && next.environment === "local") out.push("les commandes tourneront sur la machine elle-même, plus dans Docker");
  for (const r of next.writableRoots.filter((x) => !old.writableRoots.includes(x))) out.push(`écriture permise dans « ${r} »`);
  for (const r of next.readRoots.filter((x) => !old.readRoots.includes(x))) out.push(`lecture et exécution permises dans « ${r} »`);
  if (old.allowedPrograms.length > 0 && next.allowedPrograms.length === 0) out.push("tous les programmes redeviennent permis (la liste des permis est vidée)");
  else for (const p of next.allowedPrograms.filter((x) => !old.allowedPrograms.includes(x))) if (old.allowedPrograms.length > 0) out.push(`programme permis en plus : ${p}`);
  for (const p of old.deniedPrograms.filter((x) => !next.deniedPrograms.includes(x))) out.push(`programme n'est plus refusé : ${p}`);
  for (const p of old.askPrograms.filter((x) => !next.askPrograms.includes(x))) out.push(`programme ne demande plus d'accord : ${p}`);
  if (!old.docker.network && next.docker.network) out.push("le conteneur Docker aura accès au réseau");
  if (old.docker.image !== next.docker.image && next.environment === "docker") out.push(`image Docker changée : ${next.docker.image}`);
  return out;
}

// ── Navigateur connecté (E2) ─────────────────────────────────────────────────────────────────────────────
/** Le réglage EFFECTIF (absent = éteint, aucun domaine). */
function effectiveBrowser(c: Partial<ConnectedBrowserSettings> | undefined): ConnectedBrowserSettings {
  const q = c ?? {};
  return { enabled: q.enabled === true, allowDomains: [...(q.allowDomains ?? [])], denyDomains: [...(q.denyDomains ?? [])] };
}

/** Une liste de domaines : nettoyés (casse, espaces), sans doublon, chacun un domaine COMPLET. */
function domainList(key: string, v: unknown): string[] {
  if (!Array.isArray(v)) return bad(key, "liste attendue");
  if (v.length > 100) return bad(key, "100 entrées au plus");
  const out: string[] = [];
  for (const [i, raw] of v.entries()) {
    const d = text(`${key}[${i}]`, raw, 253, false).toLowerCase();
    const why = connectedBrowserDomainProblem(d);
    if (why) bad(`${key}[${i}]`, why);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Ce qui AFFAIBLIT le réglage : activer, permettre un domaine de plus, lever une interdiction. Durcir (éteindre, retirer, interdire) ne demande rien. */
export function browserWeakenings(old: ConnectedBrowserSettings, next: ConnectedBrowserSettings): string[] {
  const out: string[] = [];
  if (!old.enabled && next.enabled) out.push("le navigateur connecté est activé");
  for (const d of next.allowDomains.filter((x) => !old.allowDomains.includes(x))) out.push(`le domaine ${d} (et ses sous-domaines) devient accessible au navigateur`);
  for (const d of old.denyDomains.filter((x) => !next.denyDomains.includes(x))) out.push(`le domaine ${d} n'est plus interdit`);
  return out;
}

const ENTRIES: Record<string, Entry> = {
  // ── Agent ──────────────────────────────────────────────────────────────────────────────────────────────
  autoApproveTools: {
    read: (s) => s.autoApproveTools,
    write: (v) => (typeof v === "boolean" ? { autoApproveTools: v } : bad("autoApproveTools", "booléen attendu")),
    confirm: (patch, current) =>
      patch.autoApproveTools === true && !current.autoApproveTools
        ? {
            message: "Autoriser tous les outils sans demander ?",
            detail:
              "L'agent pourra écrire des fichiers, lancer des commandes et utiliser le réseau SANS vous demander à chaque fois. " +
              "Les règles « refuser » et « demander » du garde de permissions et le garde du shell continuent de s'appliquer. " +
              "Vous pourrez le retirer à tout moment dans Réglages › Agent.",
            action: "Autoriser sans demander",
          }
        : null,
  },
  // « Toujours autoriser » : cet écran ne fait que RETIRER. Un outil n'y entre que par la fenêtre d'accord (confirmation native).
  alwaysAllowTools: {
    read: (s) => [...s.alwaysAllowTools],
    write: (v, current) => {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return bad("alwaysAllowTools", "liste de noms d'outils attendue");
      const extra = v.filter((x: string) => !current.alwaysAllowTools.includes(x));
      if (extra.length) bad("alwaysAllowTools", `ajout refusé ici (${extra.join(", ")}) : un outil se dispense d'accord depuis la fenêtre d'accord`);
      return { alwaysAllowTools: current.alwaysAllowTools.filter((x) => v.includes(x)) };
    },
  },
  // SPECS-P5-DISABLED-SKILLS (file 4e) : les skills offertes au modèle, vues depuis l'écran.
  // Écriture large (ajout ET retrait d'un id) : c'est le réglage lui-même qui donne ce pouvoir à
  // l'écran, pas un contournement — mais borné : ids de skills, jamais de chemin ni de corps.
  disabledSkills: {
    read: (s) => [...s.disabledSkills],
    write: (v) => {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 200)) {
        return bad("disabledSkills", "liste de noms de skills (chaînes non vides, 200 caractères max)");
      }
      if (v.length > 1000) return bad("disabledSkills", "au plus 1000 skills désactivées");
      return { disabledSkills: [...new Set(v.map((x) => x.trim()))] };
    },
  },
  // Terminal intégré : jamais un chemin libre — « » (le premier shell détecté) ou l'un des shells que cette machine a.
  terminalShell: {
    read: (s) => s.terminalShell,
    write: (v, _current, env) => {
      const wanted = text("terminalShell", v, 500);
      if (!wanted) return { terminalShell: "" };
      const shell = env.shells().find((s) => s.path.toLowerCase() === wanted.toLowerCase());
      return shell ? { terminalShell: shell.path } : bad("terminalShell", "un shell détecté sur cette machine (liste de get-jarod-options)");
    },
  },
  agentMode: oneOf("agentMode", ["build", "plan"]),
  maxAgentSteps: {
    read: (s) => s.maxAgentSteps,
    write: (v) => ({ maxAgentSteps: integer("maxAgentSteps", v, 1, 500) }),
  },
  compactThreshold: {
    read: (s) => s.compactThreshold,
    write: (v) => ({ compactThreshold: integer("compactThreshold", v, 10_000, 5_000_000, true) }),
  },
  memoryInject: boolean("memoryInject"),
  // Navigateur de l'agent : sa fenêtre se montre (sans prendre le focus) ou reste cachée pendant qu'il navigue.
  browserVisible: boolean("browserVisible"),
  // Session gardée sur disque : l'agent agira avec les comptes ouverts dans cette fenêtre. L'activer demande une confirmation native.
  browserPersistent: {
    read: (s) => s.browserPersistent,
    write: (v) => (typeof v === "boolean" ? { browserPersistent: v } : bad("browserPersistent", "booléen attendu")),
    confirm: (patch, current) =>
      patch.browserPersistent === true && !current.browserPersistent
        ? {
            message: "Garder les connexions du navigateur de l'agent ?",
            detail:
              "Les cookies et les connexions faites dans la fenêtre de l'agent seront gardés sur ce disque, d'une fois à l'autre. L'agent pourra alors agir avec les comptes que vous y avez ouverts (sur accord, outil par outil). " +
              "Cette session est propre à l'agent : ce n'est ni votre navigateur ni celle de Jarod. « Oublier » l'efface à tout moment.",
            action: "Garder les connexions",
          }
        : null,
  },
  // Zone de notification (SPECS-P5-TRAY.md) : DEUX booléens seulement ; `trayHintShown` s'écrit par le main, jamais ici. `launchAtLogin` écrit l'entrée de démarrage de la
  // SESSION Windows (un réglage système) : version empaquetée seulement, boîte native pour l'allumer, et ce qui s'affiche est l'état du SYSTÈME.
  desktop: {
    read: (s, env) => {
      const login = launchAtLoginView(env.login);
      return { closeToTray: s.desktop.closeToTray, launchAtLogin: login.value, launchAtLoginAvailable: login.available };
    },
    write: (v, current, env) => {
      const o = record("desktop", v, ["closeToTray", "launchAtLogin"]);
      const next = { ...current.desktop };
      if (o.closeToTray !== undefined) next.closeToTray = typeof o.closeToTray === "boolean" ? o.closeToTray : bad("desktop.closeToTray", "booléen attendu");
      if (o.launchAtLogin !== undefined) {
        if (typeof o.launchAtLogin !== "boolean") bad("desktop.launchAtLogin", "booléen attendu");
        const refusal = o.launchAtLogin ? launchAtLoginRefusal(env.login) : null;
        if (refusal) bad("desktop.launchAtLogin", refusal);
        next.launchAtLogin = o.launchAtLogin as boolean;
      }
      return { desktop: next };
    },
    confirm: (patch, _current, env) =>
      patch.desktop?.launchAtLogin === true && !launchAtLoginView(env.login).value
        ? {
            message: "Démarrer Jarod-One avec Windows ?",
            detail: "Jarod-One s'ajoutera au démarrage de votre session Windows et se lancera dans la zone de notification, sans montrer sa fenêtre. Vous pouvez le retirer à tout moment ici, ou dans les applications de démarrage de Windows.",
            action: "Ajouter au démarrage",
          }
        : null,
    apply: (patch, _current, env) => {
      const want = patch.desktop?.launchAtLogin;
      if (want === undefined) return;
      // Hors version empaquetée « éteindre » n'a rien à retirer : seul le réglage change, le système n'est pas touché.
      if (launchAtLoginRefusal(env.login)) return;
      if (launchAtLoginView(env.login).value !== want) setLaunchAtLogin(env.login, want);
    },
  },
  autoTitle: boolean("autoTitle"),
  anthropicFallbacks: boolean("anthropicFallbacks"),
  toolSearch: oneOf("toolSearch", ["auto", "on", "off"]),
  sessionBudget: {
    // `perSession` (plafonds levés par `/budget` pour une conversation) n'est PAS exposé ici : il se règle dans la conversation.
    read: (s) => ({ maxTokens: s.sessionBudget.maxTokens, maxCostUsd: s.sessionBudget.maxCostUsd }),
    write: (v, current) => {
      const o = record("sessionBudget", v, ["maxTokens", "maxCostUsd"]);
      return {
        sessionBudget: {
          ...current.sessionBudget,
          ...(o.maxTokens === undefined ? {} : { maxTokens: integer("sessionBudget.maxTokens", o.maxTokens, 1, 1_000_000_000, true) }),
          ...(o.maxCostUsd === undefined ? {} : { maxCostUsd: money("sessionBudget.maxCostUsd", o.maxCostUsd) }),
        },
      };
    },
  },
  // ── Sécurité ───────────────────────────────────────────────────────────────────────────────────────────
  // AV2-008 : les règles de l'utilisateur du garde de permissions unifié, relues à chaud par plugin-permissions.
  // Écriture large (l'écran est la seule source), mais bornée et VALIDÉE par le MÊME schéma Zod que le plugin ;
  // ce qui AFFAIBLIT la politique en vigueur exige la confirmation native qui liste les changements, un par un.
  permissionsRules: {
    read: (s) => s.permissionsRules.map((r) => ({ ...r })),
    write: (v) => {
      if (!Array.isArray(v)) return bad("permissionsRules", "liste de règles attendue");
      if (v.length > MAX_PERMISSION_RULES) return bad("permissionsRules", `au plus ${MAX_PERMISSION_RULES} règles`);
      const seen = new Set<string>();
      const rules = v.map((raw, i) => {
        const o = record(`permissionsRules[${i}]`, raw, ["tool", "decision", "target", "expiresAt"]);
        const parsed = PermissionRule.safeParse(o);
        if (!parsed.success) return bad(`permissionsRules[${i}]`, parsed.error.issues[0]!.message);
        const tool = parsed.data.tool.trim();
        if (tool !== parsed.data.tool || tool.length > 64) bad(`permissionsRules[${i}].tool`, "nom d'outil borné à 64 caractères, sans espace autour");
        if (!ruleToolOk(tool)) bad(`permissionsRules[${i}].tool`, "nom d'outil, segment de famille ou « * » (lettres, chiffres, . _ / -)");
        // Cockpit, lot 2 : une cible (motif, `*` = toute suite) et une échéance (autorisation temporaire), optionnelles.
        const target = parsed.data.target;
        if (target !== undefined && (target !== target.trim() || /[\u0000-\u001f]/.test(target))) bad(`permissionsRules[${i}].target`, "cible sans espace autour ni caractère de contrôle");
        const expiresAt = parsed.data.expiresAt;
        if (expiresAt !== undefined && (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_TEMPORARY_MS)) bad(`permissionsRules[${i}].expiresAt`, "échéance dans le futur, à 30 jours au plus");
        const key = target === undefined ? tool : `${tool} sur ${target}`;
        if (seen.has(key)) bad(`permissionsRules[${i}].tool`, `règle en double : ${key} (l'ordre compte, une règle n'apparaît qu'une fois)`);
        seen.add(key);
        return { tool, decision: parsed.data.decision, ...(target !== undefined ? { target } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
      });
      return { permissionsRules: rules };
    },
    confirm: (patch, current) => {
      const changes = rulesWeakenings(current.permissionsRules, patch.permissionsRules ?? current.permissionsRules);
      if (!changes.length) return null;
      return {
        message: "Affaiblir le garde de permissions ?",
        detail: `${changes.map((c) => `• ${c}`).join("\n")}\n\nL'agent pourra faire ce que ces règles lui interdisaient ou lui demandaient jusque-là. Le garde du shell, le mode Plan et l'accord des outils sensibles continuent de s'appliquer. Vous pourrez rétablir à tout moment dans Réglages › Sécurité.`,
        action: "Affaiblir les permissions",
      };
    },
  },
  // Le garde de `run_shell`. Tout ce qui l'AFFAIBLIT exige une confirmation native qui liste les changements ; le durcir n'en demande aucune.
  shellGuard: {
    read: (s) => effectiveShell(s.shellGuard),
    write: (v, current) => {
      const o = record("shellGuard", v, ["writeScope", "writableRoots", "readRoots", "allowedPrograms", "deniedPrograms", "askPrograms", "environment", "docker"]);
      const base = effectiveShell(current.shellGuard);
      const next = { ...base, docker: { ...base.docker } };
      if (o.writeScope !== undefined) {
        if (o.writeScope !== "off" && o.writeScope !== "workspace") bad("shellGuard.writeScope", "off ou workspace");
        next.writeScope = o.writeScope as "off" | "workspace";
      }
      if (o.environment !== undefined) {
        if (o.environment !== "local" && o.environment !== "docker") bad("shellGuard.environment", "local ou docker");
        next.environment = o.environment as "local" | "docker";
      }
      if (o.writableRoots !== undefined) next.writableRoots = stringList("shellGuard.writableRoots", o.writableRoots, 20, 200, rootOk);
      if (o.readRoots !== undefined) next.readRoots = stringList("shellGuard.readRoots", o.readRoots, 20, 260, readRootOk);
      for (const k of ["allowedPrograms", "deniedPrograms", "askPrograms"] as const) {
        if (o[k] !== undefined) next[k] = stringList(`shellGuard.${k}`, o[k], 100, 260, programOk);
      }
      if (o.docker !== undefined) {
        const d = record("shellGuard.docker", o.docker, ["image", "network", "memory", "cpus"]);
        if (d.image !== undefined) {
          next.docker.image = text("shellGuard.docker.image", d.image, 200, false);
          const why = imageOk(next.docker.image);
          if (why) bad("shellGuard.docker.image", why);
        }
        if (d.network !== undefined) {
          if (typeof d.network !== "boolean") bad("shellGuard.docker.network", "booléen attendu");
          next.docker.network = d.network as boolean;
        }
        if (d.memory !== undefined) {
          const m = text("shellGuard.docker.memory", d.memory, 12);
          if (m && !/^\d{1,6}[kmg]?$/i.test(m)) bad("shellGuard.docker.memory", "une taille comme 512m ou 4g (vide : aucune limite)");
          next.docker.memory = m.toLowerCase();
        }
        if (d.cpus !== undefined) {
          if (typeof d.cpus !== "number" || !Number.isFinite(d.cpus) || d.cpus < 0 || d.cpus > 256) bad("shellGuard.docker.cpus", "entre 0 (aucune limite) et 256");
          next.docker.cpus = d.cpus as number;
        }
      }
      return { shellGuard: next };
    },
    confirm: (patch, current) => {
      const changes = shellWeakenings(effectiveShell(current.shellGuard), effectiveShell(patch.shellGuard));
      if (!changes.length) return null;
      return {
        message: "Affaiblir le garde du shell ?",
        detail: `${changes.map((c) => `• ${c}`).join("\n")}\n\nL'agent pourra faire ce que le garde lui interdisait jusque-là. Vous pourrez le rétablir à tout moment dans Réglages › Sécurité.`,
        action: "Affaiblir le garde",
      };
    },
  },
  // Le navigateur connecté (E2) : éteint et vide par défaut. Aucune clé pour un profil, un chemin de navigateur ou un moteur : le navigateur est toujours un Chrome jetable.
  connectedBrowser: {
    read: (s) => effectiveBrowser(s.connectedBrowser),
    write: (v, current) => {
      const o = record("connectedBrowser", v, ["enabled", "allowDomains", "denyDomains"]);
      const next = effectiveBrowser(current.connectedBrowser);
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== "boolean") bad("connectedBrowser.enabled", "booléen attendu");
        next.enabled = o.enabled as boolean;
      }
      if (o.allowDomains !== undefined) next.allowDomains = domainList("connectedBrowser.allowDomains", o.allowDomains);
      if (o.denyDomains !== undefined) next.denyDomains = domainList("connectedBrowser.denyDomains", o.denyDomains);
      return { connectedBrowser: next };
    },
    confirm: (patch, current) => {
      const changes = browserWeakenings(effectiveBrowser(current.connectedBrowser), effectiveBrowser(patch.connectedBrowser));
      if (!changes.length) return null;
      return {
        message: "Activer ou élargir le navigateur connecté ?",
        detail: `${changes.map((c) => `• ${c}`).join("\n")}\n\nL'agent pourra DEMANDER des actions sur ces domaines, dans un navigateur jetable (jamais votre profil). Chaque action — lecture comprise — vous demandera tout de même votre accord, avec la cible exacte, et ne vaudra que pour cette action. Vous pourrez tout retirer dans Réglages › Sécurité.`,
        action: "Autoriser ces domaines",
      };
    },
  },
  // ── Recherche dans les documents (RAG) ─────────────────────────────────────────────────────────────────
  rag: {
    // Les chemins des analyseurs (`doclingPython`, `doclingWorker`, `pdfiumWorker`) ne sont PAS exposés : ce sont des chemins de programmes, jamais
    // saisis depuis le renderer.
    read: (s) => ({ enabled: s.rag.enabled, embeddingsUrl: s.rag.embeddingsUrl, embeddingsModel: s.rag.embeddingsModel, chunkSize: s.rag.chunkSize, chunkOverlap: s.rag.chunkOverlap, maxChunksPerDoc: s.rag.maxChunksPerDoc, topK: s.rag.topK }),
    write: (v, current) => {
      const o = record("rag", v, ["enabled", "embeddingsUrl", "embeddingsModel", "chunkSize", "chunkOverlap", "maxChunksPerDoc", "topK"]);
      const next = { ...current.rag };
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== "boolean") bad("rag.enabled", "booléen attendu");
        next.enabled = o.enabled as boolean;
      }
      if (o.embeddingsUrl !== undefined) next.embeddingsUrl = embeddingsUrlOf("rag.embeddingsUrl", o.embeddingsUrl).url;
      if (o.embeddingsModel !== undefined) next.embeddingsModel = text("rag.embeddingsModel", o.embeddingsModel, 200);
      if (o.chunkSize !== undefined) next.chunkSize = integer("rag.chunkSize", o.chunkSize, 100, 4000);
      if (o.chunkOverlap !== undefined) next.chunkOverlap = integer("rag.chunkOverlap", o.chunkOverlap, 0, 1000);
      if (o.maxChunksPerDoc !== undefined) next.maxChunksPerDoc = integer("rag.maxChunksPerDoc", o.maxChunksPerDoc, 1, 20);
      if (o.topK !== undefined) next.topK = integer("rag.topK", o.topK, 1, 50);
      // Le recouvrement ne dépasse jamais la moitié d'un morceau (sinon chaque morceau n'avancerait que d'un caractère) : refusé, pas ramené.
      if (next.chunkOverlap > Math.floor(next.chunkSize / 2)) bad("rag.chunkOverlap", `au plus la moitié de la taille d'un morceau (${Math.floor(next.chunkSize / 2)})`);
      return { rag: next };
    },
    // Envoyer les textes des documents à une adresse HORS de cette machine : confirmation native qui la nomme.
    confirm: (patch, current) => {
      const url = patch.rag?.embeddingsUrl ?? "";
      if (!url || url === current.rag.embeddingsUrl || embeddingsUrlOf("rag.embeddingsUrl", url).local) return null;
      return {
        message: "Envoyer vos documents à cette adresse pour les indexer ?",
        detail: `${new URL(url).host}\n\nChaque morceau de document indexé est envoyé à ce serveur pour en calculer l'empreinte, hors de cette machine. Laissez vide pour garder tout en local.`,
        action: "Autoriser l'envoi",
      };
    },
  },
  // Les moteurs de l'écosystème (PLAN §10) : chacun a ses barres de décision (DECISIONS.md) ; l'écran n'en contourne aucune, il règle les mêmes
  // interrupteurs que `settings.ecosystem`, validés par le MÊME schéma. Un changement vers un moteur qui change ce que la recherche sert demande une boîte.
  ecosystem: {
    read: (s) => ecosystemFlags(s.ecosystem),
    write: (v, current) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return bad("ecosystem", "objet attendu");
      const parsed = EcosystemFlags.safeParse({ ...ecosystemFlags(current.ecosystem), ...(v as object) });
      if (!parsed.success) {
        const i = parsed.error.issues[0]!;
        return bad(`ecosystem${i.path.length ? `.${i.path.join(".")}` : ""}`, i.code === "unrecognized_keys" ? `clé(s) inconnue(s) : ${(i as { keys?: string[] }).keys?.join(", ")}` : i.message);
      }
      return { ecosystem: parsed.data };
    },
    confirm: (patch, current) => {
      const before = new Set(ecosystemServes(ecosystemFlags(current.ecosystem)));
      const added = ecosystemServes(ecosystemFlags(patch.ecosystem)).filter((x) => !before.has(x));
      if (!added.length) return null;
      return {
        message: "Activer ces moteurs de recherche ?",
        detail: `${added.map((a) => `• ${a}`).join("\n")}\n\nIls changent ce que la recherche sert ou ce qui s'exécute, et ont chacun leurs conditions (modèles installés, fichiers de configuration du profil) et leurs barres de décision (DECISIONS.md). Un moteur dont une condition manque se replie sur la pile d'avant.`,
        action: "Activer",
      };
    },
  },
  // ── Connexions ─────────────────────────────────────────────────────────────────────────────────────────
  // Pont téléphone : SEUL le port se règle ici (les appareils appairés et leurs jetons ne sont jamais exposés ; l'allumage a son canal et sa boîte).
  mobile: {
    read: (s) => ({ port: s.mobile.port }),
    write: (v, current) => {
      const o = record("mobile", v, ["port"]);
      return { mobile: { ...current.mobile, ...(o.port === undefined ? {} : { port: integer("mobile.port", o.port, 1024, 65535) }) } };
    },
  },
  // Approvals on the phone too: what a tool would do (its name and arguments) reaches the paired app, end-to-end encrypted. Turning it on asks first.
  phoneApprovals: {
    read: (s) => s.phoneApprovals === true,
    write: (v) => (typeof v === "boolean" ? { phoneApprovals: v } : bad("phoneApprovals", "booléen attendu")),
    confirm: (patch, current) =>
      patch.phoneApprovals === true && current.phoneApprovals !== true
        ? {
            message: "Envoyer aussi les demandes d'accord au téléphone ?",
            detail:
              "Quand Jarod demande votre accord (conversation sur ce PC, tâche planifiée, messagerie), la demande — l'outil et ses arguments — part aussi vers les téléphones appairés, chiffrée de bout en bout. " +
              "La première réponse, ici ou sur le téléphone, l'emporte ; autoriser sur le téléphone demande l'empreinte. Une décision vaut pour une seule demande. Sans réponse, c'est refusé.",
            action: "Envoyer au téléphone",
          }
        : null,
  },
  // Cockpit, lot 4 — billion-context : proxy LOCAL de compression de l'historique, pour les fournisseurs nommés. Bouclage seulement ;
  // l'allumer (ou y ajouter un fournisseur) fait transiter les conversations par un autre programme : confirmation native.
  contextProxy: {
    read: (s) => ({ ...s.contextProxy, providers: [...s.contextProxy.providers] }),
    write: (v, current) => {
      const o = record("contextProxy", v, ["enabled", "url", "providers"]);
      const next = { ...current.contextProxy };
      if (o.enabled !== undefined) next.enabled = o.enabled === true ? true : o.enabled === false ? false : bad("contextProxy.enabled", "booléen attendu");
      if (o.url !== undefined) {
        if (typeof o.url !== "string" || !isLoopbackUrl(o.url.trim())) bad("contextProxy.url", "adresse http de bouclage attendue (http://127.0.0.1:<port>), sans chemin");
        next.url = String(o.url).trim().replace(/\/+$/, "");
      }
      if (o.providers !== undefined) {
        if (!Array.isArray(o.providers) || o.providers.length > 32 || !o.providers.every((p) => typeof p === "string" && /^[a-z0-9-]{1,40}$/.test(p))) bad("contextProxy.providers", "liste d'identifiants de fournisseurs");
        next.providers = [...new Set(o.providers as string[])].sort();
      }
      return { contextProxy: next };
    },
    confirm: (patch, current) => {
      const n = patch.contextProxy;
      if (!n?.enabled) return null;
      const added = n.providers.filter((p) => !(current.contextProxy.enabled && current.contextProxy.providers.includes(p)));
      if (!added.length && current.contextProxy.enabled && current.contextProxy.url === n.url) return null;
      return {
        message: "Faire passer les conversations par billion-context ?",
        detail: `Les requêtes vers ${n.providers.join(", ") || "(aucun fournisseur)"} passeront par le programme local ${n.url} (billion-context), qui compresse l'historique puis transmet au fournisseur. Jarod ne compacte plus lui-même ces conversations. Lancez ce programme avec ses mises à jour automatiques coupées (ACP_AUTO_UPDATE=0).`,
        action: "Passer par le proxy",
      };
    },
  },
  // Android : SEUL le délai se règle ici ; le programme adb se choisit dans la boîte native (`android-set-adb`).
  android: {
    read: (s) => ({ timeoutMs: s.android.timeoutMs }),
    write: (v, current) => {
      const o = record("android", v, ["timeoutMs"]);
      return { android: { ...current.android, ...(o.timeoutMs === undefined ? {} : { timeoutMs: integer("android.timeoutMs", o.timeoutMs, 1000, 120_000) }) } };
    },
  },
  // API compatible OpenAI : port et hôte ; l'interrupteur et la clé ont leurs canaux (`api-server-set`, `api-server-new-key`). Ouvrir au RÉSEAU = confirmation.
  apiServer: {
    read: (s) => ({ port: s.apiServer.port, host: s.apiServer.host }),
    write: (v, current) => {
      const o = record("apiServer", v, ["port", "host"]);
      const next = { ...current.apiServer };
      if (o.port !== undefined) next.port = integer("apiServer.port", o.port, 1024, 65535);
      if (o.host !== undefined) {
        if (o.host !== "127.0.0.1" && o.host !== "0.0.0.0") bad("apiServer.host", "127.0.0.1 (cette machine) ou 0.0.0.0 (le réseau local)");
        next.host = o.host as "127.0.0.1" | "0.0.0.0";
      }
      return { apiServer: next };
    },
    confirm: (patch, current) =>
      patch.apiServer?.host === "0.0.0.0" && current.apiServer.host !== "0.0.0.0"
        ? {
            message: "Ouvrir l'API au réseau local ?",
            detail: "Tout appareil du réseau pourra joindre l'API de Jarod (il lui faudra la clé). L'agent y reste en lecture seule. À n'ouvrir que sur un réseau de confiance.",
            action: "Ouvrir au réseau",
          }
        : null,
  },
  // ── Modèles ────────────────────────────────────────────────────────────────────────────────────────────
  fallbacks: {
    read: (s) => s.fallbacks.map((f) => ({ provider: f.provider, ...(f.model ? { model: f.model } : {}) })),
    write: (v, current, env) => {
      if (!Array.isArray(v)) return bad("fallbacks", "liste attendue");
      if (v.length > MAX_FALLBACKS) return bad("fallbacks", `au plus ${MAX_FALLBACKS} entrées`);
      const seen = new Set<string>([`${current.activeProvider}\u0000${current.activeModel}`]);
      const chain = v.map((item, i) => {
        const o = record(`fallbacks[${i}]`, item, ["provider", "model"]);
        const provider = text(`fallbacks[${i}].provider`, o.provider, 80, false);
        env.provider(provider); // lève : fournisseur inconnu
        const model = o.model === undefined || o.model === "" ? undefined : text(`fallbacks[${i}].model`, o.model, 200);
        const key = `${provider}\u0000${model ?? current.activeModel}`;
        if (seen.has(key)) bad(`fallbacks[${i}]`, "doublon (ou identique au modèle actif)");
        seen.add(key);
        return { provider, ...(model ? { model } : {}) };
      });
      return { fallbacks: chain };
    },
    // Basculer envoie la conversation à un autre fournisseur : un fournisseur qui sort de la machine et qui n'était pas déjà
    // nommé demande une confirmation native qui le NOMME.
    confirm: (patch, current, env) => {
      const known = new Set([current.activeProvider, ...current.fallbacks.map((f) => f.provider)]);
      const added = [...new Set((patch.fallbacks ?? []).map((f) => f.provider))].filter((p) => !known.has(p) && env.provider(p).leavesMachine);
      if (!added.length) return null;
      return {
        message: `Envoyer vos conversations à ${added.map((p) => env.provider(p).name).join(", ")} en cas de panne ?`,
        detail:
          "Si le modèle actif échoue (quota, panne, clé refusée), Jarod enverra la conversation EN COURS — messages, résultats d'outils et contenus lus — à ce fournisseur, hors de cette machine. " +
          "Rien ne bascule vers un fournisseur que vous n'avez pas nommé. Retirez-le à tout moment dans Réglages › Modèles.",
        action: "Autoriser le repli",
      };
    },
  },
  imageDescription: {
    read: (s) => ({ mode: s.imageDescription.mode, provider: s.imageDescription.provider, model: s.imageDescription.model }),
    write: (v, current, env) => {
      const o = record("imageDescription", v, ["mode", "provider", "model"]);
      const next = { ...current.imageDescription };
      if (o.mode !== undefined) {
        if (typeof o.mode !== "string" || !["auto", "always", "off"].includes(o.mode)) bad("imageDescription.mode", "une valeur parmi auto, always, off");
        next.mode = o.mode as typeof next.mode;
      }
      if (o.provider !== undefined) {
        next.provider = text("imageDescription.provider", o.provider, 80);
        if (next.provider) env.provider(next.provider);
        else next.model = ""; // sans fournisseur, rien n'est décrit : pas de modèle orphelin
      }
      if (o.model !== undefined) next.model = text("imageDescription.model", o.model, 200);
      if (next.model && !next.provider) bad("imageDescription.model", "un modèle exige un fournisseur");
      return { imageDescription: next };
    },
    // Décrire une image envoie l'image au fournisseur choisi : un fournisseur qui sort de la machine demande une confirmation.
    confirm: (patch, current, env) => {
      const next = patch.imageDescription;
      if (!next || next.mode === "off" || !next.provider || next.provider === current.imageDescription.provider) return null;
      const p = env.provider(next.provider);
      if (!p.leavesMachine) return null;
      return {
        message: `Envoyer vos images à ${p.name} pour les décrire ?`,
        detail: "Quand le modèle de la conversation ne voit pas les images, Jarod les envoie à ce fournisseur, hors de cette machine, pour en obtenir une description. Vous pouvez désactiver cette fonction à tout moment (Réglages › Modèles).",
        action: "Autoriser l'envoi",
      };
    },
  },
  // La voix de la conversation parlée : le fournisseur de transcription (liste fermée : ceux qui ont un point d'accès de transcription), son modèle, la voix et le débit de
  // la synthèse locale. `autoSpeak` (lire les réponses sur le haut-parleur DU NOYAU) n'est pas ici : la fenêtre joue elle-même la voix.
  voice: {
    read: (s) => ({ sttProvider: s.voice.sttProvider, sttModel: s.voice.sttModel, ttsVoice: s.voice.ttsVoice, ttsRate: s.voice.ttsRate }),
    write: (v, current, env) => {
      const o = record("voice", v, ["sttProvider", "sttModel", "ttsVoice", "ttsRate"]);
      const next = { ...current.voice };
      if (o.sttProvider !== undefined) {
        const id = text("voice.sttProvider", o.sttProvider, 80, false);
        if (!Object.hasOwn(STT_DEFAULTS, id)) bad("voice.sttProvider", `un fournisseur de transcription parmi ${Object.keys(STT_DEFAULTS).join(", ")}`);
        env.provider(id); // lève : fournisseur inconnu
        next.sttProvider = id;
      }
      if (o.sttModel !== undefined) next.sttModel = text("voice.sttModel", o.sttModel, 200);
      if (o.ttsVoice !== undefined) next.ttsVoice = text("voice.ttsVoice", o.ttsVoice, 200);
      if (o.ttsRate !== undefined) {
        if (typeof o.ttsRate !== "number" || !Number.isFinite(o.ttsRate) || o.ttsRate < 0.25 || o.ttsRate > 4) bad("voice.ttsRate", "entre 0,25 et 4");
        next.ttsRate = o.ttsRate as number;
      }
      return { voice: next };
    },
    // Transcrire envoie ce que vous dites (l'enregistrement) au fournisseur : un fournisseur qui sort de la machine et qui change demande une confirmation qui le NOMME.
    confirm: (patch, current, env) => {
      const next = patch.voice?.sttProvider;
      if (!next || next === current.voice.sttProvider) return null;
      const p = env.provider(next);
      if (!p.leavesMachine) return null;
      return {
        message: `Envoyer vos enregistrements vocaux à ${p.name} ?`,
        detail: "Pour transformer votre voix en texte, Jarod envoie chaque énoncé enregistré à ce fournisseur, hors de cette machine. Choisissez un serveur de cette machine (whisper.cpp, LM Studio) pour que la voix ne parte pas.",
        action: "Autoriser l'envoi",
      };
    },
  },
  learning: {
    read: (s) => ({ enabled: s.learning.enabled, reviewEvery: s.learning.reviewEvery }),
    write: (v, current) => {
      const o = record("learning", v, ["enabled", "reviewEvery"]);
      if (o.enabled !== undefined && typeof o.enabled !== "boolean") bad("learning.enabled", "booléen attendu");
      return {
        learning: {
          ...current.learning,
          ...(o.enabled === undefined ? {} : { enabled: o.enabled as boolean }),
          ...(o.reviewEvery === undefined ? {} : { reviewEvery: integer("learning.reviewEvery", o.reviewEvery, 1, 1000) }),
        },
      };
    },
  },
};

/** Un fournisseur « sort de la machine » sauf s'il est local par le catalogue ou s'il pointe sur la boucle locale. */
function leavesMachine(def: { local?: boolean; baseUrl: string }): boolean {
  if (def.local) return false;
  try {
    const host = new URL(def.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return !(host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch {
    return true;
  }
}

export function createJarodSettingsHandlers(ctx: HandlerContext) {
  const settings = () => ctx.kernel().agent.settings;
  const env = (): Env => ({
    provider(id) {
      let def: { name: string; local?: boolean; baseUrl: string };
      try {
        def = ctx.kernel().agent.providers.def(id);
      } catch {
        throw new Error(`[oneai] fournisseur inconnu : ${id}`);
      }
      return { name: def.name, leavesMachine: leavesMachine(def) };
    },
    shells: () => shellsOf(ctx),
    login: ctx.shell.loginItems,
  });
  const snapshot = (): Record<string, unknown> => {
    const all = settings().getAll();
    return Object.fromEntries(Object.entries(ENTRIES).map(([k, e]) => [k, e.read(all, env())]));
  };

  return {
    "get-jarod-settings": (): Record<string, unknown> => snapshot(),
    /** Efface la session du navigateur de l'agent (cookies, connexions, cache) : confirmation native, « Annuler » par défaut. */
    "agent-browser-forget": async (): Promise<boolean> => {
      if (!ctx.agentBrowser) throw new Error("[oneai] navigateur de l'agent indisponible dans ce mode");
      if (!ctx.shell.confirm) throw new Error("[oneai] confirmation native indisponible, refusé");
      const ok = await ctx.shell.confirm(
        "Oublier le navigateur de l'agent ?",
        "Ses cookies, ses connexions et son cache sont effacés, et sa fenêtre est fermée. Vos propres navigateurs ne sont pas touchés.",
        "Oublier",
      );
      if (!ok) return false;
      await ctx.agentBrowser.forget();
      return true;
    },
    /** Les listes dont les écrans ont besoin pour proposer un choix (jamais de clé ni de secret). */
    "get-jarod-options": async (): Promise<{ providers: { id: string; name: string; local: boolean; configured: boolean; models: string[] }[]; shells: { path: string; name: string }[]; shellGuardText: string; sttProviders: { id: string; name: string; local: boolean; configured: boolean; defaultModel: string }[]; voices: string[] }> => ({
      shells: shellsOf(ctx),
      // Les fournisseurs de transcription (ceux qui ont un point d'accès « audio/transcriptions ») et les voix de la machine (SAPI, Piper) : de quoi proposer un choix.
      sttProviders: ctx
        .kernel()
        .agent.providers.list()
        .filter((p) => Object.hasOwn(STT_DEFAULTS, p.id))
        .map((p) => ({ id: p.id, name: p.name, local: !leavesMachine(p), configured: p.configured, defaultModel: STT_DEFAULTS[p.id]! })),
      voices: (await ctx.kernel().voice?.speech.voices().catch(() => [] as string[])) ?? [],
      // Le texte de `/shell-guard` : EXACTEMENT ce qui s'applique, mécanisme de confinement de cette machine compris.
      shellGuardText: describeShellGuard(settings().getAll()).replace(/\*\*|`/g, ""),
      providers: ctx
        .kernel()
        .agent.providers.list()
        .map((p) => ({ id: p.id, name: p.name, local: !leavesMachine(p), configured: p.configured, models: [...p.models] })),
    }),
    /** `patch` : { clé: valeur } ; rend l'état relu après écriture. */
    "set-jarod-settings": async (patch: unknown): Promise<Record<string, unknown>> => {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("[oneai] set-jarod-settings : objet { clé: valeur } attendu");
      const entries = Object.entries(patch);
      const unknown = entries.filter(([k]) => !Object.hasOwn(ENTRIES, k)).map(([k]) => k);
      if (unknown.length) throw new Error(`[oneai] set-jarod-settings : réglage(s) non géré(s) : ${unknown.join(", ")}`);
      const current = settings().getAll();
      const e = env();
      // 1) tout valider ; 2) confirmer (natif) ce qui accroît le pouvoir de l'agent ou envoie des données ailleurs ; 3) écrire d'un bloc.
      const merged: Patch = {};
      const applies: (() => void)[] = [];
      for (const [k, v] of entries) {
        const entry = ENTRIES[k]!;
        const part = entry.write(v, current, e);
        const ask = entry.confirm?.(part, current, e);
        if (ask) {
          if (!ctx.shell.confirm) throw new Error(`[oneai] réglage « ${k} » : confirmation native indisponible, refusé`);
          if (!(await ctx.shell.confirm(ask.message, ask.detail, ask.action))) throw new Error(`[oneai] réglage « ${k} » : refusé par l'utilisateur`);
        }
        Object.assign(merged, part);
        applies.push(() => entry.apply?.(part, current, e));
      }
      for (const run of applies) run(); // le système d'abord : s'il refuse, rien n'est écrit
      settings().patch(merged);
      return snapshot();
    },
  };
}
