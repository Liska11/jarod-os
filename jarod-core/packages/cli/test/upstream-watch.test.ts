// `jarod upstream watch` : GET seulement, écritures confinées (upstream.json + docs/upstream-watch/), un dépôt en échec n'arrête pas les autres,
// contenu amont neutralisé dans le rapport. Aucun accès réseau : `fetch` est un faux qui répond selon l'URL demandée.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
import { cell, fenced, parseUpstream, pathMatches, renderReport, upstreamWatch, type FetchLike, type UpstreamEntry } from "../src/upstream-watch.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const NOW = new Date("2026-10-05T12:00:00Z");
const entry = (over: Partial<UpstreamEntry> = {}): UpstreamEntry => ({
  repo: "o/a",
  branche: "main",
  dernierShaVu: sha(1),
  cheminsSurveillés: ["skills/", "hermes_state_*.py"],
  dernièreExécution: "2026-10-01T00:00:00Z",
  ...over,
});
const apiCommit = (n: number, title: string, date = "2026-10-03T10:00:00Z") => ({ sha: sha(n), commit: { message: `${title}\n\ncorps`, committer: { date } } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

interface Call {
  url: URL;
  headers: Record<string, string>;
}
/** Dépôt `o/a` : 3 commits nouveaux (2 touchent skills/ ou hermes_state_*.py, 1 est sans intérêt), une release récente et une ancienne. */
function happyRoutes(calls: Call[] = []): FetchLike {
  return async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, headers: init.headers });
    const p = url.pathname;
    const q = url.searchParams;
    if (p === "/repos/o/a") return json({ license: { spdx_id: "MIT" } });
    if (p === "/repos/o/a/commits" && q.get("per_page") === "1") return json([apiCommit(5, "tête", "2026-10-04T00:00:00Z")]);
    if (p.startsWith("/repos/o/a/compare/")) {
      return json({
        status: "ahead",
        total_commits: 3,
        base_commit: apiCommit(1, "base", "2026-10-01T00:00:00Z"),
        commits: [apiCommit(2, "feat: skill | `pipe` <b>"), apiCommit(3, "chore: ci"), apiCommit(4, "fix: état")],
        files: [{ filename: "skills/x.md" }, { filename: "hermes_state_wal.py" }, { filename: ".github/ci.yml" }],
      });
    }
    if (p === "/repos/o/a/commits") {
      if (q.get("path") === "skills") return json([apiCommit(2, "feat")]);
      if (q.get("path") === "hermes_state_wal.py") return json([apiCommit(4, "fix"), apiCommit(99, "hors plage")]);
      return json([]);
    }
    if (p === `/repos/o/a/commits/${sha(2)}`) return json({ files: [{ filename: "skills/x.md" }] });
    if (p === `/repos/o/a/commits/${sha(4)}`) return json({ files: [{ filename: "hermes_state_wal.py" }, { filename: "tests/t.py" }] });
    if (p === "/repos/o/a/releases") {
      return json([
        { tag_name: "v2", name: "Deux", published_at: "2026-10-04T00:00:00Z", prerelease: false, draft: false, body: "notes ``` fin" },
        { tag_name: "v1", name: "Un", published_at: "2026-09-01T00:00:00Z", prerelease: false, draft: false, body: "ancienne" },
        { tag_name: "v3", name: "Brouillon", published_at: "2026-10-04T00:00:00Z", prerelease: false, draft: true, body: "x" },
      ]);
    }
    return json({ message: "Not Found" }, { status: 404 });
  };
}

let root = "";
let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarod-upstream-"));
  out = [];
  err = [];
  // Ces tests ne dépendent pas de l'environnement de la machine : une session de build qui porte GH_TOKEN doit pouvoir les lancer (le refus est testé à part).
  vi.stubEnv("GH_TOKEN", "");
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const writeUpstream = (entries: unknown) => writeFileSync(join(root, "upstream.json"), JSON.stringify(entries, null, 2));
const reports = () => (existsSync(join(root, "docs", "upstream-watch")) ? readdirSync(join(root, "docs", "upstream-watch")).sort() : []);
const firstReport = () => readFileSync(join(root, "docs", "upstream-watch", reports()[0]!), "utf8");

