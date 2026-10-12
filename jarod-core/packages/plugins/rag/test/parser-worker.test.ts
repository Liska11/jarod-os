// Lot B ④ : protocole de worker + repli, avec un FAUX worker Node (aucun Python, aucun téléchargement).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BuiltinParser, ParserError, WorkerError, WorkerParser, type WorkerParserConfig, withFallback } from "../src/index.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docling-worker.mjs");
const opened: WorkerParser[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
  await cleanup();
});

function make(over: Partial<WorkerParserConfig> = {}, dir = tempDir()) {
  const parser = new WorkerParser({
    name: "fake-docling",
    command: process.execPath,
    args: [FAKE],
    extensions: [".pdf", ".docx", ".md"],
    allowPath: (p) => p.startsWith(dir),
    timeoutMs: 5_000,
    startTimeoutMs: 10_000,
    ...over,
  });
  opened.push(parser);
  const file = (name: string, content: string | Buffer) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  return { parser, dir, file };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function dies(pid: number, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof WorkerError || e instanceof ParserError ? e.code : `AUTRE:${(e as Error).name}`;
  }
  return "AUCUNE";
};

describe("WorkerParser — contrat", () => {
  it("rend un ParsedDocument dont le manifeste est celui du FICHIER (hash, taille) et du parseur annoncé", async () => {
    const { parser, file } = make();
    const content = "# Titre\nun paragraphe\n# Second\nfin\n";
    const path = file("a.pdf", content);
    const { manifest, text } = await parser.parse({ path });
    expect(text).toBe(content);
    expect(manifest.source).toMatchObject({ sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) });
    expect(manifest.parser).toEqual({ name: "fake-docling", version: "1.0.0" });
    expect(manifest.sections.map((s) => s.title)).toEqual(["Titre", "Second"]);
    expect(parser.info()).toEqual({ name: "fake-docling", version: "1.0.0" });
    expect(parser.available).toBe(true);
  });

  it("accepte par extension, sans deviner ; des octets en mémoire passent par un fichier temporaire à l'adaptateur", async () => {
    const { parser } = make({ allowPath: () => false });
    expect(parser.accepts("rapport.PDF")).toBe(true);
    expect(parser.accepts("notes.txt")).toBe(false);
    const { text } = await parser.parse({ bytes: new TextEncoder().encode("# Octets\nok"), name: "x.docx" });
    expect(text).toBe("# Octets\nok");
  });

  it("plusieurs documents de suite et EN PARALLÈLE : un seul processus, réponses bien appariées", async () => {
    const { parser, file } = make();
    const paths = [1, 2, 3, 4].map((i) => file(`d${i}.pdf`, `# Doc ${i}\ncorps ${i}`));
    const out = await Promise.all(paths.map((path) => parser.parse({ path })));
    expect(out.map((o) => o.manifest.sections[0]!.title)).toEqual(["Doc 1", "Doc 2", "Doc 3", "Doc 4"]);
    const pid = parser.pid;
    await parser.parse({ path: paths[0]! });
    expect(parser.pid).toBe(pid);
  });

  it("déterminisme : le même fichier deux fois donne le même manifeste", async () => {
    const { parser, file } = make();
    const path = file("a.pdf", "# A\ntexte");
    const a = await parser.parse({ path });
    const b = await parser.parse({ path });
    expect(b).toEqual(a);
  });
});

