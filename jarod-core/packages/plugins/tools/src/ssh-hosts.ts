// Portage de packages/core/src/services/ssh-hosts.ts (rév. 2e180305).
import { randomUUID } from "node:crypto";
import type { SettingsService } from "@jarod/plugin-storage";
import { assertSshTargetShape, SshInputError, type SshResult, type SshService, type SshTarget } from "./ssh.js";
import { type SshHostRecord } from "@jarod/contracts";
export type { SshHostRecord };

/**
 * Les hôtes SSH DÉCLARÉS — la surface qui donne un nom à une cible distante.
 *
 * Ce que cette couche ajoute à `SshService` : une LISTE d'hôtes nommés, rangée dans les réglages,
 * plus les deux seules façons de se connecter — le test (`SSH_TEST_COMMAND`, fixe) et une commande
 * choisie. Ce qu'elle n'ajoute pas, et ne peut pas ajouter : aucun mot de passe, aucune phrase de
 * passe, aucun contenu de clé. Un hôte déclaré porte un NOM, une ADRESSE, un UTILISATEUR, un PORT et
 * le CHEMIN d'une clé privée, et rien d'autre : `readSshHostRecord` refuse tout ce qui n'est pas ces
 * six champs, donc rien ne peut se glisser dans la déclaration et finir en option ssh.
 *
 * Trois propriétés portent le reste.
 *
 * Sans secret — une clé est un CHEMIN. Le fichier de clé n'est jamais lu, jamais copié, jamais
 * affiché : il est passé à `ssh -i`. Aucun champ de mot de passe n'existe nulle part dans cette
 * couche, et aucune valeur secrète n'est écrite dans les réglages.
 *
 * Vérifiant — la vérification des clés d'hôte reste ACTIVE, et il n'y a ici aucun réglage, aucun
 * paramètre et aucune option pour l'éteindre : la déclaration ne peut pas atteindre les options ssh,
 * qui sont construites par `buildSshOptions` à partir de la politique du service. Un hôte dont la clé
 * n'est pas déjà connue échoue, et cet échec est un RÉSULTAT rendu à l'appelant.
 *
 * Explicite — déclarer, lister ou retirer un hôte ne connecte RIEN : aucune connexion n'est ouverte
 * tant qu'un appelant n'a pas demandé `test` ou `run`. La couture de transport du service reste donc
 * la seule voie vers une connexion, et un test l'injecte pour prouver qu'elle n'est pas empruntée.
 */

/** La commande de TEST : FIXE, harmless, et DÉCLARÉE ici. Elle n'est jamais saisie par l'utilisateur. */
export const SSH_TEST_COMMAND = "id -un && hostname && uname -sm";

/** Clé des réglages qui porte la liste déclarée. Les hôtes ne sont donc pas un fichier à part. */
export const SSH_HOSTS_SETTINGS_KEY = "sshHosts";

/**
 * Settings key holding the ids of the declared hosts on which the AGENT may run commands (`remote_exec`), each command after the
 * person's confirmation. Absent or empty: the feature is off and the tool is not offered to the model. Only the desktop's dedicated
 * channel (`ssh-host-exec-set`, behind a native confirmation) writes it; the generic settings writer does not know this key.
 */
export const SSH_EXEC_HOSTS_SETTINGS_KEY = "sshExecHosts";

/** Longueur maximale d'un nom d'hôte déclaré : un nom, pas un paragraphe. */
const NAME_MAX = 60;

/** Les six champs d'un hôte déclaré, dans l'ordre où une déclaration les porte. Rien d'autre ne passe. */
const SSH_HOST_FIELDS = ["id", "name", "host", "username", "port", "keyPath"] as const;

// SshHostRecord : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

/** Ce qu'on donne pour déclarer un hôte. Aucun champ n'accepte un mot de passe ou une phrase de passe. */
export interface SshHostInput {
  name: string;
  host: string;
  username: string;
  /** Entier 1–65535, ou sa forme texte (le champ d'un écran), ou absent pour 22. */
  port?: number | string;
  keyPath: string;
}

/** Ce qu'un hôte déclaré rend après une commande : la sortie, le code de sortie, et la raison d'un échec. */
export interface SshRunOutcome extends SshResult {
  hostId: string;
  hostName: string;
  /** La commande réellement exécutée à distance, telle qu'elle est partie. */
  command: string;
}

