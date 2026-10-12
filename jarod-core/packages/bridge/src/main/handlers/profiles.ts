/**
 * Profils (D1(b)) : `list-profiles` sur le `ProfileManager` de Jarod (`<racine>/profiles/<nom>`, partagé avec
 * le CLI). Sources (rév. 3aaadb0, MIT © github.com/fathah) : `src/main/ipc/register.ts:2286-2302`,
 * `profiles.ts:36-54` (`ProfileInfo`), `:119-143` (`countSkills`), `:176-260` (`listProfiles`).
 *
 * Écarts assumés :
 * - un kernel sert UN profil : `isActive` = le profil SERVI ; modèle, fournisseur, passerelles et nombre de
 *   skills ne sont connus que pour lui (les autres ont leur base chiffrée fermée : modèle/fournisseur "",
 *   passerelle arrêtée) ; pour les autres, skills comptées sur le disque (`SKILL.md`, découverte récursive
 *   comme le registre Jarod — Q2) ;
 * - `hasEnv` = au moins une clé de fournisseur dans le coffre (profil servi ; Jarod n'a pas de `.env`) ;
 * - métadonnées d'apparence = `profile-meta.json` du dossier du profil, comme SANK-UI (`profile-meta.ts`) ; sans
 *   couleur enregistrée, `color: ""` — les écrans appliquent `defaultColorForName` (`ProfileAvatar.tsx:33`, même
 *   fonction que le main SANK-UI) ; `shared/profileColors.ts` n'est pas importé ici (échec `noUncheckedIndexedAccess`).
 *
 * Écritures (D1(b), suite V1) — sources : `ipc/register.ts:2303-2370`, `profiles.ts:56-99` (`normalizeAgentName`,
 * `slugBaseForAgentName`, `profileIdForAgentName`, repris), `:269-326` (`createProfile` : id dérivé du nom affiché,
 * nom écrit dans `profile-meta.json`), `:328-359` (`deleteProfile`), `:361-399` (`setActiveProfile`),
 * `profile-meta.ts` (lecture filtrée, `HEX_COLOR`, avatar `data:image/` ≤ 1 500 000, nom ≤ 80) ; `utils.ts:13-35`
 * (`PROFILE_NAME_RE`). Écarts assumés :
 * - création = `ProfileManager.create` (dossier vide, comme Jarod-one) au lieu de `hermes profile create` ;
 *   `cloneFrom` REFUSÉ : les clés d'un profil sont dans SA base chiffrée (clé DPAPI propre) — cloner voudrait dire
 *   ouvrir une seconde base (règle de sécurité `list-profiles`) ; jamais un clone partiel présenté comme réussi ;
 * - retrait = le dossier est MIS À L'ÉCART dans `<racine>/profiles-supprimes/<id>.<horodatage>` (base chiffrée,
 *   skills, SOUL.md intacts, récupérables) au lieu d'être effacé ; refusé pour « default » et pour le profil SERVI
 *   (sa base est ouverte) ;
 * - activation = réouverture du kernel sur ce profil (`HandlerContext.switchProfile`) : les conversations de
 *   l'ancien profil ne sont plus servies (refus « profil non servi », jamais servies par le mauvais profil) ;
 *   rend `true` comme SANK-UI, l'échec d'ouverture remonte en erreur (retour au profil précédent) ;
 * - cible inconnue (couleur, nom, avatar, retrait) → `{ success: false }` : SANK-UI crée le dossier en silence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayStatus } from "@jarod/contracts";
import { ProfileManager } from "@jarod/plugin-persona";
import type { HandlerContext } from "./context.js";

/** `profiles.ts:36-54`. */
export interface ProfileInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  provider: string;
  hasEnv: boolean;
  hasSoul: boolean;
  skillCount: number;
  gatewayRunning: boolean;
  color: string;
  avatar: string | null;
}

const GATEWAYS: GatewayStatus["id"][] = ["telegram", "discord", "slack", "email", "whatsapp"];

