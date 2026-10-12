// Chantier 3 de SPECS-P5-MODELS.md (§ 3.2, § 3.9 (a) et (c), § 6 cas (3)(4)(5)(10)(18)(20)) : intégrité du téléchargement — taille ET SHA-256, `.part` en exclusif,
// aucun renommage avant la fin du jeu, jamais d'écrasement, chaque suppression journalisée. Barres (3-A) à (3-G) figées dans DECISIONS le 2026-10-03, AVANT ce code.
// Serveur Hugging Face factice local ; `guardedFetch` rend rouge tout accès au vrai réseau.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import type { HfRemoval } from "../src/hf-transfer.js";
import { HuggingFaceService } from "../src/huggingface.js";
import { type FakeHf, SHA, guardedFetch, startFakeHf } from "./fake-hf-server.js";

const REPO = "acme/tiny-GGUF";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Octets déterministes (pas de motif répété qui masquerait un décalage). */
function bytesOf(n: number, seed = 1): Buffer {
  const out = Buffer.alloc(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function listAll(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listAll(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

let fake: FakeHf | undefined;
afterEach(async () => {
  await cleanup();
  await fake?.close();
  fake = undefined;
});

async function setup(options: Parameters<typeof startFakeHf>[0], deps: { rename?: typeof renameSync } = {}) {
  fake = await startFakeHf(options);
  const guarded = guardedFetch([fake.origin]);
  const journal: HfRemoval[] = [];
  const service = new HuggingFaceService({ baseUrl: fake.origin, fetchImpl: guarded.fetch, journal: (e) => journal.push(e), freeBytes: () => Number.MAX_SAFE_INTEGER, ...deps });
  const dest = tempDir();
  return { fake, guarded, journal, service, dest };
}

const one = (name: string, bytes: Buffer, sha: string | null | "auto" = "auto") => ({ name, size: bytes.length, sha256: sha === "auto" ? sha256(bytes) : sha });

async function code(promise: Promise<unknown>): Promise<{ code: string; error: Error & Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code?: string }).code ?? "SANS_CODE", error: error as Error & Record<string, unknown> };
  }
  throw new Error("aucun rejet");
}

