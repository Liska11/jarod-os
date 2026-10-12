// Portage de packages/core/test/ssh-hosts.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import {
  type SshCommand,
  SshInputError,
  type SshProcessOutcome,
  SshService,
  type SshTransport,
} from "../src/ssh.js";
import {
  assertSshHostInput,
  isSshHostRecord,
  SSH_TEST_COMMAND,
  type SshHostInput,
  SshHostsService,
  sshHostTarget,
} from "../src/ssh-hosts.js";
import { makeCore } from "./helpers.js";

/*
 * Aucun test de ce fichier ne lance `ssh` ni n'ouvre de socket : la couture de transport du service
 * est injectée, et elle COMPTE ses appels. C'est ce compteur qui prouve qu'une déclaration, une
 * lecture de liste ou un retrait ne connecte rien — et qu'une connexion ne part que si on la demande.
 */

const CLE = "C:/Utilisateurs/testeur/.ssh/id_ed25519";

const VALIDE: SshHostInput = {
  name: "Serveur de prod",
  host: "serveur.exemple",
  username: "ops",
  port: 2222,
  keyPath: CLE,
};

function reponse(partial: Partial<SshProcessOutcome> = {}): SshProcessOutcome {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    deathConfirmed: true,
    binaryMissing: false,
    spawnError: "",
    ...partial,
  };
}

/** Un transport qui n'ouvre rien : il enregistre chaque argv demandé et rend la réponse fournie. */
function transportFactice(reply: Partial<SshProcessOutcome> = {}): {
  transport: SshTransport;
  commands: SshCommand[];
} {
  const commands: SshCommand[] = [];
  const transport: SshTransport = async (command) => {
    commands.push(command);
    return reponse(reply);
  };
  return { transport, commands };
}

/** Le montage sous test : un cœur réel (donc de vrais réglages) et un service SSH sans connexion. */
async function monter(reply: Partial<SshProcessOutcome> = {}, existe = true) {
  const core = await makeCore();
  const { transport, commands } = transportFactice(reply);
  const ssh = new SshService({ transport, keyExists: () => existe });
  return { core, commands, hosts: new SshHostsService(core.settings, ssh) };
}

