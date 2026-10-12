// Portage de packages/core/test/ssh.test.ts (rév. 2e180305).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertHostKeyVerificationKept,
  buildSshArgs,
  buildSshOptions,
  type SshCommand,
  SshInputError,
  type SshProcessOutcome,
  SshService,
  type SshSession,
  type SshTarget,
  type SshTransport,
  spawnSshCommand,
} from "../src/ssh.js";

/*
 * Aucun test de ce fichier ne lance `ssh` ni n'ouvre de socket : le transport est injecté partout
 * où une connexion serait possible, et le seul processus réellement lancé est le `node` du testeur
 * (`process.execPath`) pour prouver que le délai tue bien un processus.
 */

const CLE = "C:/Utilisateurs/testeur/.ssh/id_ed25519";
const CIBLE: SshTarget = { host: "serveur.exemple", username: "ops", port: 2222, keyPath: CLE };

/** Le premier élément, ou une erreur claire : « le transport n'a pas été appelé » n'est pas un succès. */
function only<T>(list: readonly T[]): T {
  const [first] = list;
  if (first === undefined) throw new Error("le transport n'a jamais été appelé");
  return first;
}

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

/** Un transport qui n'ouvre rien : il enregistre ce qu'on lui demande et rend la réponse fournie. */
function transportFactice(reply: Partial<SshProcessOutcome> = {}): { transport: SshTransport; commands: SshCommand[] } {
  const commands: SshCommand[] = [];
  const transport: SshTransport = async (command) => {
    commands.push(command);
    return reponse(reply);
  };
  return { transport, commands };
}

/** Un service dont le fichier de clé est toujours considéré comme présent. */
function service(transport: SshTransport): SshService {
  return new SshService({ transport, keyExists: () => true });
}