/** Skills d'un dossier de profil : tout `SKILL.md` sous `skills/`, à toute profondeur. */
function countSkills(profileDir: string): number {
  const walk = (dir: string): number => {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = join(dir, e.name);
      n += existsSync(join(sub, "SKILL.md")) ? 1 : walk(sub);
    }
    return n;
  };
  const root = join(profileDir, "skills");
  try {
    return existsSync(root) ? walk(root) : 0;
  } catch {
    return 0;
  }
}

type Result = { success: boolean; error?: string };
interface CreateProfileResult extends Result {
  id?: string;
}

/** `utils.ts:13-35`. */
const PROFILE_NAME_RE = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const PROFILE_NAME_ERROR = "Profile names may contain lowercase letters, numbers, underscores, and hyphens, and cannot start with a hyphen.";
const isValidNamedProfileName = (profile: unknown): profile is string => typeof profile === "string" && PROFILE_NAME_RE.test(profile);
const isValidProfileName = (profile: unknown): profile is string => profile === "default" || isValidNamedProfileName(profile);

/** `profiles.ts:62-99` (corps repris ; l'existence d'un id est demandée au `ProfileManager`). */
const MAX_PROFILE_NAME_LENGTH = 80;
function normalizeAgentName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_PROFILE_NAME_LENGTH);
}
function slugBaseForAgentName(name: string): string {
  const slug = normalizeAgentName(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!slug || slug === "default" || !isValidNamedProfileName(slug)) {
    return "agent";
  }
  return slug;
}
function profileIdForAgentName(agentName: string, exists: (id: string) => boolean): string {
  const profileIdExists = (id: string) => id === "default" || exists(id);
  const base = slugBaseForAgentName(agentName);
  if (!profileIdExists(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!profileIdExists(candidate)) return candidate;
  }
  return `${base.slice(0, 55)}-${Date.now().toString(36)}`;
}

/** `profile-meta.ts` : `profile-meta.json` du dossier du profil, champs filtrés à la lecture. */
interface ProfileMeta {
  name?: string;
  color?: string;
  avatar?: string;
}
const META_FILE = "profile-meta.json";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_AVATAR_BYTES = 1_500_000;
function readProfileMeta(dir: string): ProfileMeta {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, META_FILE), "utf-8")) as ProfileMeta;
    if (!parsed || typeof parsed !== "object") return {};
    const meta: ProfileMeta = {};
    if (typeof parsed.color === "string" && HEX_COLOR.test(parsed.color)) meta.color = parsed.color;
    if (typeof parsed.avatar === "string" && parsed.avatar.startsWith("data:image/")) meta.avatar = parsed.avatar;
    const rawName = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (rawName) meta.name = rawName.slice(0, 80);
    return meta;
  } catch {
    return {};
  }
}
function writeProfileMeta(dir: string, patch: Partial<ProfileMeta>): void {
  const next: ProfileMeta = { ...readProfileMeta(dir), ...patch };
  for (const k of Object.keys(next) as (keyof ProfileMeta)[]) if (next[k] === undefined) delete next[k];
  writeFileSync(join(dir, META_FILE), JSON.stringify(next, null, 2), "utf-8");
}