describe("(3-A) jamais de modèle tronqué : 0 cible, 0 .part, chaque suppression journalisée", () => {
  const BIG = bytesOf(24 * 1024 * 1024, 7);

  function expectClean(dest: string, journal: HfRemoval[], target = "m.gguf") {
    expect(listAll(dest).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(existsSync(join(dest, target))).toBe(false);
    expect(journal.length).toBeGreaterThanOrEqual(1);
    for (const e of journal) {
      expect(e.path).toMatch(/\.part$|\.gguf$/);
      expect(Number.isInteger(e.bytes)).toBe(true);
      expect(e.reason.length).toBeGreaterThan(5);
    }
  }

  it("1. annulation en cours : connexion fermée côté serveur, .part supprimé, état « annulé »", async () => {
    const { fake, service, dest, journal } = await setup({ files: { "m.gguf": BIG }, chunk: 16 * 1024 });
    const ctl = new AbortController();
    const run = service.download({
      repo: REPO,
      revision: SHA,
      file: "m.gguf",
      destDir: dest,
      expected: { size: BIG.length, sha256: sha256(BIG) },
      signal: ctl.signal,
      onProgress: (received) => {
        if (received > 200_000) ctl.abort();
      },
    });
    const r = await code(run);
    expect(r.code).toBe("CANCELLED");
    expectClean(dest, journal);
    expect(journal[0]!.reason).toMatch(/annulation/);
    // Le serveur voit la connexion fermée AVANT d'avoir tout servi.
    await new Promise((res) => setTimeout(res, 50));
    const cdn = fake.log.find((l) => l.path.startsWith("/cdn/"))!;
    expect(cdn.aborted).toBe(true);
    expect(cdn.served).toBeLessThan(BIG.length);
  });

  it("2. connexion coupée (longueur annoncée non tenue)", async () => {
    const bytes = bytesOf(2 * 1024 * 1024, 3);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, chunk: 16 * 1024, cutAfter: 300_000 });
    const r = await code(service.download({ repo: REPO, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: bytes.length, sha256: sha256(bytes) } }));
    expect(r.code).toBe("NETWORK");
    expectClean(dest, journal);
  });

  it("3. flux plus court AVEC Content-Length", async () => {
    const bytes = bytesOf(100_000, 4);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, rangeMode: "short-body" });
    const r = await code(service.download({ repo: REPO, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: bytes.length, sha256: sha256(bytes) } }));
    expect(r.code).toBe("SIZE_MISMATCH");
    expect(r.error.received).toBe(bytes.length - 5);
    expect(r.error.expected).toBe(bytes.length);
    expectClean(dest, journal);
    expect(journal[0]!.reason).toMatch(/taille/);
  });

  it("4. flux plus court SANS Content-Length (aucun en-tête ne le signale)", async () => {
    const bytes = bytesOf(100_000, 5);
    const { service, dest, journal, fake } = await setup({ files: { "m.gguf": bytes }, rangeMode: "short-body", chunked: true });
    const r = await code(service.download({ repo: REPO, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: bytes.length, sha256: sha256(bytes) } }));
    expect(r.code).toBe("SIZE_MISMATCH");
    expectClean(dest, journal);
    expect(fake.log.some((l) => l.path.startsWith("/cdn/") && l.status === 200)).toBe(true);
  });

  it("5. flux plus LONG que la taille publiée : abandon AVANT la fin (3-F)", async () => {
    const { fake, service, dest, journal } = await setup({ files: { "m.gguf": BIG }, chunk: 16 * 1024, linkedSize: "absent" });
    const published = 1024 * 1024;
    const r = await code(service.download({ repo: REPO, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: published, sha256: sha256(BIG) } }));
    expect(r.code).toBe("SIZE_MISMATCH");
    // Abandon : jamais plus d'une tranche réseau au-delà de la taille publiée (borne large : 256 Kio), jamais les 24 Mio.
    expect(r.error.received as number).toBeGreaterThan(published);
    expect(r.error.received as number).toBeLessThanOrEqual(published + 256 * 1024);
    expectClean(dest, journal);
    await new Promise((res) => setTimeout(res, 50));
    expect(fake.log.find((l) => l.path.startsWith("/cdn/"))!.aborted).toBe(true);
  });

  it("6. SHA-256 faux à taille égale", async () => {
    const bytes = bytesOf(200_000, 6);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, corrupt: true });
    const r = await code(service.download({ repo: REPO, revision: SHA, file: "m.gguf", destDir: dest, expected: { size: bytes.length, sha256: sha256(bytes) } }));
    expect(r.code).toBe("HASH_MISMATCH");
    expectClean(dest, journal);
    expect(journal[0]!.reason).toMatch(/SHA-256/);
  });

  it("7. fermeture (signal) pendant l'écriture du 2ᵉ fichier d'un jeu : les DEUX .part sont supprimés", async () => {
    const a = bytesOf(300_000, 8);
    const b = BIG;
    const { service, dest, journal } = await setup({ files: { "m-00001-of-00002.gguf": a, "m-00002-of-00002.gguf": b }, chunk: 16 * 1024 });
    const ctl = new AbortController();
    const r = await code(
      service.downloadSet({
        repo: REPO,
        revision: SHA,
        destDir: dest,
        files: [one("m-00001-of-00002.gguf", a), one("m-00002-of-00002.gguf", b)],
        signal: ctl.signal,
        onProgress: (p) => {
          if (p.index === 1 && p.received > 200_000) ctl.abort();
        },
      }),
    );
    expect(r.code).toBe("CANCELLED");
    expect(listAll(dest)).toEqual([]);
    expect(journal.map((e) => e.path.split(/[\\/]/).pop()).sort()).toEqual(["m-00001-of-00002.gguf.part", "m-00002-of-00002.gguf.part"]);
  });

  it("8. un renommage échoue au 2ᵉ fichier : le 1ᵉʳ est retiré (retour arrière journalisé), rien ne reste", async () => {
    const a = bytesOf(50_000, 9);
    const b = bytesOf(60_000, 10);
    let calls = 0;
    const rename = ((from: string, to: string) => {
      calls++;
      if (calls === 2) throw new Error("EBUSY simulé");
      return renameSync(from, to);
    }) as typeof renameSync;
    const { service, dest, journal } = await setup({ files: { "m-00001-of-00002.gguf": a, "m-00002-of-00002.gguf": b } }, { rename });
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m-00001-of-00002.gguf", a), one("m-00002-of-00002.gguf", b)] }));
    expect(r.code).toBe("RENAME_FAILED");
    expect(listAll(dest)).toEqual([]);
    const reasons = journal.map((e) => e.reason).join(" | ");
    expect(reasons).toMatch(/retour arrière/);
    expect(journal.some((e) => e.path.endsWith("m-00001-of-00002.gguf"))).toBe(true);
    expect(journal.some((e) => e.path.endsWith("m-00002-of-00002.gguf.part"))).toBe(true);
  });
});