function vivant(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("SSH — l'argv rendu au binaire", () => {
  it("construit un tableau exact : hôte, utilisateur, port, clé et commande distante", async () => {
    const { transport, commands } = transportFactice({ stdout: "Linux\n" });
    const result = await service(transport).exec(CIBLE, "uname -a");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Linux\n");
    expect(commands).toHaveLength(1);

    const envoye = only(commands);
    expect(envoye.file).toBe("ssh");
    expect(envoye.args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ControlPersist=no",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PreferredAuthentications=publickey",
      "-i",
      CLE,
      "-p",
      "2222",
      "ops@serveur.exemple",
      "uname -a",
    ]);
  });

  it("ne demande que trois choses au processus : un binaire, un tableau d'arguments, un délai", async () => {
    const { transport, commands } = transportFactice();
    await service(transport).exec(CIBLE, "uname -a");

    const envoye = only(commands);
    // Rien qui ressemble à une ligne de commande assemblée, rien qui demande un shell.
    expect(Object.keys(envoye).sort()).toEqual(["args", "file", "timeoutMs"]);
    expect(Array.isArray(envoye.args)).toBe(true);
    expect(envoye.args.every((arg) => typeof arg === "string")).toBe(true);
    // La commande distante est UN argument, jamais recollée avec des espaces.
    expect(envoye.args[envoye.args.length - 1]).toBe("uname -a");
    expect(envoye.timeoutMs).toBeGreaterThan(0);
  });

  it("sans utilisateur ni port : l'hôte seul, et le port 22", async () => {
    const { transport, commands } = transportFactice();
    await service(transport).exec({ host: "serveur.exemple", keyPath: CLE }, "id");

    const args = only(commands).args;
    expect(args).toContain("serveur.exemple");
    expect(args.some((arg) => arg.includes("@"))).toBe(false);
    expect(args[args.indexOf("-p") + 1]).toBe("22");
  });

  it("le binaire ssh est configurable, sans jamais passer par un shell", async () => {
    const { transport, commands } = transportFactice();
    const binaire = "C:/Windows/System32/OpenSSH/ssh.exe";
    await new SshService({ transport, sshBinary: binaire, keyExists: () => true }).exec(CIBLE, "id");

    expect(only(commands).file).toBe(binaire);
  });

  it("ne transporte aucun secret : la clé est un chemin, son contenu ne part jamais", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "jarod-ssh-"));
    const cle = join(dossier, "fichier_de_test_jetable");
    // Un contenu de test qui ne ressemble à aucune clé : c'est la contamination qu'on surveille.
    writeFileSync(cle, "# fichier de test jetable, ceci n'est pas une clé\n");

    try {
      const { transport, commands } = transportFactice();
      // Ici `keyExists` n'est pas injecté : le vrai contrôle de fichier est exercé.
      const result = await new SshService({ transport }).exec({ host: "serveur.exemple", keyPath: cle }, "id");
      expect(result.ok).toBe(true);

      const args = only(commands).args;
      const ligne = args.join(" ");
      expect(ligne).toContain(cle);
      expect(ligne).not.toContain("fichier de test jetable");
      expect(ligne).not.toMatch(/passphrase|mot de passe|password|secret/i);
      expect(args.some((arg) => arg.includes("\n"))).toBe(false);
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("SSH — vérification des clés d'hôte", () => {
  it("un hôte inconnu échoue, et la vérification n'a pas été désactivée", async () => {
    const { transport, commands } = transportFactice({
      stderr: "Host key verification failed.\r\n",
      exitCode: 255,
    });
    const result = await service(transport).exec(CIBLE, "true");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(255);
    expect(result.failure).toBe("connection");
    expect(result.message).toMatch(/clé d'hôte/i);
    expect(result.message).toContain("serveur.exemple");

    const args = only(commands).args;
    const options = args.filter((arg) => arg.includes("=")).map((arg) => arg.toLowerCase());
    // Le mode de vérification est actif, et rien ne détourne le fichier des hôtes connus.
    expect(options).toContain("stricthostkeychecking=yes");
    expect(options.some((option) => option.startsWith("stricthostkeychecking=") && !option.endsWith("=yes"))).toBe(
      false,
    );
    expect(options.some((option) => option.startsWith("userknownhostsfile="))).toBe(false);
    expect(args).not.toContain("UserKnownHostsFile=/dev/null");
  });

  it("une clé d'hôte qui a changé est refusée, jamais contournée", async () => {
    const { transport } = transportFactice({
      stderr: "@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@\nHost key verification failed.",
      exitCode: 255,
    });
    const result = await service(transport).exec(CIBLE, "true");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/clé d'hôte/i);
    expect(result.message).toMatch(/known_hosts|ssh-keyscan/);
  });

  it("la garde refuse les options qui éteindraient la vérification", () => {
    expect(() => assertHostKeyVerificationKept(["-o", "StrictHostKeyChecking=no"])).toThrow(SshInputError);
    expect(() => assertHostKeyVerificationKept(["-o", "StrictHostKeyChecking=NO"])).toThrow(/StrictHostKeyChecking/);
    expect(() => assertHostKeyVerificationKept(["UserKnownHostsFile=/dev/null"])).toThrow(/UserKnownHostsFile/);
    expect(() => assertHostKeyVerificationKept(["userknownhostsfile=none"])).toThrow(/userknownhostsfile/i);
    // Ce qui n'éteint pas la vérification passe : la garde ne punit pas des options légitimes.
    expect(() => assertHostKeyVerificationKept(["-o", "StrictHostKeyChecking=accept-new"])).not.toThrow();
    expect(() => assertHostKeyVerificationKept(["-o", "ControlPath=none"])).not.toThrow();
  });

  it("la garde ne juge pas la commande distante : elle ne s'applique qu'aux options", () => {
    // Une commande qui parle de l'option interdite reste une commande légitime.
    expect(buildSshArgs(CIBLE, "grep StrictHostKeyChecking=no /etc/ssh/ssh_config").at(-1)).toBe(
      "grep StrictHostKeyChecking=no /etc/ssh/ssh_config",
    );
  });
});

describe("SSH — délai", () => {
  it("un délai dépassé est rendu comme tel, même si le transport ne rend jamais la main", async () => {
    const muet: SshTransport = () => new Promise<SshProcessOutcome>(() => {});
    const depart = Date.now();
    const result = await service(muet).exec(CIBLE, "dormir", { timeoutMs: 50 });
    const ecoule = Date.now() - depart;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.failure).toBe("timeout");
    expect(result.exitCode).toBeNull();
    expect(result.message).toMatch(/[Dd]élai/);
    expect(ecoule).toBeGreaterThanOrEqual(50);
    expect(ecoule).toBeLessThan(3000);
  });

  it("le transport réel tue le processus : il n'est plus là après le délai", async () => {
    // Le seul processus lancé par ce fichier : le node du testeur, jamais ssh, jamais de socket.
    const programme = "process.stdout.write(String(process.pid));setInterval(() => {}, 1000)";
    const depart = Date.now();
    const resultat = await spawnSshCommand({ file: process.execPath, args: ["-e", programme], timeoutMs: 300 });
    const ecoule = Date.now() - depart;

    expect(resultat.timedOut).toBe(true);
    expect(resultat.deathConfirmed).toBe(true);
    expect(resultat.exitCode).not.toBe(0);

    const pid = Number(resultat.stdout.trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(pid).toBeGreaterThan(0);
    // La preuve : le processus n'existe plus. Sans mise à mort, la commande pendrait encore.
    expect(vivant(pid)).toBe(false);
    expect(ecoule).toBeLessThan(5000);
  });
});

describe("SSH — code de sortie", () => {
  it("un code non nul n'est pas confondu avec un succès", async () => {
    const { transport } = transportFactice({ stderr: "ls: cannot access '/absent'\n", exitCode: 3 });
    const result = await service(transport).exec(CIBLE, "ls /absent");

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.failure).toBe("exit");
    expect(result.message).toContain("3");
    expect(result.stderr).toContain("/absent");
    expect(result.message).toContain("/absent");
  });

  it("un code nul reste un succès, même avec du bruit sur la sortie d'erreur", async () => {
    const { transport } = transportFactice({ stderr: "avertissement sans conséquence\n" });
    const result = await service(transport).exec(CIBLE, "id");

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeNull();
    expect(result.message).toBe("");
    expect(result.stderr).toContain("avertissement");
  });

  it("la variante stricte lève, et le code de sortie reste intact", async () => {
    const { transport } = transportFactice({ exitCode: 7 });
    const session = service(transport).open(CIBLE);

    await expect(session.execOrThrow("faux")).rejects.toThrow(/7/);

    const { transport: bon } = transportFactice({ stdout: "ok\n" });
    const succes = await service(bon).open(CIBLE).execOrThrow("vrai");
    expect(succes.ok).toBe(true);
  });

  it("un binaire ssh absent est un résultat, pas une exception", async () => {
    const { transport } = transportFactice({ binaryMissing: true, spawnError: "spawn ssh ENOENT", exitCode: null });
    const result = await service(transport).exec(CIBLE, "id");

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("binary");
    expect(result.message).toContain("ssh");
  });

  it("avec le transport réel, un binaire absent est rendu comme tel (aucun ssh lancé)", async () => {
    // Ici rien n'est injecté : le vrai transport tente vraiment de lancer un processus, mais le
    // binaire n'existe pas. Aucun ssh n'est trouvé, donc aucun ssh n'est lancé, aucune socket non plus.
    const svc = new SshService({ sshBinary: "ssh-absent-du-systeme-jarod", keyExists: () => true });
    const result = await svc.exec(CIBLE, "id");

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("binary");
    expect(result.exitCode).toBeNull();
  });
});

describe("SSH — refus avant toute tentative de connexion", () => {
  const cas: Array<[string, SshTarget, RegExp]> = [
    ["hôte vide", { host: "   ", keyPath: CLE }, /Hôte manquant/],
    ["hôte avec un espace", { host: "serveur exemple", keyPath: CLE }, /Hôte invalide/],
    ["hôte avec un métacaractère de shell", { host: "serveur;rm -rf /", keyPath: CLE }, /Hôte invalide/],
    ["hôte en tiret initial", { host: "-oProxyCommand=x", keyPath: CLE }, /Hôte invalide/],
    ["hôte avec un port collé", { host: "serveur.exemple:22", keyPath: CLE }, /Hôte invalide/],
    [
      "utilisateur avec une arobase",
      { host: "serveur.exemple", username: "a@b", keyPath: CLE },
      /Utilisateur invalide/,
    ],
    ["port hors bornes", { host: "serveur.exemple", port: 70_000, keyPath: CLE }, /Port invalide/],
    ["port non entier", { host: "serveur.exemple", port: 22.5, keyPath: CLE }, /Port invalide/],
    ["chemin de clé vide", { host: "serveur.exemple", keyPath: "  " }, /Chemin de clé manquant/],
    ["chemin de clé relatif", { host: "serveur.exemple", keyPath: "id_ed25519" }, /absolu/],
  ];

  for (const [nom, cible, attendu] of cas) {
    it(`refuse « ${nom} » et ne tente rien`, async () => {
      const appels = vi.fn<SshTransport>(async () => reponse());
      const svc = new SshService({ transport: appels, keyExists: () => true });

      await expect(svc.exec(cible, "id")).rejects.toBeInstanceOf(SshInputError);
      await expect(svc.exec(cible, "id")).rejects.toThrow(attendu);
      expect(appels).not.toHaveBeenCalled();
    });
  }

  it("refuse une clé absente, avec le chemin dans le message", async () => {
    const appels = vi.fn<SshTransport>(async () => reponse());
    const svc = new SshService({ transport: appels, keyExists: () => false });

    await expect(svc.exec(CIBLE, "id")).rejects.toThrow(/introuvable/);
    await expect(svc.exec(CIBLE, "id")).rejects.toThrow(CLE);
    expect(appels).not.toHaveBeenCalled();
  });

  it("refuse une commande vide ou un délai invalide, sans rien lancer", async () => {
    const appels = vi.fn<SshTransport>(async () => reponse());
    const svc = new SshService({ transport: appels, keyExists: () => true });

    await expect(svc.exec(CIBLE, "   ")).rejects.toThrow(/Commande distante vide/);
    await expect(svc.open(CIBLE).exec("id", { timeoutMs: 0 })).rejects.toThrow(/Délai invalide/);
    expect(appels).not.toHaveBeenCalled();
  });

  it("refuse d'exécuter quoi que ce soit après la fermeture", async () => {
    const appels = vi.fn<SshTransport>(async () => reponse());
    const svc = new SshService({ transport: appels, keyExists: () => true });
    const session = svc.open(CIBLE);

    session.close();
    expect(session.isClosed).toBe(true);
    await expect(session.exec("id")).rejects.toThrow(/Session fermée/);
    await expect(session.execOrThrow("id")).rejects.toThrow(/Session fermée/);

    svc.close();
    expect(svc.isClosed).toBe(true);
    await expect(svc.exec(CIBLE, "id")).rejects.toThrow(/Service SSH fermé/);
    expect(appels).not.toHaveBeenCalled();
  });

  it("le raccourci ferme la session, y compris quand la commande échoue", async () => {
    const sessions: SshSession[] = [];
    class ServiceEspion extends SshService {
      override open(target: SshTarget): SshSession {
        const session = super.open(target);
        sessions.push(session);
        return session;
      }
    }
    const { transport } = transportFactice({ exitCode: 4 });
    const espion = new ServiceEspion({ transport, keyExists: () => true });

    const result = await espion.exec(CIBLE, "faux");
    expect(result.ok).toBe(false);
    expect(sessions).toHaveLength(1);
    expect(only(sessions).isClosed).toBe(true);
  });

  it("la construction des options est utilisable seule, et refuse les mêmes cibles", () => {
    expect(buildSshOptions({ host: "serveur.exemple", keyPath: CLE })).toContain("StrictHostKeyChecking=yes");
    expect(() => buildSshOptions({ host: "", keyPath: CLE })).toThrow(SshInputError);
    expect(() => buildSshArgs(CIBLE, "")).toThrow(/Commande distante vide/);
  });
});