export function createProfileHandlers(ctx: HandlerContext) {
  const manager = () => {
    const k = ctx.kernel();
    if (!k) throw new Error("[oneai] profiles : kernel non disponible (profil en cours d'ouverture ou de bascule)");
    return new ProfileManager(k.dataRoot);
  };
  /** Métadonnées d'un profil EXISTANT (nom valide et dossier présent) ; jamais un dossier créé en passant. */
  const patchMeta = (name: unknown, patch: Partial<ProfileMeta>): Result => {
    if (!isValidProfileName(name)) return { success: false, error: PROFILE_NAME_ERROR };
    const profiles = manager();
    if (!profiles.list().includes(name)) return { success: false, error: `Profil inconnu : ${name}` };
    try {
      writeProfileMeta(profiles.dirFor(name), patch);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  };

  return {
    "list-profiles": (): ProfileInfo[] => {
      const k = ctx.kernel();
      if (!k) throw new Error("[oneai] list-profiles : kernel non disponible (profil en cours d'ouverture ou de bascule)");
      const profiles = new ProfileManager(k.dataRoot);
      return profiles.list().map((name) => {
        const path = profiles.dirFor(name);
        const served = name === k.profile;
        const settings = k.agent.settings;
        const meta = readProfileMeta(path);
        return {
          id: name,
          name: meta.name ?? name,
          path,
          isDefault: name === "default",
          isActive: served,
          model: served ? settings.get("activeModel") : "",
          provider: served ? settings.get("activeProvider") : "",
          hasEnv: served && k.agent.providers.list().some((p) => p.hasKey),
          hasSoul: existsSync(join(path, "SOUL.md")),
          skillCount: served ? k.agent.skills.list().length : countSkills(path),
          gatewayRunning: served && GATEWAYS.some((id) => k.gateways.gatewayStatus(id).state === "running"),
          color: meta.color ?? "",
          avatar: meta.avatar ?? null,
        };
      });
    },
    "create-profile": (name: unknown, cloneFrom: unknown): CreateProfileResult => {
      const agentName = normalizeAgentName(typeof name === "string" ? name : "");
      if (!agentName) return { success: false, error: "Agent name is required" };
      if (cloneFrom !== null && cloneFrom !== undefined && cloneFrom !== "")
        return { success: false, error: "Jarod-One ne clone pas un profil : ses clés sont dans sa base chiffrée. Créez un profil vierge." };
      const profiles = manager();
      const id = profileIdForAgentName(agentName, (candidate) => profiles.list().includes(candidate));
      try {
        profiles.create(id);
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
      writeProfileMeta(profiles.dirFor(id), { name: agentName });
      return { success: true, id };
    },
    "delete-profile": (name: unknown): Result => {
      if (name === "default") return { success: false, error: "Cannot delete the default profile" };
      if (!isValidNamedProfileName(name)) return { success: false, error: PROFILE_NAME_ERROR };
      const profiles = manager();
      if (!profiles.list().includes(name)) return { success: false, error: `Profil inconnu : ${name}` };
      if (name === ctx.kernel().profile) return { success: false, error: "Profil ouvert : changez de profil avant de le supprimer." };
      const trash = join(ctx.kernel().dataRoot, "profiles-supprimes");
      try {
        mkdirSync(trash, { recursive: true });
        renameSync(profiles.dirFor(name), join(trash, `${name}.${new Date().toISOString().replace(/[:.]/g, "-")}`));
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
    "set-active-profile": async (name: unknown): Promise<boolean> => {
      if (!isValidProfileName(name)) throw new Error(PROFILE_NAME_ERROR);
      const profiles = manager();
      if (!profiles.list().includes(name)) throw new Error(`Profil inconnu : ${name}`);
      if (name === ctx.kernel().profile) {
        profiles.setActive(name);
        return true;
      }
      if (!ctx.switchProfile) throw new Error("[oneai] changement de profil indisponible");
      await ctx.switchProfile(name);
      return true;
    },
    "set-profile-color": (name: unknown, color: unknown): Result => {
      if (typeof color !== "string" || !HEX_COLOR.test(color)) return { success: false, error: "Invalid colour" };
      return patchMeta(name, { color });
    },
    "set-profile-name": (id: unknown, agentName: unknown): Result => {
      const trimmed = typeof agentName === "string" ? agentName.trim() : "";
      return patchMeta(id, { name: trimmed ? trimmed.slice(0, MAX_PROFILE_NAME_LENGTH) : undefined });
    },
    "set-profile-avatar": (name: unknown, dataUrl: unknown): Result => {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return { success: false, error: "Invalid image" };
      if (dataUrl.length > MAX_AVATAR_BYTES) return { success: false, error: "Image too large" };
      return patchMeta(name, { avatar: dataUrl });
    },
    "remove-profile-avatar": (name: unknown): Result => patchMeta(name, { avatar: undefined }),
    /**
     * D1(b) — `register.ts:963`, `agent-sync.ts:301-315` (`getAgentSyncStatus`) : synchro des agents avec un compte
     * Hermes One. Jarod n'a pas de compte Hermes One : état « déconnecté », rien en cours, aucun résultat (l'écran
     * Agents masque alors la synchro et ne la lance pas).
     */
    "agent-sync-status": () => ({ signedIn: false, accountLabel: null, running: false, lastResult: null }),
  };
}