describe("upstream.json", () => {
  it("accepte le fichier du dépôt", () => {
    const list = parseUpstream(readFileSync(join(import.meta.dirname, "..", "..", "..", "upstream.json"), "utf8"));
    expect(list.map((e) => e.repo)).toEqual(["NousResearch/hermes-agent", "fathah/hermes-desktop", "anywhere-labs/dsh-desktop", "co-l/openfox"]);
    expect(list.map((e) => e.branche)).toEqual(["main", "main", "master", "develop"]);
  });
  it("refuse un SHA court, un chemin qui remonte, un dépôt en double", () => {
    expect(() => parseUpstream(JSON.stringify([entry({ dernierShaVu: "abc123" })]))).toThrow(/dernierShaVu/);
    expect(() => parseUpstream(JSON.stringify([entry({ cheminsSurveillés: ["../x"] })]))).toThrow(/cheminsSurveillés/);
    expect(() => parseUpstream(JSON.stringify([entry(), entry()]))).toThrow(/double/);
    expect(() => parseUpstream("[]")).toThrow();
  });
  it("motifs : fichier, dossier, glob, tout", () => {
    expect(pathMatches("skills/a/b.md", "skills/")).toBe(true);
    expect(pathMatches("skillset/a", "skills/")).toBe(false);
    expect(pathMatches("hermes_state_wal.py", "hermes_state_*.py")).toBe(true);
    expect(pathMatches("sub/hermes_state_wal.py", "hermes_state_*.py")).toBe(false);
    expect(pathMatches("hermes_state.py", "hermes_state_*.py")).toBe(false);
    expect(pathMatches("a/b", "a")).toBe(true);
    expect(pathMatches("zz", "*")).toBe(true);
  });
});

