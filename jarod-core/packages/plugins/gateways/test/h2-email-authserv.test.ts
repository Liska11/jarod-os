/**
 * H2 (audit v4 § 1) — un en-tête `Authentication-Results` FORGÉ ne doit pas suffire à se faire passer pour
 * un expéditeur autorisé.
 *
 * Avant correctif, `isAuthenticated` parcourait TOUS les en-têtes `Authentication-Results` du message : un
 * attaquant qui ajoutait le sien (`dkim=pass header.d=gmail.com`) en plus du verdict réel du MTA de réception
 * (`dmarc=fail`) faisait passer son message pour authentifié, puis pilotait l'agent avec un `From:` autorisé.
 *
 * Deux verrous : (1) SEUL le premier en-tête compte — c'est le plus haut, donc celui que le MTA de réception a
 * posé ; (2) quand des identifiants sont configurés (`trustedAuthservIds`), l'`authserv-id` du premier en-tête
 * doit être l'un d'eux (un message qui n'arrive qu'avec l'en-tête de l'attaquant est refusé).
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMAIL_CONFIG, type EmailConfig, EmailGateway, isAuthenticated } from "../src/email.js";

const PASS = "dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com";
/** Le verdict RÉEL du MTA de réception : le message a échoué. */
const FAIL = "mx.maison.test; dkim=fail header.d=gmail.com; dmarc=fail header.from=gmail.com";
/** Ce que l'attaquant ajoute à son propre message pour se faire passer pour quelqu'un d'autre. */
const FORGED = "evil.test; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com";

describe("H2 — `Authentication-Results` : seul le premier en-tête compte", () => {
  it("un verdict d'échec suivi d'un en-tête forgé reste un échec", () => {
    expect(isAuthenticated([FAIL, FORGED], "alice@gmail.com")).toBe(false);
  });

  it("un en-tête forgé placé APRÈS un vrai succès ne change rien (le vrai succès reste un succès)", () => {
    expect(isAuthenticated([`mx.maison.test; ${PASS}`, FORGED], "alice@gmail.com")).toBe(true);
  });

  it("`authserv-id` épinglé : l'en-tête doit venir du MTA de confiance", () => {
    expect(isAuthenticated([`mx.maison.test; ${PASS}`], "alice@gmail.com", ["mx.maison.test"])).toBe(true);
    // Majuscules et espaces autour : la comparaison reste insensible à la casse.
    expect(isAuthenticated([`  MX.Maison.Test ; ${PASS}`], "alice@gmail.com", ["mx.maison.test"])).toBe(true);
    // Message qui n'arrive QU'AVEC l'en-tête de l'attaquant : refusé dès qu'un identifiant est configuré.
    expect(isAuthenticated([FORGED], "alice@gmail.com", ["mx.maison.test"])).toBe(false);
    // Un autre serveur de confiance est accepté.
    expect(isAuthenticated([FORGED], "alice@gmail.com", ["mx.maison.test", "evil.test"])).toBe(true);
  });

  it("sans identifiant configuré, le comportement reste celui d'avant (aucun en-tête → refus)", () => {
    expect(isAuthenticated([], "alice@gmail.com", ["mx.maison.test"])).toBe(false);
    expect(isAuthenticated([], "alice@gmail.com")).toBe(false);
  });
});

/** Un message brut minimal, l'en-tête `Authentication-Results` du MTA d'abord, ceux du message ensuite. */
function mail(authResults: string[]): Buffer {
  return Buffer.from(
    [
      "From: Alice <alice@gmail.com>",
      "To: jarod@maison.test",
      "Subject: Question",
      "Message-ID: <m1@gmail.com>",
      ...authResults.map((r) => `Authentication-Results: ${r}`),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Bonjour",
      "",
    ].join("\r\n"),
  );
}

function gateway(messages: Buffer[], cfg: Partial<EmailConfig> = {}) {
  const handler = vi.fn(async () => "Réponse");
  const ignored: string[] = [];
  const gw = new EmailGateway(
    () => ({ ...DEFAULT_EMAIL_CONFIG, enabled: true, user: "jarod@maison.test", allowedSenders: ["alice@gmail.com"], ...cfg }),
    "secret",
    handler,
    {
      fetchUnread: async () => messages.splice(0),
      transport: async () => {},
      onIgnored: (from, why) => ignored.push(`${from} ${why}`),
    },
  );
  return { gw, handler, ignored };
}

describe("H2 — la passerelle refuse le message forgé, pas seulement l'unité", () => {
  it("dmarc=fail du MTA + en-tête forgé dkim=pass → l'agent n'est JAMAIS appelé", async () => {
    const { gw, handler, ignored } = gateway([mail([FAIL, FORGED])]);
    await gw.poll();
    expect(handler).not.toHaveBeenCalled();
    expect(ignored).toEqual(["alice@gmail.com non authentifié (ni DKIM ni DMARC)"]);
  });

  it("même attaque, identifiants épinglés : l'en-tête du MTA de confiance, lui, passe", async () => {
    const { gw, handler } = gateway([mail([`mx.maison.test; ${PASS}`, FORGED])], {
      trustedAuthservIds: ["mx.maison.test"],
    });
    await gw.poll();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("épinglé : un message qui n'arrive qu'avec l'en-tête de l'attaquant est refusé", async () => {
    const { gw, handler } = gateway([mail([FORGED])], { trustedAuthservIds: ["mx.maison.test"] });
    await gw.poll();
    expect(handler).not.toHaveBeenCalled();
  });
});