describe("WorkerParser — robustesse (chaque cas rattrapé, aucun orphelin)", () => {
  it("worker absent : WORKER_MISSING, indisponible, sans lancer quoi que ce soit", async () => {
    const { parser, file } = make({ command: join(tempDir(), "absent.exe") });
    expect(parser.available).toBe(false);
    expect(await codeOf(parser.parse({ path: file("a.pdf", "x") }))).toBe("WORKER_MISSING");
    expect(parser.pid).toBeNull();
  });

  it("échec de lancement : WORKER_SPAWN (la commande n'est pas un exécutable)", async () => {
    const dir = tempDir();
    const notExe = join(dir, "pas-un-programme.bin");
    writeFileSync(notExe, "ceci n'est pas un exécutable");
    const { parser, file } = make({ command: notExe, args: [] }, dir);
    expect(await codeOf(parser.parse({ path: file("a.pdf", "x") }))).toBe("WORKER_SPAWN");
  });

  it("mort en cours de parse : WORKER_EXIT, le worker suivant est relancé et fonctionne", async () => {
    const { parser, file } = make();
    const first = parser.pid;
    expect(await codeOf(parser.parse({ path: file("crash.pdf", "CRASH\nx") }))).toBe("WORKER_EXIT");
    expect(parser.pid).toBeNull();
    expect(first).toBeNull();
    const ok = await parser.parse({ path: file("ok.pdf", "# Reprise\nok") });
    expect(ok.manifest.sections[0]!.title).toBe("Reprise");
    expect(parser.available).toBe(true);
  });

  it("dépassement de délai : WORKER_TIMEOUT, arrêt forcé (pid mort), reprise possible", async () => {
    const { parser, file } = make({ timeoutMs: 400 });
    await parser.parse({ path: file("ok.pdf", "# A") });
    const pid = parser.pid!;
    expect(alive(pid)).toBe(true);
    expect(await codeOf(parser.parse({ path: file("hang.pdf", "HANG\nx") }))).toBe("WORKER_TIMEOUT");
    expect(await dies(pid)).toBe(true);
    expect((await parser.parse({ path: file("ok2.pdf", "# B") })).text).toBe("# B");
  });

  it("le petit-enfant du worker ne survit pas à l'arrêt (arbre de processus tué)", async () => {
    const { parser, file, dir } = make({ timeoutMs: 1_500 });
    const pidFile = join(dir, "grandchild.pid");
    const workerPid = (await parser.parse({ path: file("ok.pdf", "# A") }), parser.pid!);
    expect(await codeOf(parser.parse({ path: file("gc.pdf", `HANG-GRANDCHILD\n${pidFile}`) }))).toBe("WORKER_TIMEOUT");
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    expect(await dies(workerPid)).toBe(true);
    expect(await dies(grandchild)).toBe(true);
  });

  it("ligne non JSON, manifeste invalide, empreinte fausse, empan hors texte, mauvais identifiant : WORKER_BAD_RESPONSE, worker arrêté", async () => {
    for (const head of ["GARBAGE", "BADMANIFEST", "WRONGHASH", "BADSPAN", "WRONGID"]) {
      const { parser, file } = make();
      expect(await codeOf(parser.parse({ path: file("x.pdf", `${head}\ncontenu`) })), head).toBe("WORKER_BAD_RESPONSE");
      expect(parser.pid, head).toBeNull();
    }
  });

  it("un `hello` d'un autre parseur que celui attendu est refusé", async () => {
    const { parser, file } = make({ env: { FAKE_HELLO: "wrong-name" } });
    expect(await codeOf(parser.parse({ path: file("a.pdf", "x") }))).toBe("WORKER_BAD_RESPONSE");
  });

  it("fichier trop gros : WORKER_TOO_LARGE AVANT tout envoi (aucun processus lancé)", async () => {
    const { parser, file } = make({ maxBytes: 100 });
    expect(await codeOf(parser.parse({ path: file("gros.pdf", Buffer.alloc(101, 65)) }))).toBe("WORKER_TOO_LARGE");
    expect(await codeOf(parser.parse({ bytes: new Uint8Array(101), name: "gros.pdf" }))).toBe("WORKER_TOO_LARGE");
    expect(parser.pid).toBeNull();
  });

  it("chemin refusé par la garde d'espace de travail : WORKER_PATH_REFUSED AVANT tout envoi", async () => {
    const { parser } = make();
    const outside = join(tempDir(), "dehors.pdf");
    writeFileSync(outside, "x");
    expect(await codeOf(parser.parse({ path: outside }))).toBe("WORKER_PATH_REFUSED");
    expect(parser.pid).toBeNull();
  });

  it("fichier illisible : WORKER_UNREADABLE", async () => {
    const { parser, dir } = make();
    expect(await codeOf(parser.parse({ path: join(dir, "inexistant.pdf") }))).toBe("WORKER_UNREADABLE");
  });

  it("erreur DOCUMENT rendue par le worker : code assaini, AUCUN texte du document ni message libre, le worker reste utilisable", async () => {
    const { parser, file } = make();
    const secret = "TEXTE-CONFIDENTIEL-DU-DOCUMENT";
    let message = "";
    try {
      await parser.parse({ path: file("e.pdf", `ERR\n${secret}`) });
    } catch (e) {
      message = `${(e as WorkerError).code}|${(e as Error).message}|${(e as Error).stack ?? ""}`;
      expect((e as WorkerError).code).toBe("WORKER_ERROR:corrupt-file");
    }
    expect(message).not.toContain(secret);
    expect(await codeOf(parser.parse({ path: file("e2.pdf", `ERR-BADCODE\n${secret}`) }))).toBe("WORKER_ERROR:unknown");
    const pid = parser.pid;
    expect(pid).not.toBeNull();
    expect((await parser.parse({ path: file("ok.pdf", "# Encore") })).text).toBe("# Encore");
    expect(parser.pid).toBe(pid);
    // Les erreurs de document ne comptent pas comme des échecs de processus, même nombreuses.
    for (let i = 0; i < 5; i++) await codeOf(parser.parse({ path: file(`e${i}.pdf`, "ERR\nx") }));
    expect(parser.available).toBe(true);
  });

  it("le stderr du worker est jeté : rien n'en remonte", async () => {
    const { parser, file } = make();
    const out = await parser.parse({ path: file("s.pdf", "STDERR\nSECRET-STDERR") });
    expect(out.manifest.errors).toEqual([]);
  });

  it("3 échecs de processus de suite : indisponible pour de bon (WORKER_UNAVAILABLE) ; un succès entre deux remet le compte à zéro", async () => {
    const a = make();
    const crash = (n: string) => a.parser.parse({ path: a.file(n, "CRASH\nx") });
    await codeOf(crash("1.pdf"));
    await codeOf(crash("2.pdf"));
    await a.parser.parse({ path: a.file("ok.pdf", "# ok") });
    await codeOf(crash("3.pdf"));
    await codeOf(crash("4.pdf"));
    expect(a.parser.available).toBe(true);

    const b = make();
    for (const n of ["1", "2", "3"]) await codeOf(b.parser.parse({ path: b.file(`${n}.pdf`, "CRASH\nx") }));
    expect(b.parser.available).toBe(false);
    expect(await codeOf(b.parser.parse({ path: b.file("ok.pdf", "# ok") }))).toBe("WORKER_UNAVAILABLE");
  });

  it("un AbortSignal arrête le worker et rejette sans compter comme un échec", async () => {
    const { parser, file } = make({ timeoutMs: 30_000 });
    await parser.parse({ path: file("ok.pdf", "# A") });
    const pid = parser.pid!;
    const ac = new AbortController();
    const pending = parser.parse({ path: file("hang.pdf", "HANG\nx") }, ac.signal);
    setTimeout(() => ac.abort(), 200);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await dies(pid)).toBe(true);
    for (let i = 0; i < 4; i++) {
      const c = new AbortController();
      const p = parser.parse({ path: file(`h${i}.pdf`, "HANG\nx") }, c.signal);
      setTimeout(() => c.abort(), 150);
      await p.catch(() => {});
    }
    expect(parser.available).toBe(true);
    await expect(parser.parse({ path: file("deja.pdf", "# A") }, AbortSignal.abort())).rejects.toBeTruthy();
  });

  it("close() termine le worker sans orphelin ; le fournisseur reste réutilisable", async () => {
    const { parser, file } = make();
    await parser.parse({ path: file("a.pdf", "# A") });
    const pid = parser.pid!;
    await parser.close();
    expect(parser.pid).toBeNull();
    expect(await dies(pid)).toBe(true);
    expect((await parser.parse({ path: file("b.pdf", "# B") })).text).toBe("# B");
  });
});