describe("jarod upstream watch", () => {
  it("rapporte les seuls commits pertinents, les releases récentes, et avance le curseur", async () => {
    writeUpstream([entry()]);
    const calls: Call[] = [];
    expect(await upstreamWatch({ root, fetch: happyRoutes(calls), now: () => NOW, token: "" })).toBe(0);
    expect(reports()).toEqual(["REPORT-2026-10-05.md"]);
    const md = firstReport();
    expect(md).toContain(`commit/${sha(2)})`);
    expect(md).toContain(`commit/${sha(4)})`);
    expect(md).not.toContain(`commit/${sha(3)})`); // chore: ci — aucun chemin surveillé
    expect(md).not.toContain(sha(99)); // hors de la plage comparée
    expect(md).toContain("hermes_state_wal.py<br>tests/t.py");
    expect(md).toContain("| SHA | Date | Titre | Chemins | Fichiers touchés | Pertinence jarod |");
    expect(md).toContain("[v2]");
    expect(md).not.toContain("[v1]"); // antérieure à la dernière exécution
    expect(md).not.toContain("Brouillon");
    const saved = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[];
    expect(saved[0]).toMatchObject({ dernierShaVu: sha(5), dernierShaVuDate: "2026-10-04T00:00:00Z", dernièreExécution: NOW.toISOString(), cheminsSurveillés: ["skills/", "hermes_state_*.py"] });
    expect(calls.every((c) => c.url.origin === "https://api.github.com")).toBe(true);
    // Les chemins n'ont été interrogés que parce qu'ils avaient changé (pas de requête par commit non pertinent).
    expect(calls.map((c) => c.url.searchParams.get("path")).filter(Boolean).sort()).toEqual(["hermes_state_wal.py", "skills"]);
    expect(calls.some((c) => c.url.pathname.endsWith(sha(3)))).toBe(false);
  });

  it("neutralise le contenu amont (tableau, lien, balise, bloc de code)", async () => {
    writeUpstream([entry()]);
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    const md = firstReport();
    expect(md).toContain("feat: skill \\| \\`pipe\\` &lt;b&gt;");
    expect(md).toContain("````text\nnotes ``` fin\n````"); // clôture plus longue que le contenu
  });

  it("n'envoie le jeton qu'à api.github.com, et jamais dans le rapport ni dans upstream.json", async () => {
    writeUpstream([entry()]);
    const calls: Call[] = [];
    await upstreamWatch({ root, fetch: happyRoutes(calls), now: () => NOW, token: "ghp_CANARI_SECRET" });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.url.origin).toBe("https://api.github.com");
      expect(c.headers.Authorization).toBe("Bearer ghp_CANARI_SECRET");
    }
    const all = [readFileSync(join(root, "upstream.json"), "utf8"), firstReport(), out.join("\n"), err.join("\n")].join("\n");
    expect(all).not.toContain("CANARI_SECRET");
    const anon: Call[] = [];
    await upstreamWatch({ root, fetch: happyRoutes(anon), now: () => NOW, token: "", dryRun: true });
    expect(anon.every((c) => c.headers.Authorization === undefined)).toBe(true);
  });

  it("GH_TOKEN (jeton de publication) dans l'environnement : la veille REFUSE, avant toute requête et sans rien écrire", async () => {
    writeUpstream([entry()]);
    const before = readFileSync(join(root, "upstream.json"), "utf8");
    const calls: Call[] = [];
    // Par l'option `env`…
    expect(await upstreamWatch({ root, fetch: happyRoutes(calls), now: () => NOW, env: { GH_TOKEN: "ghp_PUBLICATION", GITHUB_TOKEN: "ghp_VEILLE" } })).toBe(2);
    // … et par le vrai environnement du processus, via la commande.
    vi.stubEnv("GH_TOKEN", "ghp_PUBLICATION");
    expect(await main(["upstream", "watch", "--root", root, "--dry-run"])).toBe(2);
    expect(calls).toEqual([]);
    expect(reports()).toEqual([]);
    expect(readFileSync(join(root, "upstream.json"), "utf8")).toBe(before);
    expect(err.join("\n")).toContain("GH_TOKEN");
    expect(err.join("\n")).toContain("interdit dans une session de veille");
    expect([out.join("\n"), err.join("\n")].join("\n")).not.toContain("ghp_PUBLICATION");
    // GITHUB_TOKEN seul (la veille) reste accepté.
    expect(await upstreamWatch({ root, fetch: happyRoutes(calls), now: () => NOW, env: { GITHUB_TOKEN: "ghp_VEILLE" }, dryRun: true })).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.headers.Authorization === "Bearer ghp_VEILLE")).toBe(true);
  });

  it("l'échec d'un dépôt n'arrête pas les autres et ne touche pas son curseur", async () => {
    writeUpstream([entry({ repo: "o/down", dernierShaVu: sha(7) }), entry()]);
    const good = happyRoutes();
    const fetchFn: FetchLike = async (u, i) => (new URL(u).pathname.startsWith("/repos/o/down") ? json({ message: "boom" }, { status: 500 }) : good(u, i));
    expect(await upstreamWatch({ root, fetch: fetchFn, now: () => NOW, token: "", retryDelayMs: 1 })).toBe(1);
    const saved = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[];
    expect(saved[0]).toMatchObject({ repo: "o/down", dernierShaVu: sha(7), dernièreExécution: "2026-10-01T00:00:00Z" });
    expect(saved[1]).toMatchObject({ repo: "o/a", dernierShaVu: sha(5) });
    const md = firstReport();
    expect(md).toContain("**échec**");
    expect(md).toContain("## o/a (main)");
  });

  it("reprend UNE fois après un délai dépassé, puis abandonne", async () => {
    writeUpstream([entry()]);
    let n = 0;
    const slow: FetchLike = (_u, init) => {
      n++;
      return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    };
    expect(await upstreamWatch({ root, fetch: slow, now: () => NOW, token: "", timeoutMs: 30, retryDelayMs: 1 })).toBe(1);
    expect(n).toBe(2); // 1 essai + 1 reprise
    // Tout a échoué : ni rapport ni curseur touchés, la cause est dite.
    expect(reports()).toEqual([]);
    expect(out.join("\n")).toContain("délai de 0.03 s dépassé");
    expect(JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"))).toEqual([entry()]);
  });

  it("ne reprend pas sur 403 ; limite de débit : message utile", async () => {
    writeUpstream([entry()]);
    let n = 0;
    const limited: FetchLike = async () => {
      n++;
      return json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } });
    };
    expect(await upstreamWatch({ root, fetch: limited, now: () => NOW, token: "", dryRun: true })).toBe(1);
    expect(n).toBe(1);
    expect(out.join("\n")).toContain("GITHUB_TOKEN");
  });

  it("licence github : autorisé quand MIT ; sinon le portage est GELÉ, et il le reste même quand la licence revient", async () => {
    writeUpstream([entry()]);
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    expect((JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[])[0]!.portage).toBe("autorisé");
    const good = happyRoutes();
    const noLicense: FetchLike = async (u, i) => (new URL(u).pathname === "/repos/o/a" ? json({ license: null }) : good(u, i));
    await upstreamWatch({ root, fetch: noLicense, now: () => NOW, token: "" });
    expect(reports().length).toBe(2);
    expect(readFileSync(join(root, "docs", "upstream-watch", "REPORT-2026-10-05-2.md"), "utf8")).toContain("⛔ PORTAGE GELÉ");
    expect((JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[])[0]!.portage).toBe("gelé");
    // La licence revient : le gel n'est levé que par une main humaine.
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    expect((JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[])[0]!.portage).toBe("gelé");
    expect(readFileSync(join(root, "docs", "upstream-watch", "REPORT-2026-10-05-3.md"), "utf8")).toContain("Portage toujours gelé");
  });

  describe("licence lue dans le README (dépôt sans fichier LICENSE)", () => {
    const readme = (body: string) => async (u: string, i: Parameters<FetchLike>[1]) => {
      const url = new URL(u);
      if (url.pathname === "/repos/o/a") return json({ license: null });
      if (url.pathname === "/repos/o/a/readme") return json({ sha: "abcdef0123456789", encoding: "base64", content: Buffer.from(body).toString("base64") });
      return happyRoutes()(u, i);
    };
    const readmeEntry = () => entry({ licenceSource: "readme" });

    it("mention MIT présente : autorisé, citation et SHA du blob dans le rapport", async () => {
      writeUpstream([readmeEntry()]);
      await upstreamWatch({ root, fetch: readme("# o/a\n\n## Usage\nx\n\n## License\n\nMIT © co-l\n\n## Autre\ny"), now: () => NOW, token: "" });
      const md = firstReport();
      expect(md).toContain("README (section License) : « MIT © co-l » (blob abcdef0) → ok");
      expect(md).toContain("portage : **autorisé**");
      expect(md).not.toContain("PORTAGE GELÉ");
    });

    it("la mention disparaît (ou la section, ou le README) : portage GELÉ", async () => {
      for (const body of ["## License\n\nAll rights reserved.\n", "# Seulement un titre\nMIT dans le texte hors section\n"]) {
        rmSync(join(root, "docs"), { recursive: true, force: true });
        writeUpstream([readmeEntry()]);
        await upstreamWatch({ root, fetch: readme(body), now: () => NOW, token: "" });
        expect(firstReport()).toContain("⛔ PORTAGE GELÉ");
        expect((JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[])[0]!.portage).toBe("gelé");
      }
      rmSync(join(root, "docs"), { recursive: true, force: true });
      writeUpstream([readmeEntry()]);
      const gone: FetchLike = async (u, i) => (new URL(u).pathname === "/repos/o/a/readme" ? json({ message: "Not Found" }, { status: 404 }) : readme("")(u, i));
      await upstreamWatch({ root, fetch: gone, now: () => NOW, token: "" });
      expect(firstReport()).toContain("n'a plus de README");
    });

    it("une erreur réseau sur le README fait ÉCHOUER le dépôt (pas de gel sur une panne passagère)", async () => {
      writeUpstream([readmeEntry()]);
      const down: FetchLike = async (u, i) => (new URL(u).pathname === "/repos/o/a/readme" ? json({}, { status: 500 }) : readme("")(u, i));
      expect(await upstreamWatch({ root, fetch: down, now: () => NOW, token: "", retryDelayMs: 1 })).toBe(1);
      expect((JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[])[0]!.portage).toBeUndefined();
    });
  });

  it("--dry-run n'écrit rien ; un second passage le même jour n'écrase pas le premier rapport", async () => {
    writeUpstream([entry()]);
    const before = readFileSync(join(root, "upstream.json"), "utf8");
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "", dryRun: true });
    expect(readFileSync(join(root, "upstream.json"), "utf8")).toBe(before);
    expect(reports()).toEqual([]);
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    expect(reports()).toEqual(["REPORT-2026-10-05-2.md", "REPORT-2026-10-05.md"]);
  });

  it("ne crée rien ailleurs que upstream.json et docs/upstream-watch/", async () => {
    writeUpstream([entry()]);
    mkdirSync(join(root, "autre"));
    await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "" });
    expect(readdirSync(root).sort()).toEqual(["autre", "docs", "upstream.json"]);
    expect(readdirSync(join(root, "docs"))).toEqual(["upstream-watch"]);
    expect(readdirSync(join(root, "autre"))).toEqual([]);
  });

  it("première exécution : base = dernier commit avant la fenêtre ; « tout » surveillé liste tous les commits", async () => {
    writeUpstream([entry({ dernierShaVu: null, dernièreExécution: null, cheminsSurveillés: ["*"] })]);
    const calls: Call[] = [];
    const routes = happyRoutes();
    const fetchFn: FetchLike = async (u, i) => {
      const url = new URL(u);
      if (url.pathname === "/repos/o/a/commits" && url.searchParams.get("until")) {
        calls.push({ url, headers: i.headers });
        return json([apiCommit(1, "avant la fenêtre", "2026-08-01T00:00:00Z")]);
      }
      return routes(u, i);
    };
    expect(await upstreamWatch({ root, fetch: fetchFn, now: () => NOW, token: "" })).toBe(0);
    expect(calls[0]!.url.searchParams.get("until")).toBe("2026-09-05T12:00:00.000Z");
    const md = firstReport();
    for (const n of [2, 3, 4]) expect(md).toContain(`commit/${sha(n)})`);
    expect(md).toContain("fenêtre depuis 2026-09-05T12:00:00.000Z");
  });

  it("SHA connu introuvable (historique réécrit) : repli sur la fenêtre, noté", async () => {
    writeUpstream([entry()]);
    const routes = happyRoutes();
    let first = true;
    const fetchFn: FetchLike = async (u, i) => {
      const url = new URL(u);
      if (url.pathname.startsWith("/repos/o/a/compare/") && first) {
        first = false;
        return json({ message: "Not Found" }, { status: 404 });
      }
      if (url.pathname === "/repos/o/a/commits" && url.searchParams.get("until")) return json([apiCommit(1, "base", "2026-08-01T00:00:00Z")]);
      return routes(u, i);
    };
    expect(await upstreamWatch({ root, fetch: fetchFn, now: () => NOW, token: "" })).toBe(0);
    expect(firstReport()).toContain("introuvable (historique réécrit ?)");
  });

  it("plage trop grande pour /compare : jamais « rien de pertinent », chaque chemin est interrogé par dates", async () => {
    writeUpstream([entry({ cheminsSurveillés: ["hermes_state_*.py", "skills/"] })]);
    const calls: Call[] = [];
    const routes = happyRoutes(calls);
    const full = Array.from({ length: 100 }, (_, i) => apiCommit(1000 + i, `bruit ${i}`));
    const fetchFn: FetchLike = async (u, i) => {
      const url = new URL(u);
      if (url.pathname.startsWith("/repos/o/a/compare/")) {
        return json({ status: "ahead", total_commits: 10000, base_commit: apiCommit(1, "base", "2026-10-01T00:00:00Z"), commits: full, files: Array.from({ length: 100 }, (_, n) => ({ filename: `bruit/${n}` })) });
      }
      if (url.pathname === "/repos/o/a/contents/") return json([{ path: "hermes_state_wal.py", type: "file" }, { path: "hermes_state_x.txt", type: "file" }, { path: "skills", type: "dir" }]);
      if (url.pathname === "/repos/o/a/commits" && url.searchParams.get("path") === "hermes_state_wal.py") {
        calls.push({ url, headers: i.headers });
        return json([apiCommit(4, "fix wal")]);
      }
      return routes(u, i);
    };
    expect(await upstreamWatch({ root, fetch: fetchFn, now: () => NOW, token: "" })).toBe(0);
    const md = firstReport();
    expect(md).toContain("Plage trop grande pour la comparaison (10000 commits)");
    expect(md).toContain("fix wal");
    expect(md).toContain("feat"); // skills/ : interrogé même si la comparaison tronquée ne l'a pas listé
    expect(md).not.toContain("Aucun commit pertinent");
    const wal = calls.find((c) => c.url.searchParams.get("path") === "hermes_state_wal.py")!;
    expect(wal.url.searchParams.get("until")).toBe("2026-10-04T00:00:00Z");
    expect(wal.url.searchParams.get("since")).toBe("2026-10-01T00:00:00Z");
  });

  it("--repo : un seul dépôt est interrogé, les autres gardent leur curseur ; dépôt inconnu : code 2", async () => {
    writeUpstream([entry({ repo: "o/other", dernierShaVu: sha(7) }), entry()]);
    const calls: Call[] = [];
    expect(await upstreamWatch({ root, fetch: happyRoutes(calls), now: () => NOW, token: "", repo: "O/A" })).toBe(0);
    expect(calls.every((c) => c.url.pathname.startsWith("/repos/o/a"))).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8")) as UpstreamEntry[];
    expect(saved[0]).toMatchObject({ repo: "o/other", dernierShaVu: sha(7), dernièreExécution: "2026-10-01T00:00:00Z" });
    expect(saved[1]).toMatchObject({ repo: "o/a", dernierShaVu: sha(5) });
    expect(await upstreamWatch({ root, fetch: happyRoutes(), now: () => NOW, token: "", repo: "x/y" })).toBe(2);
  });

  it("sans upstream.json : code 2, rien d'écrit", async () => {
    expect(await upstreamWatch({ root, fetch: happyRoutes(), token: "" })).toBe(2);
    expect(err.join("\n")).toContain("upstream.json introuvable");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("rapport", () => {
  it("cell et fenced neutralisent le contenu amont", () => {
    expect(cell("a|b\nc‮`d`[x](http://e)")).toBe("a\\|b c\\`d\\`\\[x\\](http://e)");
    expect(fenced("x ```` y")).toBe("`````text\nx ```` y\n`````");
    expect(cell("z".repeat(500)).length).toBeLessThanOrEqual(120);
  });
  it("sans commit pertinent : le dit", () => {
    const md = renderReport([{ entry: entry(), ok: true, license: "MIT", head: { sha: sha(5), date: "2026-10-04T00:00:00Z" }, base: { sha: sha(1), note: "dernier SHA vu" }, totalCommits: 0, commits: [], releases: [], notes: [] }], NOW);
    expect(md).toContain("Aucun commit pertinent sur 0 commit(s) amont.");
  });
});

describe("CLI", () => {
  it("`jarod upstream` sans « watch » : usage, code 2, aucun réseau", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    expect(await main(["upstream"])).toBe(2);
    expect(err.join("\n")).toContain("Usage: jarod upstream watch");
    expect(f).not.toHaveBeenCalled();
  });
  it("--max-details invalide : code 2", async () => {
    expect(await main(["upstream", "watch", "--max-details", "x"])).toBe(2);
  });
});