describe("SSH — les hôtes déclarés", () => {
  it("déclare, liste et retire un hôte sans ouvrir la moindre connexion", async () => {
    const { core, hosts, commands } = await monter();

    // Rien de déclaré au départ : la liste est vide, et les réglages ne portent aucune liste.
    expect(hosts.list()).toEqual([]);
    expect(core.settings.get("sshHosts")).toBeUndefined();

    const apres = hosts.add(VALIDE);
    expect(apres).toHaveLength(1);
    expect(apres[0]).toMatchObject({ name: "Serveur de prod", host: "serveur.exemple", port: 2222 });

    // Déclarer est une écriture de réglage, pas une connexion : le transport n'a jamais été appelé.
    expect(commands).toEqual([]);

    // La lecture non plus n'ouvre rien, et le retrait non plus.
    expect(hosts.list()).toHaveLength(1);
    expect(hosts.remove(apres[0]!.id)).toEqual([]);
    expect(commands).toEqual([]);
    expect(hosts.list()).toEqual([]);
  });

  it("refuse un hôte incomplet AVANT toute tentative, et n'enregistre rien", async () => {
    const { core, hosts, commands } = await monter();
    const incomplets: [string, Partial<SshHostInput>][] = [
      ["Nom", { name: "" }],
      ["adresse", { host: "" }],
      ["Utilisateur", { username: "" }],
      ["Chemin de clé", { keyPath: "" }],
    ];

    for (const [motif, patch] of incomplets) {
      expect(() => hosts.add({ ...VALIDE, ...patch })).toThrow(SshInputError);
      expect(() => hosts.add({ ...VALIDE, ...patch })).toThrow(new RegExp(motif, "i"));
    }

    // Un refus est un refus : rien n'a été tenté, rien n'a été rangé.
    expect(commands).toEqual([]);
    expect(hosts.list()).toEqual([]);
    expect(core.settings.get("sshHosts")).toBeUndefined();
  });

  it("ne range QUE les six champs prévus : aucun mot de passe, aucune option ssh, aucune clé", async () => {
    const { core, hosts, commands } = await monter();
    // Une déclaration hostile : des champs qui n'existent pas, dont de quoi éteindre la vérification.
    const hostile = {
      ...VALIDE,
      password: "mot-de-passe-en-clair",
      passphrase: "phrase-de-passe",
      strictHostKeyChecking: "no",
      extraArgs: ["-o", "StrictHostKeyChecking=no"],
    } as SshHostInput;

    const [hote] = hosts.add(hostile);

    // Les six champs de la cible, et rien d'autre : la déclaration ne peut pas transporter d'option.
    expect(Object.keys(hote!).sort()).toEqual(["host", "id", "keyPath", "name", "port", "username"]);
    expect(sshHostTarget(hote!)).toEqual({
      host: "serveur.exemple",
      username: "ops",
      port: 2222,
      keyPath: CLE,
    });
    expect(isSshHostRecord({ ...hote, options: ["-o", "StrictHostKeyChecking=no"] })).toBe(false);
    expect(JSON.stringify(core.settings.get("sshHosts"))).not.toContain("mot-de-passe-en-clair");
    expect(JSON.stringify(core.settings.get("sshHosts"))).not.toContain("StrictHostKeyChecking");

    expect(() => hosts.add(hostile)).toThrow(/Nom déjà pris/);
    expect(commands).toEqual([]);
  });

  it("exécute pour le test la commande DÉCLARÉE — aucune commande n'entre par un paramètre", async () => {
    const { hosts, commands } = await monter({ stdout: "ops\nserveur-de-prod\nLinux x86_64\n" });
    const [hote] = hosts.add(VALIDE);

    // La méthode de test ne prend qu'un identifiant : il n'existe pas de « commande du test » à saisir.
    expect(SshHostsService.prototype.test.length).toBe(1);

    const resultat = await hosts.test(hote!.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.args.at(-1)).toBe(SSH_TEST_COMMAND);
    expect(resultat.command).toBe(SSH_TEST_COMMAND);
    expect(resultat.ok).toBe(true);
    expect(resultat.exitCode).toBe(0);
    expect(resultat.stdout).toContain("serveur-de-prod");
    // La commande déclarée est harmless : elle lit, elle ne modifie rien.
    expect(SSH_TEST_COMMAND).not.toMatch(/\brm\b|\bsudo\b|shutdown|mkfs|\bmv\b|\bdd\b/);
    // Et l'argv reste celui du service : une seule voie d'authentification, aucune invite.
    expect(commands[0]!.args).toContain("BatchMode=yes");
    expect(commands[0]!.args).toContain("PreferredAuthentications=publickey");
    expect(commands[0]!.args).toContain("StrictHostKeyChecking=yes");
    expect(commands[0]!.args).toEqual(expect.arrayContaining(["-i", CLE, "-p", "2222", "ops@serveur.exemple"]));
  });

  it("rend un code de sortie non nul comme un ÉCHEC, jamais comme un succès", async () => {
    const { hosts } = await monter({ exitCode: 3, stderr: "systemctl: command not found" });
    const [hote] = hosts.add(VALIDE);

    const resultat = await hosts.run(hote!.id, "systemctl --user status jarod");
    expect(resultat.command).toBe("systemctl --user status jarod");
    expect(resultat.ok).toBe(false);
    expect(resultat.exitCode).toBe(3);
    expect(resultat.failure).toBe("exit");
    expect(resultat.message).toContain("code 3");
    expect(resultat.message).toContain("systemctl: command not found");
  });

  it("traite un hôte inconnu comme un RÉSULTAT : la raison est rendue, rien ne lève", async () => {
    const { hosts, commands } = await monter({
      exitCode: 255,
      stderr: "@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@\nHost key verification failed.",
    });
    const [hote] = hosts.add(VALIDE);

    const resultat = await hosts.test(hote!.id);
    expect(resultat.ok).toBe(false);
    expect(resultat.failure).toBe("connection");
    expect(resultat.exitCode).toBe(255);
    expect(resultat.message).toContain("Clé d'hôte refusée");
    expect(resultat.message).toContain("l'hôte est inconnu");

    // L'écran continue de fonctionner : l'appel suivant part normalement, la liste est intacte.
    expect(hosts.list()).toHaveLength(1);
    await hosts.run(hote!.id, "true");
    expect(commands).toHaveLength(2);
  });

  it("refuse un identifiant non déclaré sans rien tenter", async () => {
    const { hosts, commands } = await monter();
    await expect(hosts.test("identifiant-inconnu")).rejects.toThrow(/Hôte non déclaré/);
    await expect(hosts.run("identifiant-inconnu", "true")).rejects.toThrow(SshInputError);
    expect(commands).toEqual([]);
  });

  it("refuse une commande choisie vide avant toute tentative", async () => {
    const { hosts, commands } = await monter();
    const [hote] = hosts.add(VALIDE);
    await expect(hosts.run(hote!.id, "   ")).rejects.toThrow(/Commande distante vide/);
    expect(commands).toEqual([]);
  });

  it("refuse une clé privée absente avant toute tentative", async () => {
    const { hosts, commands } = await monter({}, false);
    const [hote] = hosts.add(VALIDE);
    await expect(hosts.test(hote!.id)).rejects.toThrow(/Clé privée introuvable/);
    expect(commands).toEqual([]);
  });

  it("normalise le port : vide vaut 22, texte valide est accepté, le reste est refusé", () => {
    expect(assertSshHostInput({ ...VALIDE, port: undefined }).port).toBe(22);
    expect(assertSshHostInput({ ...VALIDE, port: "" }).port).toBe(22);
    expect(assertSshHostInput({ ...VALIDE, port: "2200" }).port).toBe(2200);

    for (const port of ["abc", "22.5", 0, 70000, -1]) {
      expect(() => assertSshHostInput({ ...VALIDE, port })).toThrow(SshInputError);
      expect(() => assertSshHostInput({ ...VALIDE, port })).toThrow(/Port invalide/);
    }
  });
});