/**
 * Vérifie une déclaration et la rend normalisée. REFUS AVANT TOUTE TENTATIVE : aucune connexion,
 * aucun accès disque, aucun octet écrit — seulement la forme de ce qu'on nous donne.
 *
 * Le nom et l'utilisateur sont exigés ici parce qu'un hôte DÉCLARÉ se nomme et se destine à
 * quelqu'un ; l'adresse, le port et le chemin de clé sont vérifiés par `assertSshTargetShape`, donc
 * par les mêmes règles que le service — rien n'est réinventé, et rien ne peut diverger.
 */
export function assertSshHostInput(input: SshHostInput): Omit<SshHostRecord, "id"> {
  const name = (input.name ?? "").trim();
  if (!name) {
    throw new SshInputError(
      "Nom manquant : donnez un nom à cet hôte, c'est ce qui s'affichera dans la liste (par exemple « serveur de prod »).",
    );
  }
  if (name.length > NAME_MAX) {
    throw new SshInputError(`Nom invalide : « ${name.slice(0, NAME_MAX + 1)} » dépasse ${NAME_MAX} caractères.`);
  }
  if (name.includes("\n") || name.includes("\r") || name.includes("\0")) {
    throw new SshInputError("Nom invalide : il contient un saut de ligne ou un octet nul.");
  }

  const username = (input.username ?? "").trim();
  if (!username) {
    throw new SshInputError(
      "Utilisateur manquant : donnez l'utilisateur distant (par exemple « ops »). Aucun mot de passe n'est accepté ici, et aucune phrase de passe non plus.",
    );
  }

  const port = parseSshHostPort(input.port);

  // L'adresse et le chemin de clé passent par les règles du service SSH : mêmes refus, mêmes phrases.
  const clean = assertSshTargetShape({
    host: input.host ?? "",
    username,
    port,
    keyPath: input.keyPath ?? "",
  });

  return {
    name,
    host: clean.host,
    username: clean.username ?? username,
    port: clean.port ?? port,
    keyPath: clean.keyPath,
  };
}

/** Le port d'une déclaration : un entier 1–65535, vide valant 22. Rien d'autre n'est deviné. */
function parseSshHostPort(raw: number | string | undefined): number {
  const texte = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!texte) return 22;
  const port = Number(texte);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshInputError(`Port invalide : « ${texte} ». Un entier entre 1 et 65535 est attendu (22 par défaut).`);
  }
  return port;
}

/** La cible que le service SSH reçoit d'une déclaration. Aucun autre champ ne passe. */
export function sshHostTarget(record: SshHostRecord): SshTarget {
  return { host: record.host, username: record.username, port: record.port, keyPath: record.keyPath };
}

/**
 * Vrai pour une entrée des réglages qui est bien un hôte déclaré : LES SIX CHAMPS PRÉVUS, ni plus ni
 * moins. Un champ de plus disqualifie l'entrée — une déclaration qui porte un mot de passe, une
 * phrase de passe ou un fourre-tout d'options n'est pas une déclaration, et elle est ignorée plutôt
 * que lue à moitié. C'est ce qui garantit que rien d'autre que ces six champs ne peut voyager
 * jusqu'à l'argv de ssh.
 */
export function isSshHostRecord(value: unknown): value is SshHostRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).length === SSH_HOST_FIELDS.length &&
    SSH_HOST_FIELDS.every((champ) => champ in r) &&
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.host === "string" &&
    typeof r.username === "string" &&
    typeof r.port === "number" &&
    Number.isInteger(r.port) &&
    typeof r.keyPath === "string"
  );
}

/**
 * Les hôtes déclarés : les lister, en ajouter un, en retirer un, puis — seulement si on le demande —
 * se connecter pour tester ou pour exécuter une commande choisie.
 *
 * La liste vit dans les réglages (`SSH_HOSTS_SETTINGS_KEY`), comme les serveurs MCP : ajouter ou
 * retirer un hôte ne touche donc qu'à une valeur de réglage, jamais au disque, et ne connecte rien.
 */
export class SshHostsService {
  constructor(
    private readonly settings: SettingsService,
    private readonly ssh: SshService,
  ) {}

  /** La liste déclarée, en copie. Lecture pure : aucun fichier lu, aucune connexion ouverte. */
  list(): SshHostRecord[] {
    const rows = this.settings.get(SSH_HOSTS_SETTINGS_KEY);
    if (!Array.isArray(rows)) return [];
    return rows.filter(isSshHostRecord).map((r) => ({ ...r }));
  }

