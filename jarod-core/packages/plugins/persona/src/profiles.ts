// Portage de packages/core/src/services/profiles.ts (rév. 2e180305).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Le nom du dossier des profils sous une racine — écrit une fois, pour les deux usages ci-dessous. */
const PROFILES_DIR = "profiles";

/**
 * Racine de l'arbre de profils auquel appartient un dossier de données (`<racine>/profiles/<nom>`),
 * ou `null` quand ce dossier n'appartient à aucun arbre — un core ouvert sur un dossier autonome est
 * valide : c'est l'arbre qui décide du profil actif, pas le core.
 */
export function profilesRootFor(dataDir: string): string | null {
  if (basename(dirname(dataDir)) !== PROFILES_DIR) return null;
  const root = dirname(dirname(dataDir));
  return existsSync(join(root, "profile.json")) ? root : null;
}

/**
 * Le nom de dossier d'un profil : des minuscules, des chiffres, « - » et « _ ». Tout le reste devient
 * « - », et les tirets des extrémités tombent.
 *
 * C'est la MÊME règle pour les DEUX usages, et c'est le point : `create()` s'en sert pour fabriquer un
 * nom, `dirFor()` pour VÉRIFIER celui qu'on lui donne. Écrite deux fois, elle finirait par diverger —
 * et c'est exactement par l'écart entre les deux qu'un nom non conforme passerait d'un côté.
 */
function nomDeProfil(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Profiles are fully isolated environments (database, skills, plugins) living in
 * `<root>/profiles/<name>/`. Switching profile means re-creating the core on another dir.
 */
export class ProfileManager {
  private readonly profilesDir: string;
  private readonly stateFile: string;

  constructor(readonly root: string) {
    this.profilesDir = join(root, PROFILES_DIR);
    this.stateFile = join(root, "profile.json");
    mkdirSync(this.profilesDir, { recursive: true });
    if (this.list().length === 0) this.create("default");
  }

  list(): string[] {
    return readdirSync(this.profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  active(): string {
    try {
      const { active } = JSON.parse(readFileSync(this.stateFile, "utf8")) as { active?: string };
      if (active && this.list().includes(active)) return active;
    } catch {
      /* first run */
    }
    return this.list()[0] ?? "default";
  }

  setActive(name: string): void {
    if (!this.list().includes(name)) throw new Error(`Profil inconnu : ${name}`);
    writeFileSync(this.stateFile, JSON.stringify({ active: name }), "utf8");
  }

  create(name: string): string {
    const safe = nomDeProfil(name);
    if (!safe) throw new Error("Nom de profil invalide");
    const dir = join(this.profilesDir, safe);
    if (existsSync(dir)) throw new Error(`Le profil « ${safe} » existe déjà`);
    mkdirSync(dir, { recursive: true });
    return safe;
  }

  /**
   * Le dossier d'un profil — CONFINÉ, exactement comme le nom l'est déjà à la création.
   *
   * `create()` slugue le nom qu'on lui donne ; `dirFor()`, lui, se contentait de le joindre. Un nom
   * non conforme traversait donc : « .. » remontait d'un cran, « a/b » désignait un sous-dossier, et
   * un chemin absolu sortait carrément du dossier des profils. Rien ne le montrait parce que TOUS les
   * appelants donnaient un nom déjà relu (`list()`, `active()`) — une garde qui ne tient que par ses
   * appelants n'est pas une garde, c'est une convention.
   *
   * Ici : un nom CONFORME passe (même valeur qu'avant, au caractère près), et un dossier RÉELLEMENT
   * présent sous ce nom exact passe aussi (un profil posé à la main sur le disque reste ouvrable —
   * `list()` le nomme, donc le nommer doit continuer de désigner son dossier). Tout le reste est
   * REFUSÉ. Aucun nom n'est slugué en silence : rendre le dossier d'un AUTRE profil que celui demandé
   * serait un mensonge, pas une politesse.
   */
  dirFor(name: string): string {
    const voulu = name.trim();
    const conforme = nomDeProfil(voulu);
    if (conforme && conforme === voulu) return join(this.profilesDir, voulu);
    if (voulu && this.list().includes(voulu)) return join(this.profilesDir, voulu);
    throw new Error(
      `Nom de profil invalide : « ${name} ». Un profil se nomme en minuscules, chiffres, « - » ou « _ » — ni séparateur de chemin, ni remontée, ni chemin absolu.`,
    );
  }
}
