/**
 * D3 (winget-cli) — gestion de paquets Windows.
 *
 * Identifiants EXACTS seulement (`Editeur.Paquet`), jamais une ligne construite par un modèle : chaque valeur est validée
 * par une expression stricte, la source est imposée (`winget`), `--exact` est toujours présent, et les options qui
 * changeraient ce qui s'installe ou où (`--custom`, `--override`, `--location`, `--source` libre) n'existent pas ici.
 * Le résultat est un appel pour la porte unique ; installer, mettre à jour et désinstaller sont des actions sensibles.
 */
import { AdapterRefused, type GuardedCall } from "./common.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_+-]{0,60}(?:\.[A-Za-z0-9][A-Za-z0-9_+-]{0,60}){1,3}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,40}$/;
const QUERY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

export type WingetOp = "search" | "show" | "list" | "install" | "upgrade" | "uninstall";
export const WINGET_MUTATING: ReadonlySet<WingetOp> = new Set(["install", "upgrade", "uninstall"]);

export interface WingetRequest {
  op: WingetOp;
  id?: string;
  version?: string;
  query?: string;
}

const COMMON = "--accept-source-agreements --disable-interactivity";

export function wingetCall(req: WingetRequest): GuardedCall & { mutating: boolean } {
  const op = req.op;
  const mutating = WINGET_MUTATING.has(op);
  const timeout = mutating ? 900 : 120;
  const make = (command: string): GuardedCall & { mutating: boolean } => ({ name: "run_shell", args: { command, timeout_seconds: timeout }, mutating });

  if (op === "search") {
    if (!req.query || !QUERY.test(req.query)) throw new AdapterRefused("D3", "requête de recherche invalide");
    return make(`winget search "${req.query}" --source winget ${COMMON}`);
  }
  if (op === "list") return make(`winget list ${COMMON}`);

  if (!req.id || !ID.test(req.id)) throw new AdapterRefused("D3", "identifiant exact « Editeur.Paquet » requis");
  if (req.version !== undefined && !VERSION.test(req.version)) throw new AdapterRefused("D3", "version invalide");
  if (req.version !== undefined && op !== "install") throw new AdapterRefused("D3", "une version ne se fixe qu'à l'installation");
  const ver = req.version ? ` --version ${req.version}` : "";
  const target = `--id ${req.id} --exact --source winget`;
  switch (op) {
    case "show":
      return make(`winget show ${target} ${COMMON}`);
    case "install":
      return make(`winget install ${target}${ver} --silent --accept-package-agreements ${COMMON}`);
    case "upgrade":
      return make(`winget upgrade ${target} --silent --accept-package-agreements ${COMMON}`);
    case "uninstall":
      return make(`winget uninstall --id ${req.id} --exact --silent ${COMMON}`);
    default:
      throw new AdapterRefused("D3", `opération « ${String(op)} » inconnue`);
  }
}

export interface WingetPackage {
  id: string;
  name?: string;
  version?: string;
  publisher?: string;
  license?: string;
}

/** Lit la sortie de `winget show` (clés anglaises ou françaises) sans rien exécuter. */
export function parseWingetShow(output: string): WingetPackage | null {
  const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im").exec(clean);
      if (m) return m[1]!.trim().slice(0, 200);
    }
    return undefined;
  };
  const head = /^Found\s+(.+?)\s+\[([^\]]+)\]|^(?:Trouvé|Trouv\S+)\s+(.+?)\s+\[([^\]]+)\]/im.exec(clean);
  const id = head?.[2] ?? head?.[4];
  if (!id || !ID.test(id)) return null;
  const pkg: WingetPackage = { id };
  const name = head?.[1] ?? head?.[3];
  if (name) pkg.name = name.trim();
  const version = get("Version", "Version\\s*");
  if (version) pkg.version = version;
  const publisher = get("Publisher", "Éditeur", "Editeur");
  if (publisher) pkg.publisher = publisher;
  const license = get("License", "Licence");
  if (license) pkg.license = license;
  return pkg;
}