  /**
   * Déclare un hôte. La déclaration est VALIDÉE D'ABORD : un hôte incomplet est refusé, et rien n'est
   * écrit ni tenté. Un nom déjà pris est refusé aussi — deux hôtes du même nom rendraient la liste
   * ambiguë, et le nom est ce que l'utilisateur lit.
   */
  add(input: SshHostInput): SshHostRecord[] {
    const clean = assertSshHostInput(input);
    const rows = this.list();
    if (rows.some((r) => r.name.toLowerCase() === clean.name.toLowerCase())) {
      throw new SshInputError(
        `Nom déjà pris : « ${clean.name} » est déjà déclaré. Donnez un autre nom, ou retirez l'hôte existant.`,
      );
    }
    this.settings.set(SSH_HOSTS_SETTINGS_KEY, [...rows, { id: randomUUID(), ...clean }]);
    return this.list();
  }

  /** Retire un hôte déclaré. Rien n'est supprimé du disque : il n'y a qu'une entrée de liste. */
  remove(id: string): SshHostRecord[] {
    const rows = this.list();
    const reste = rows.filter((r) => r.id !== id);
    if (reste.length === rows.length) throw new SshInputError(unknownHostMessage(id));
    this.settings.set(SSH_HOSTS_SETTINGS_KEY, reste);
    // A removed host takes its agent permission with it: a later host can never inherit it.
    if (this.execEnabledIds().includes(id)) this.setExecEnabled(id, false);
    return reste;
  }

  /** Ids of the declared hosts on which the agent may run commands (each one confirmed). Unknown ids are dropped. */
  execEnabledIds(): string[] {
    const raw = this.settings.get(SSH_EXEC_HOSTS_SETTINGS_KEY);
    if (!Array.isArray(raw)) return [];
    const declared = new Set(this.list().map((r) => r.id));
    return [...new Set(raw.filter((id): id is string => typeof id === "string" && declared.has(id)))];
  }

  /** Allows or withdraws agent commands on one declared host. Connects nothing. Rend la liste à jour. */
  setExecEnabled(id: string, enabled: boolean): string[] {
    const current = this.settings.get(SSH_EXEC_HOSTS_SETTINGS_KEY);
    const ids = Array.isArray(current) ? current.filter((x): x is string => typeof x === "string") : [];
    if (enabled) {
      this.host(id); // an unknown id is refused, never stored
      if (!ids.includes(id)) ids.push(id);
      this.settings.set(SSH_EXEC_HOSTS_SETTINGS_KEY, ids);
    } else {
      this.settings.set(
        SSH_EXEC_HOSTS_SETTINGS_KEY,
        ids.filter((x) => x !== id),
      );
    }
    return this.execEnabledIds();
  }

  /** Un hôte déclaré, par son identifiant. Un identifiant inconnu est un refus, pas une connexion. */
  host(id: string): SshHostRecord {
    const trouve = this.list().find((r) => r.id === id);
    if (!trouve) throw new SshInputError(unknownHostMessage(id));
    return trouve;
  }

  /**
   * Le TEST : la commande déclarée ci-dessus, et rien d'autre. Cette méthode ne prend AUCUNE
   * commande en paramètre — il n'y a donc aucun chemin par lequel une commande saisie pourrait
   * devenir « le test ».
   */
  async test(id: string): Promise<SshRunOutcome> {
    return this.lancer(id, SSH_TEST_COMMAND);
  }

  /**
   * Une commande CHOISIE sur un hôte déclaré. Elle part telle quelle : le seul shell qui la lit est
   * celui de la machine distante. Un code de sortie non nul n'est jamais un succès — c'est le verdict
   * du service, rendu tel quel.
   */
  async run(id: string, command: string): Promise<SshRunOutcome> {
    return this.lancer(id, command);
  }

  /** Ouvrir, exécuter, fermer. La session est fermée par le service, même quand la commande échoue. */
  private async lancer(id: string, command: string): Promise<SshRunOutcome> {
    const record = this.host(id);
    const result = await this.ssh.exec(sshHostTarget(record), command);
    return { ...result, hostId: record.id, hostName: record.name, command };
  }
}

/** Le refus d'un identifiant que la liste ne connaît pas — dit comme tel, jamais confondu avec un échec ssh. */
function unknownHostMessage(id: string): string {
  return `Hôte non déclaré : aucun hôte de la liste ne porte l'identifiant « ${String(id)} ». Aucune connexion n'a été tentée.`;
}
