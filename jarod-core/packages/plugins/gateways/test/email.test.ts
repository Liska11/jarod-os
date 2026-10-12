// Portage de packages/core/test/email.test.ts (rév. 2e180305).
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EMAIL_CONFIG,
  type EmailConfig,
  EmailGateway,
  isAuthenticated,
  isAutomated,
  replySubject,
  stripQuoted,
} from "../src/email.js";

const CFG: EmailConfig = {
  ...DEFAULT_EMAIL_CONFIG,
  enabled: true,
  imapHost: "imap.test",
  smtpHost: "smtp.test",
  user: "jarod@maison.test",
  allowedSenders: ["alice@gmail.com"],
};

/** A raw RFC 822 message, as IMAP hands it over. */
function mail(opts: {
  from: string;
  subject?: string;
  body?: string;
  auth?: string;
  headers?: string[];
  attachment?: { name: string; content: string };
}): Buffer {
  const head = [
    `From: Alice <${opts.from}>`,
    "To: jarod@maison.test",
    `Subject: ${opts.subject ?? "Question"}`,
    "Message-ID: <m1@gmail.com>",
    "MIME-Version: 1.0",
    ...(opts.auth ? [`Authentication-Results: mx.maison.test; ${opts.auth}`] : []),
    ...(opts.headers ?? []),
  ];
  if (!opts.attachment) {
    return Buffer.from(
      `${head.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.body ?? "Bonjour"}\r\n`,
    );
  }
  const b = "XYZ";
  return Buffer.from(
    [
      ...head,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.body ?? "Voici",
      `--${b}`,
      `Content-Type: text/plain; name="${opts.attachment.name}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.name}"`,
      "",
      opts.attachment.content,
      `--${b}--`,
      "",
    ].join("\r\n"),
  );
}

const PASS = "dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com";

function gateway(messages: Buffer[], cfg = CFG) {
  const sent: Record<string, unknown>[] = [];
  const ignored: string[] = [];
  const handler = vi.fn(async (m: { text: string }) => `Réponse à : ${m.text}`);
  const gw = new EmailGateway(() => cfg, "secret", handler, {
    fetchUnread: async () => messages.splice(0),
    transport: async (m) => {
      sent.push(m as Record<string, unknown>);
    },
    unknown: (from) => `Code pour ${from} : ABC234`,
    onIgnored: (from, why) => ignored.push(`${from} ${why}`),
  });
  return { gw, sent, ignored, handler };
}

describe("email security helpers", () => {
  it("trusts DKIM or DMARC passing for the sender's own domain, never SPF alone", () => {
    expect(isAuthenticated([PASS], "alice@gmail.com")).toBe(true);
    expect(isAuthenticated(["dkim=pass header.d=example.com"], "bob@mail.example.com")).toBe(true);
    expect(isAuthenticated(["dkim=pass header.d=evil.com; dmarc=fail header.from=gmail.com"], "alice@gmail.com")).toBe(
      false,
    );
    expect(isAuthenticated(["spf=pass smtp.mailfrom=gmail.com"], "alice@gmail.com")).toBe(false);
    expect(isAuthenticated([], "alice@gmail.com")).toBe(false);
  });

  it("recognises automatic mail", () => {
    const h = (o: Record<string, string>) => new Map(Object.entries(o));
    expect(isAutomated(h({ "auto-submitted": "auto-replied" }), "a@b.c")).toBe(true);
    expect(isAutomated(h({ "auto-submitted": "no" }), "a@b.c")).toBe(false);
    expect(isAutomated(h({ precedence: "bulk" }), "a@b.c")).toBe(true);
    expect(isAutomated(h({ "list-id": "<x>" }), "a@b.c")).toBe(true);
    expect(isAutomated(h({}), "MAILER-DAEMON@b.c")).toBe(true);
    expect(isAutomated(h({}), "alice@b.c")).toBe(false);
  });

  it("keeps only the new part of a reply", () => {
    expect(stripQuoted("Oui, vas-y.\n\nLe lun. 1 sept. 2026, Jarod a écrit :\n> Je lance ?")).toBe("Oui, vas-y.");
    expect(stripQuoted("Ok\n> cité\nsuite")).toBe("Ok\nsuite");
    expect(replySubject("Question")).toBe("Re: Question");
    expect(replySubject("RE: Question")).toBe("RE: Question");
  });
});