describe("(3-B) intégrité : taille ET SHA-256, jamais l'ETag du CDN", () => {
  it("un fichier conforme est écrit entier, vérifié « sha256 », sans .part, avec l'avancement", async () => {
    const bytes = bytesOf(500_000, 11);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, chunk: 16 * 1024 });
    const progress: { received: number; stage: string }[] = [];
    const result = await service.downloadSet({
      repo: REPO,
      revision: SHA,
      destDir: dest,
      files: [one("m.gguf", bytes)],
      onProgress: (p) => progress.push({ received: p.received, stage: p.stage }),
    });
    expect(result).toEqual([{ name: "m.gguf", path: join(dest, "m.gguf"), bytes: bytes.length, sha256: sha256(bytes), verified: "sha256" }]);
    expect(readFileSync(join(dest, "m.gguf")).equals(bytes)).toBe(true);
    expect(listAll(dest)).toEqual(["m.gguf"]);
    expect(journal).toEqual([]);
    expect(progress.filter((p) => p.stage === "download").length).toBeGreaterThan(1);
    expect(progress.at(-1)!.stage).toBe("finalize");
    expect(progress.map((p) => p.stage).indexOf("verify")).toBeGreaterThan(0);
  });

  it("empreinte non publiée (null) : accepté sur la taille, et le résultat DIT « size-only »", async () => {
    const bytes = bytesOf(120_000, 12);
    const { service, dest } = await setup({ files: { "m.gguf": bytes } });
    const [r] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes, null)] });
    expect(r!.verified).toBe("size-only");
    expect(r!.sha256).toBe(sha256(bytes)); // calculé et rendu, mais pas comparé : rien n'était publié
  });

  it("empreinte non publiée ET taille fausse : rejeté", async () => {
    const bytes = bytesOf(120_000, 13);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, linkedSize: "absent" });
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [{ name: "m.gguf", size: bytes.length + 1, sha256: null }] }));
    expect(r.code).toBe("SIZE_MISMATCH");
    expect(listAll(dest)).toEqual([]);
    expect(journal.length).toBe(1);
  });

  it("l'empreinte en majuscules est comparée sans casse", async () => {
    const bytes = bytesOf(50_000, 14);
    const { service, dest } = await setup({ files: { "m.gguf": bytes } });
    const [r] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes, sha256(bytes).toUpperCase())] });
    expect(r!.verified).toBe("sha256");
  });

  it("(20) un ETag de CDN faux ne rejette pas un fichier conforme ; un ETag égal au SHA ne sauve pas un fichier corrompu", async () => {
    const bytes = bytesOf(80_000, 15);
    {
      const { service, dest } = await setup({ files: { "m.gguf": bytes }, etag: '"ffff"' });
      const [r] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] });
      expect(r!.verified).toBe("sha256");
      await fake?.close();
    }
    {
      const { service, dest, journal } = await setup({ files: { "m.gguf": bytes }, corrupt: true, etag: `"${sha256(bytes)}"` });
      const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] }));
      expect(r.code).toBe("HASH_MISMATCH");
      expect(listAll(dest)).toEqual([]);
      expect(journal.length).toBe(1);
    }
  });
});

describe("(3-C) jeu de fragments : aucun renommage avant que TOUS soient vérifiés", () => {
  const names = ["m-00001-of-00003.gguf", "m-00002-of-00003.gguf", "m-00003-of-00003.gguf"];
  const parts = names.map((_, i) => bytesOf(70_000 + i * 1000, 20 + i));
  const files = Object.fromEntries(names.map((n, i) => [n, parts[i]!]));
  const expected = names.map((n, i) => one(n, parts[i]!));

  it("jeu conforme : les 3 fichiers sont renommés, vérifiés, 6 requêtes (résolution + CDN par fichier)", async () => {
    const { fake, service, dest, journal } = await setup({ files });
    const result = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected });
    expect(result.map((r) => r.name)).toEqual(names);
    expect(result.every((r) => r.verified === "sha256")).toBe(true);
    expect(listAll(dest).sort()).toEqual(names);
    expect(fake.log).toHaveLength(6);
    expect(journal).toEqual([]);
  });

  it("le 3ᵉ fragment est faux : 0 fichier renommé, les 3 .part supprimés", async () => {
    const { service, dest, journal } = await setup({ files, corrupt: [names[2]!] });
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected }));
    expect(r.code).toBe("HASH_MISMATCH");
    expect(listAll(dest)).toEqual([]);
    expect(journal.map((e) => e.path.split(/[\\/]/).pop()).sort()).toEqual(names.map((n) => `${n}.part`));
  });

  it("le 2ᵉ fragment est faux : le 3ᵉ n'est jamais demandé, 0 renommé", async () => {
    const { fake, service, dest } = await setup({ files, corrupt: [names[1]!] });
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: expected }));
    expect(r.code).toBe("HASH_MISMATCH");
    expect(listAll(dest)).toEqual([]);
    expect(fake.log.some((l) => l.path.includes("m-00003-of-00003"))).toBe(false);
  });
});