describe("WorkerParser — environnement du worker", () => {
  it("liste blanche : un secret du parent n'y figure pas ; hors ligne, threads bornés, variables ajoutées transmises", async () => {
    process.env.JAROD_SECRET_TEST = "sk-ne-doit-pas-fuiter";
    try {
      const { parser, file } = make({ threads: 3, env: { FAKE_CUSTOM: "cache-modeles" } });
      const out = JSON.parse((await parser.parse({ path: file("env.pdf", "ENV\nx") })).text);
      expect(out).toEqual({ secret: null, offline: "1", threads: "3", custom: "cache-modeles", hasPath: true });
    } finally {
      delete process.env.JAROD_SECRET_TEST;
    }
  });
});

describe("withFallback — tout échec du primaire se replie sur builtin, jamais en silence", () => {
  const builtin = new BuiltinParser();

  it("primaire sain : son résultat, sans erreur ajoutée", async () => {
    const { parser, file } = make();
    const p = withFallback(parser, builtin);
    const out = await p.parse({ path: file("a.md", "# A\ntexte") });
    expect(out.manifest.parser.name).toBe("fake-docling");
    expect(out.manifest.errors).toEqual([]);
  });

  it("échec du worker sur un fichier que builtin lit : repli builtin, code de l'échec dans manifest.errors", async () => {
    for (const [head, code] of [
      ["CRASH", "WORKER_EXIT"],
      ["HANG", "WORKER_TIMEOUT"],
      ["GARBAGE", "WORKER_BAD_RESPONSE"],
      ["ERR", "WORKER_ERROR:corrupt-file"],
    ] as const) {
      // Un worker neuf par cas : trois échecs de processus de suite le rendraient indisponible (autre test).
      const { parser, file } = make({ timeoutMs: 300 });
      const p = withFallback(parser, builtin);
      const content = `${head}\ncorps du fichier`;
      const out = await p.parse({ path: file(`${head}.md`, content) });
      expect(out.text, head).toBe(content); // texte du parseur builtin
      expect(out.manifest.parser.name, head).toBe("builtin");
      expect(out.manifest.errors, head).toContainEqual({ code, page: null });
    }
  });

  it("trop gros / chemin refusé sur un fichier lisible par builtin : repli avec le code", async () => {
    const big = make({ maxBytes: 10 });
    const out = await withFallback(big.parser, builtin).parse({ path: big.file("gros.md", "x".repeat(50)) });
    expect(out.manifest.errors).toContainEqual({ code: "WORKER_TOO_LARGE", page: null });
    const guarded = make({ allowPath: () => false });
    const out2 = await withFallback(guarded.parser, builtin).parse({ path: guarded.file("a.md", "# A") });
    expect(out2.manifest.errors).toContainEqual({ code: "WORKER_PATH_REFUSED", page: null });
  });

  it("échec sur un format que builtin ne sait pas lire (PDF, DOCX) : échec net, AUCUN texte", async () => {
    const { parser, file } = make();
    const p = withFallback(parser, builtin);
    expect(await codeOf(p.parse({ path: file("crash.pdf", "CRASH\nx") }))).toBe("PARSER_UNAVAILABLE:WORKER_EXIT");
    expect(await codeOf(p.parse({ bytes: new TextEncoder().encode("GARBAGE\nx"), name: "r.docx" }))).toBe("PARSER_UNAVAILABLE:WORKER_BAD_RESPONSE");
  });

  it("worker absent ou hors service : repli direct avec WORKER_UNAVAILABLE ; extension inconnue du primaire : builtin sans erreur", async () => {
    const { parser, file } = make({ command: join(tempDir(), "absent.exe") });
    const p = withFallback(parser, builtin);
    const md = await p.parse({ path: file("a.md", "# A") });
    expect(md.manifest.parser.name).toBe("builtin");
    expect(md.manifest.errors).toContainEqual({ code: "WORKER_UNAVAILABLE", page: null });
    expect(await codeOf(p.parse({ path: file("a.pdf", "x") }))).toBe("PARSER_UNAVAILABLE:WORKER_UNAVAILABLE");
    const txt = await p.parse({ path: file("n.txt", "simple") });
    expect(txt.manifest.errors).toEqual([]);
    expect(p.accepts("a.pdf")).toBe(true);
    expect(p.accepts("a.txt")).toBe(true);
    expect(p.accepts("a.xyz")).toBe(false);
  });

  it("l'arrêt demandé par l'appelant n'est pas un échec du primaire : pas de repli", async () => {
    const { parser, file } = make({ timeoutMs: 30_000 });
    const p = withFallback(parser, builtin);
    const ac = new AbortController();
    const pending = p.parse({ path: file("hang.md", "HANG\nx") }, ac.signal);
    setTimeout(() => ac.abort(), 200);
    await expect(pending).rejects.toBeTruthy();
  });

  it("aucun texte de document dans les erreurs levées", async () => {
    const { parser, file } = make();
    const secret = "TEXTE-CONFIDENTIEL-DU-DOCUMENT";
    try {
      await withFallback(parser, builtin).parse({ path: file("e.pdf", `ERR\n${secret}`) });
    } catch (e) {
      expect(`${(e as Error).message}|${(e as ParserError).code}`).not.toContain(secret);
      return;
    }
    throw new Error("attendu : un échec net");
  });
});