describe("email gateway", () => {
  it("answers an allowed, authenticated sender in the same thread, marked as automatic", async () => {
    const { gw, sent, handler } = gateway([
      mail({ from: "alice@gmail.com", body: "Quel temps demain ?\n\n> vieux message", auth: PASS }),
    ]);
    await gw.poll();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ from: "alice@gmail.com", text: "Quel temps demain ?" }),
    );
    expect(sent).toEqual([
      expect.objectContaining({
        to: "alice@gmail.com",
        from: "jarod@maison.test",
        subject: "Re: Question",
        inReplyTo: "<m1@gmail.com>",
        text: "Réponse à : Quel temps demain ?",
        headers: { "Auto-Submitted": "auto-replied" },
      }),
    ]);
  });

  it("ignores unauthenticated mail (a forged From), and never answers robots or itself", async () => {
    const { gw, sent, ignored, handler } = gateway([
      mail({ from: "alice@gmail.com", body: "faux" }),
      mail({ from: "alice@gmail.com", auth: PASS, headers: ["Auto-Submitted: auto-replied"] }),
      mail({ from: "jarod@maison.test", auth: "dkim=pass header.d=maison.test" }),
    ]);
    await gw.poll();
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(ignored).toEqual(["alice@gmail.com non authentifié (ni DKIM ni DMARC)"]);
  });

  it("gives an unknown but authenticated sender a pairing code, and passes attachments along", async () => {
    const { gw, sent } = gateway([mail({ from: "carol@gmail.com", auth: PASS.replace(/gmail/g, "gmail") })]);
    await gw.poll();
    expect(sent[0]).toMatchObject({ to: "carol@gmail.com", text: "Code pour carol@gmail.com : ABC234" });

    const files = gateway([
      mail({ from: "alice@gmail.com", auth: PASS, attachment: { name: "notes.txt", content: "contenu" } }),
    ]);
    await files.gw.poll();
    const msg = files.handler.mock.calls[0]![0] as unknown as {
      files: { name: string; download(): Promise<Buffer> }[];
    };
    expect(msg.files.map((f) => f.name)).toEqual(["notes.txt"]);
    expect((await msg.files[0]!.download()).toString()).toBe("contenu");
  });

  it("can skip the authentication check when told to (a trusted internal server)", async () => {
    const { gw, handler } = gateway([mail({ from: "alice@gmail.com" })], { ...CFG, requireAuth: false });
    await gw.poll();
    expect(handler).toHaveBeenCalled();
  });

  it("sends files as attachments, in the sender's thread", async () => {
    const { gw, sent } = gateway([mail({ from: "alice@gmail.com", auth: PASS })]);
    await gw.poll();
    await gw.sendFile("alice@gmail.com", "rapport.pdf", Buffer.from("%PDF"), "Le rapport");
    expect(sent.at(-1)).toMatchObject({
      subject: "Re: Question",
      text: "Le rapport",
      attachments: [{ filename: "rapport.pdf", content: Buffer.from("%PDF") }],
    });
  });

  it("reports a connection failure as an error status instead of throwing", async () => {
    const gw = new EmailGateway(
      () => CFG,
      "x",
      async () => "",
      {
        fetchUnread: async () => {
          throw new Error("Invalid credentials");
        },
      },
    );
    await gw.poll();
    expect(gw.status).toMatchObject({ id: "email", state: "error", error: "Invalid credentials" });
  });

  it("abandonne une relève qui pend au lieu de bloquer toutes les suivantes", async () => {
    const sent: Record<string, unknown>[] = [];
    let calls = 0;
    const gw = new EmailGateway(
      () => CFG,
      "x",
      async (m: { text: string }) => `Réponse à : ${m.text}`,
      {
        // Premier tour : le serveur ne dit plus rien. Second tour : il répond de nouveau.
        fetchUnread: () =>
          ++calls === 1
            ? new Promise<Buffer[]>(() => {})
            : Promise.resolve([mail({ from: "alice@gmail.com", body: "Toujours là ?", auth: PASS })]),
        transport: async (m) => {
          sent.push(m as Record<string, unknown>);
        },
        pollTimeoutMs: 30,
      },
    );
    const stuck = gw.poll(); // ne rend jamais la main : c'est le délai qui doit trancher
    for (let i = 0; i < 100 && gw.status.state !== "error"; i++) await new Promise((r) => setTimeout(r, 20));
    void stuck;
    expect(gw.status).toMatchObject({ state: "error" });
    expect(gw.status.error).toMatch(/Relève IMAP : aucune réponse après 30 ms/);
    // Le drapeau `polling` est retombé : le tour suivant a bien lieu.
    await gw.poll();
    expect(sent.at(-1)).toMatchObject({ to: "alice@gmail.com", text: "Réponse à : Toujours là ?" });
  });

  it("signale l'erreur de traitement d'un message au lieu de l'avaler", async () => {
    const gw = new EmailGateway(
      () => CFG,
      "x",
      async () => {
        throw new Error("le modèle a refusé");
      },
      {
        fetchUnread: async () => [mail({ from: "alice@gmail.com", auth: PASS })],
        transport: async () => {},
      },
    );
    await gw.poll();
    expect(gw.status).toMatchObject({ id: "email", state: "error" });
    expect(gw.status.error).toMatch(/Message ignoré après erreur : le modèle a refusé/);
  });
});