describe("(3-D) jamais d'écrasement, jamais de suppression d'un fichier de l'utilisateur", () => {
  it("cible présente : refus, 0 requête, octets ET date inchangés", async () => {
    const bytes = bytesOf(40_000, 30);
    const { fake, service, dest, journal } = await setup({ files: { "m.gguf": bytes } });
    const local = Buffer.from("le fichier de l'utilisateur");
    const target = join(dest, "m.gguf");
    writeFileSync(target, local);
    const past = new Date("2026-01-02T03:04:05Z");
    utimesSync(target, past, past);
    const before = statSync(target);
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] }));
    expect(r.code).toBe("ALREADY_PRESENT");
    expect(fake.log).toHaveLength(0);
    expect(readFileSync(target).equals(local)).toBe(true);
    expect(statSync(target).mtimeMs).toBe(before.mtimeMs);
    expect(journal).toEqual([]);
    // la taille locale diffère de la fiche : le message dit les DEUX tailles (Q5)
    expect(r.error.message).toContain(String(local.length));
    expect(r.error.message).toContain(String(bytes.length));
  });

  it("cible présente de même taille : refus sans le « différent » du message", async () => {
    const bytes = bytesOf(1000, 31);
    const { service, dest } = await setup({ files: { "m.gguf": bytes } });
    writeFileSync(join(dest, "m.gguf"), bytes);
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] }));
    expect(r.code).toBe("ALREADY_PRESENT");
    expect(r.error.message).not.toMatch(/annonce/);
  });

  it("un seul des deux fichiers présent : tout le jeu est refusé, l'autre n'est pas créé, aucun dossier", async () => {
    const a = bytesOf(1000, 32);
    const b = bytesOf(1000, 33);
    const { fake, service, dest } = await setup({ files: { "sub/x-00001-of-00002.gguf": a, "sub/x-00002-of-00002.gguf": b } });
    mkdirSync(join(dest, "sub"));
    writeFileSync(join(dest, "sub", "x-00002-of-00002.gguf"), "présent");
    const r = await code(
      service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("sub/x-00001-of-00002.gguf", a), one("sub/x-00002-of-00002.gguf", b)] }),
    );
    expect(r.code).toBe("ALREADY_PRESENT");
    expect(fake.log).toHaveLength(0);
    expect(listAll(dest)).toEqual(["sub/x-00002-of-00002.gguf"]);
  });

  it("un .part orphelin de CETTE opération est supprimé (journalisé) ; rien d'autre du dossier n'est touché", async () => {
    const bytes = bytesOf(30_000, 34);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes } });
    writeFileSync(join(dest, "m.gguf.part"), Buffer.alloc(123, 1)); // orphelin d'un processus tué
    const keep = {
      "autre.gguf.part": Buffer.alloc(77, 2),
      "autre.gguf": Buffer.alloc(88, 3),
      "notes.txt": Buffer.from("notes"),
      "m.gguf.part.bak": Buffer.alloc(5, 4),
    };
    const past = new Date("2026-02-03T04:05:06Z");
    for (const [n, b] of Object.entries(keep)) {
      writeFileSync(join(dest, n), b);
      utimesSync(join(dest, n), past, past);
    }
    const [r] = await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] });
    expect(r!.verified).toBe("sha256");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ bytes: 123 });
    expect(journal[0]!.path).toBe(join(dest, "m.gguf.part"));
    expect(journal[0]!.reason).toMatch(/orphelin/);
    for (const [n, b] of Object.entries(keep)) {
      expect(readFileSync(join(dest, n)).equals(b), n).toBe(true);
      expect(statSync(join(dest, n)).mtimeMs, n).toBe(past.getTime());
    }
  });

  it("un « .part » qui est un DOSSIER n'est jamais supprimé : refus", async () => {
    const bytes = bytesOf(1000, 35);
    const { service, dest, journal } = await setup({ files: { "m.gguf": bytes } });
    mkdirSync(join(dest, "m.gguf.part"));
    writeFileSync(join(dest, "m.gguf.part", "x"), "x");
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] }));
    expect(r.code).toBe("PART_EXISTS");
    expect(existsSync(join(dest, "m.gguf.part", "x"))).toBe(true);
    expect(journal).toEqual([]);
  });
});

