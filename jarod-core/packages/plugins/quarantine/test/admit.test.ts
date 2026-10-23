// V-07 — l'admission des entrées externes : rien n'entre sans une analyse qui l'a dit propre, et aucune copie ne reste en quarantaine.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefenderScanner, QuarantineError, type QuarantineEvent, QuarantineService, type Scanner } from "../src/index.js";

const made: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-qa-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const clean: Scanner = { scan: () => ({ verdict: "clean", scanner: "stub" }) };
const dirty: Scanner = { scan: () => ({ verdict: "infected", scanner: "stub" }) };
const absent: Scanner = { scan: () => ({ verdict: "unavailable", scanner: "stub", detail: "absent" }) };

function service(scanner: Scanner) {
  const root = temp();
  const events: QuarantineEvent[] = [];
  return { svc: new QuarantineService({ root, scanner, approve: null, onEvent: (e) => events.push(e) }), root, events };
}

const blobs = (root: string) => readdirSync(root).filter((f) => f.endsWith(".blob"));

describe("V-07 — admission d'une entrée externe", () => {
  it("propre : admis, sans accord demandé (la porte était déjà ouverte), et aucune copie ne reste", () => {
    const { svc, root, events } = service(clean);
    const r = svc.admitBytes(Buffer.from("bonjour"), "../../photo.png", { source: "telegram" });

    expect(r.admitted).toBe(true);
    expect(r.record).toMatchObject({ status: "promoted", label: "photo.png", provenance: { source: "telegram" }, scan: { verdict: "clean" } });
    expect(blobs(root)).toEqual([]);
    expect(svc.get(r.record.id).status).toBe("promoted");
    expect(events.map((e) => e.action)).toEqual(["intake", "scan", "promote"]);
  });

  it("infecté ou non analysable : refusé avec une raison lisible, contenu détruit, trace gardée", () => {
    const infected = service(dirty);
    const a = infected.svc.admitBytes(Buffer.from("x"), "a.exe", { source: "email" });
    expect(a).toMatchObject({ admitted: false, record: { status: "infected" } });
    expect(a.reason).toMatch(/menace détectée/);
    expect(blobs(infected.root)).toEqual([]);

    const unscanned = service(absent);
    const b = unscanned.svc.admitBytes(Buffer.from("y"), "b.pdf", { source: "phone" });
    expect(b).toMatchObject({ admitted: false, record: { status: "unscanned" } });
    expect(b.reason).toMatch(/non analysé n'entre pas/);
    expect(unscanned.svc.get(b.record.id).provenance.source).toBe("phone");
    expect(unscanned.events.at(-1)).toMatchObject({ action: "refused" });
  });

  it("un même contenu est réanalysé à chaque entrée : un ancien « propre » ne vaut pas pour demain", () => {
    let verdict: "clean" | "infected" = "clean";
    const { svc } = service({ scan: () => ({ verdict, scanner: "stub" }) });
    expect(svc.admitBytes(Buffer.from("z"), "z.txt", { source: "skill" }).admitted).toBe(true);
    verdict = "infected";
    expect(svc.admitBytes(Buffer.from("z"), "z.txt", { source: "skill" }).admitted).toBe(false);
  });

  it("admitFile : copie propre vers la destination, empreinte revérifiée ; refus = rien n'arrive ; jamais d'écrasement", () => {
    const staging = temp();
    const dest = join(temp(), "media");
    const file = join(staging, "sous-titres.vtt");
    writeFileSync(file, "WEBVTT");

    const ok = service(clean).svc.admitFile(file, { source: "media_fetch", url: "https://video.test/1" }, dest);
    expect(readFileSync(ok, "utf8")).toBe("WEBVTT");
    // Le même contenu une deuxième fois : le même fichier ; un autre contenu sous ce nom : refusé, l'existant intact.
    expect(service(clean).svc.admitFile(file, { source: "media_fetch" }, dest)).toBe(ok);
    writeFileSync(file, "WEBVTT autre");
    expect(() => service(clean).svc.admitFile(file, { source: "media_fetch" }, dest)).toThrow(/existe déjà/);
    expect(readFileSync(ok, "utf8")).toBe("WEBVTT");

    const other = join(temp(), "autre");
    expect(() => service(dirty).svc.admitFile(file, { source: "media_fetch" }, other)).toThrow(QuarantineError);
    expect(existsSync(join(other, "sous-titres.vtt"))).toBe(false);
  });

  const onWindows = process.platform === "win32" && new DefenderScanner().scan(__filename).verdict !== "unavailable" ? it : it.skip;

  // Le fichier de test EICAR (inoffensif, reconnu par tout antivirus), assemblé à l'exécution : jamais écrit dans le dépôt.
  onWindows("Defender réel : un contenu ordinaire est admis, le fichier de test EICAR est refusé", () => {
    const { svc } = service(new DefenderScanner());
    const eicar = ["X5O!P%@AP[4", String.fromCharCode(92), "PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

    expect(svc.admitBytes(Buffer.from("un texte ordinaire"), "ok.txt", { source: "test" }).admitted).toBe(true);
    const bad = svc.admitBytes(Buffer.from(eicar), "eicar.txt", { source: "test" });
    expect(bad).toMatchObject({ admitted: false, record: { status: "infected", scan: { scanner: "defender" } } });
  }, 120_000);
});