describe("(3-E) révision épinglée et entrées attendues, refusées AVANT toute requête", () => {
  it("la requête vise resolve/<sha de 40>/, jamais main", async () => {
    const bytes = bytesOf(1000, 40);
    const { fake, service, dest } = await setup({ files: { "sub/m.gguf": bytes } });
    await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("sub/m.gguf", bytes)] });
    expect(fake.log[0]!.path).toBe(`/${REPO}/resolve/${SHA}/sub/m.gguf`);
    expect(fake.log.some((l) => l.path.includes("/resolve/main"))).toBe(false);
  });

  it("main, sha court, majuscules, vide, non hexadécimal : INVALID_REVISION, 0 requête, aucun dossier", async () => {
    const bytes = bytesOf(1000, 41);
    const { fake, guarded, service, dest } = await setup({ files: { "m.gguf": bytes } });
    const fresh = join(dest, "jamais");
    for (const revision of ["main", SHA.slice(0, 39), SHA.toUpperCase(), "", `${SHA.slice(0, 39)}g`, `${SHA}0`, undefined as never, 7 as never]) {
      const r = await code(service.downloadSet({ repo: REPO, revision, destDir: fresh, files: [one("m.gguf", bytes)] }));
      expect(r.code, String(revision)).toBe("INVALID_REVISION");
    }
    expect(fake.log).toHaveLength(0);
    expect(guarded.calls).toHaveLength(0);
    expect(existsSync(fresh)).toBe(false);
  });

  it("taille ou empreinte attendue invalide : INVALID_EXPECTED ; deux noms qui désignent le même fichier : DUPLICATE_TARGET", async () => {
    const bytes = bytesOf(1000, 42);
    const { fake, service, dest } = await setup({ files: { "m.gguf": bytes } });
    const fresh = join(dest, "jamais");
    const bad: unknown[] = [
      { name: "m.gguf", size: 0, sha256: null },
      { name: "m.gguf", size: -5, sha256: null },
      { name: "m.gguf", size: 1.5, sha256: null },
      { name: "m.gguf", size: "1000", sha256: null },
      { name: "m.gguf", size: 1000, sha256: "abc" },
      { name: "m.gguf", size: 1000, sha256: "g".repeat(64) },
      { name: "m.gguf", size: 1000, sha256: undefined },
    ];
    for (const f of bad) {
      const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: fresh, files: [f as never] }));
      expect(r.code, JSON.stringify(f)).toBe("INVALID_EXPECTED");
    }
    expect((await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: fresh, files: [] }))).code).toBe("INVALID_EXPECTED");
    const dup = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: fresh, files: [one("M.gguf", bytes), one("m.GGUF", bytes)] }));
    expect(dup.code).toBe("DUPLICATE_TARGET");
    expect(fake.log).toHaveLength(0);
    expect(existsSync(fresh)).toBe(false);
  });

  it("les noms sont validés d'abord (chantier 2) : un nom piégé reste refusé par son code", async () => {
    const { fake, service, dest } = await setup({ files: {} });
    const r = await code(service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [{ name: "../x.gguf", size: 5, sha256: null }] }));
    expect(r.code).toBe("INVALID_FILE");
    expect(fake.log).toHaveLength(0);
  });
});

describe("(3-G) réseau borné", () => {
  it("tous les appels vont au serveur factice (le garde-fou rendrait un autre hôte rouge)", async () => {
    const bytes = bytesOf(20_000, 50);
    const { fake, guarded, service, dest } = await setup({ files: { "m.gguf": bytes } });
    await service.downloadSet({ repo: REPO, revision: SHA, destDir: dest, files: [one("m.gguf", bytes)] });
    // Redirections MANUELLES (chantier 4, T3) : le garde-fou voit CHAQUE saut, comme le serveur factice.
    expect(guarded.calls).toHaveLength(2);
    expect(guarded.calls.every((u) => u.startsWith(fake.origin))).toBe(true);
    expect(fake.log.map((l) => l.status)).toEqual([302, 200]);
  });
});
