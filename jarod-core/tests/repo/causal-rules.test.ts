// SPECS-P5-CAUSAL.md §4 : règles PROPOSÉES (non gelées) de classement échec/succès et de signature d'échec — fonctions pures, déterministes.
// Ces tests décrivent le comportement de la règle PROPOSÉE ; elle n'est gelée qu'après validation des 40 + 40 exemples par l'utilisateur.
import { describe, expect, it } from "vitest";
import { classifyResult, failureLine, leadingJsonObject, mulberry32, normalizeText, signatureOf } from "../bench/causal-rules.js";

const j = (o: unknown) => JSON.stringify(o);

describe("classifyResult (règle proposée R1 : signaux STRUCTURELS seulement)", () => {
  it("terminal : code de sortie non nul ou erreur renseignée = échec ; code 0 sans erreur = succès", () => {
    expect(classifyResult("terminal", j({ output: "", exit_code: 1, error: null })).kind).toBe("echec");
    expect(classifyResult("terminal", j({ output: "", exit_code: -1, error: "timeout" })).kind).toBe("echec");
    expect(classifyResult("terminal", j({ output: "ok", exit_code: 0, error: null })).kind).toBe("succes");
    expect(classifyResult("terminal", j({ output: "x", exit_code: 0, error: "" })).kind).toBe("succes");
    expect(classifyResult("terminal", j({ output: "x", exit_code: 0, error: "boom" })).kind).toBe("echec");
  });

  it("success:false = échec ; success:true = succès ; status error/failed/timeout = échec", () => {
    expect(classifyResult("patch", j({ success: false, error: "no match" })).kind).toBe("echec");
    expect(classifyResult("patch", j({ success: true, diff: "--- a" })).kind).toBe("succes");
    expect(classifyResult("execute_code", j({ status: "error", output: "Traceback" })).kind).toBe("echec");
    expect(classifyResult("execute_code", j({ status: "success", output: "ok" })).kind).toBe("succes");
    expect(classifyResult("process", j({ status: "timeout" })).kind).toBe("echec");
  });

  it("ce que la règle ne peut PAS décider est INDÉTERMINÉ (exclu), jamais deviné", () => {
    expect(classifyResult("web_search", "<untrusted_tool_result source=\"web_search\">…").kind).toBe("indetermine");
    expect(classifyResult("x", "[1,2,3]").kind).toBe("indetermine");
    expect(classifyResult("x", "texte libre").kind).toBe("indetermine");
    expect(classifyResult("process", j({ status: "killed", session_id: "p1" })).kind).toBe("indetermine");
  });

  it("un objet JSON sans signal d'échec est un succès (lecture, écriture, recherche, liste de tâches ne signalent que leurs échecs)", () => {
    expect(classifyResult("read_file", j({ content: "1|a", total_lines: 1 })).kind).toBe("succes");
    expect(classifyResult("write_file", j({ bytes_written: 12, verified: true })).kind).toBe("succes");
    expect(classifyResult("todo", j({ todos: [] })).kind).toBe("succes");
    expect(classifyResult("read_file", j({ content: "", error: "File not found" })).kind).toBe("echec");
  });

  it("limite assumée et DITE : un test qui échoue derrière un tube (code 0) reste un succès structurel", () => {
    const r = classifyResult("terminal", j({ output: "# pass 7\n# fail 4", exit_code: 0, error: null }));
    expect(r.kind).toBe("succes");
  });

  it("le texte d'échec : erreur d'abord ; sinon la première ligne qui ressemble à une erreur, sinon la dernière ; sinon vide", () => {
    expect(classifyResult("terminal", j({ output: "ignored", exit_code: 2, error: "grave" })).text).toBe("grave");
    expect(classifyResult("terminal", j({ output: "=== titre ===\n\nls: cannot access 'x'\nsuite", exit_code: 2, error: null })).text).toBe("ls: cannot access 'x'");
    expect(classifyResult("terminal", j({ output: "=== titre ===\nligne\ndernière", exit_code: 1, error: null })).text).toBe("dernière");
    expect(classifyResult("terminal", j({ output: "", exit_code: 1, error: null })).text).toBe("");
  });

  it("un objet JSON suivi d'un avertissement de l'outil est lu (et non rangé en « indéterminé »)", () => {
    const withWarning = `${j({ output: "ls: cannot access 'x'", exit_code: 2, error: null })} [Tool loop warning: repeated_exact_failure_warning]`;
    const r = classifyResult("terminal", withWarning);
    expect(r.kind).toBe("echec");
    expect(r.exit).toBe(2);
    expect(classifyResult("terminal", `${j({ output: "ok", exit_code: 0, error: null })}\nnote {avec} des accolades`).kind).toBe("succes");
    expect(leadingJsonObject('{"a": "x}y"} suite')).toEqual({ a: "x}y" });
    expect(leadingJsonObject("pas json")).toBeNull();
    expect(leadingJsonObject('{"a": 1')).toBeNull();
  });
});

describe("normalizeText / signatureOf", () => {
  it("neutralise chemins, URL, nombres et identifiants hexadécimaux", () => {
    expect(normalizeText("Erreur: C:\\Users\\San\\a.txt introuvable (ligne 42)")).toBe("erreur: <chemin> introuvable (ligne #)");
    expect(normalizeText("GET https://exemple.test/a?b=1 -> 404")).toBe("get <url> -> #");
    expect(normalizeText("ls: cannot access '/d/Kama/x/y.ts': No such file")).toBe("ls: cannot access '<chemin>': no such file");
    expect(normalizeText("commit deadbeef0123 échoué")).toBe("commit <hex> échoué");
    // Même erreur, chemin absolu ou relatif : même texte normalisé.
    expect(normalizeText("C:\\py\\python.exe: can't open file 'S:\\x\\y.py'")).toBe(normalizeText(".\\py\\python.exe: can't open file 'S:\\z\\w.py'"));
  });

  it("signature = outil + 60 premiers caractères normalisés ; vide → code de sortie ; stable et sans contenu variable", () => {
    const a = classifyResult("terminal", j({ output: "ls: cannot access '/d/a/b.ts': No such file or directory", exit_code: 2, error: null }));
    const b = classifyResult("terminal", j({ output: "ls: cannot access '/s/zz/q.ts': No such file or directory", exit_code: 2, error: null }));
    expect(signatureOf("terminal", a)).toBe(signatureOf("terminal", b));
    expect(signatureOf("terminal", a).startsWith("terminal|")).toBe(true);
    expect(signatureOf("terminal", a).length).toBeLessThanOrEqual("terminal|".length + 60);
    const empty = classifyResult("terminal", j({ output: "", exit_code: 1, error: null }));
    expect(signatureOf("terminal", empty)).toBe("terminal|exit=1");
    expect(signatureOf("patch", classifyResult("patch", j({ success: false })))).toBe("patch|<vide>");
    expect(signatureOf(null, classifyResult(null, j({ success: false, error: "x" })))).toBe("?|x");
  });
});

describe("corrections avant gel (revalidation des paires 12, 13, 20, 23, 33)", () => {
  const sig = (output: string, exit = 2) => signatureOf("terminal", classifyResult("terminal", j({ output, exit_code: exit, error: null })));

  it("chemins RELATIFS entre guillemets et globs : même texte normalisé (paires 12, 20, 23)", () => {
    const a = normalizeText("ls: cannot access 'lib/site-packages/pyhanko/cli.py': No such file or directory");
    const b = normalizeText("ls: cannot access 'dist/': No such file or directory");
    const c = normalizeText("ls: cannot access 'lib/site-packages/*': No such file or directory");
    const d = normalizeText("ls: cannot access 'package.json': No such file or directory");
    expect(a).toBe("ls: cannot access '<chemin>': no such file or directory");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it("sans sur-normalisation : une apostrophe de mot, un mot composé ou un guillemet à espaces ne sont pas des chemins", () => {
    expect(normalizeText("python: can't open file 'x y'")).toBe("python: can't open file 'x y'");
    expect(normalizeText("erreur: le processus \"kama-one desktop.exe\" est introuvable")).toBe("erreur: le processus \"kama-one desktop.exe\" est introuvable");
    expect(normalizeText("utiliser and/or avec prudence")).toBe("utiliser and/or avec prudence");
    expect(normalizeText("pathspec '.' did not match")).toBe("pathspec '.' did not match");
  });

  it("l'extraction ignore les lignes de TITRE (=== … ===, ---, ##, > bannière npm) : paires 13 et 33", () => {
    expect(failureLine("=== ipcmain.on channels ===")).toBe("");
    expect(failureLine("=== ipcmain.on channels ===\n--- suite ---\n## titre\n> kama-one-v1@0.0.1-sprint1 build /x")).toBe("");
    expect(failureLine("=== titre ===\nerror: pathspec '.' did not match")).toBe("error: pathspec '.' did not match");
    expect(failureLine("=== titre ===\nligne utile\n--- fin ---")).toBe("ligne utile");
    // Bannières seules, même code de sortie : même signature (le titre ne dit rien de la cause) ; avec une vraie erreur : différente.
    expect(sig("=== ipcmain.on channels ===", 1)).toBe("terminal|exit=1");
    expect(sig("=== ipcmain.on( channels ===", 1)).toBe(sig("=== ipcmain.on channels ===", 1));
    expect(sig("=== chat-flow test in git? ===", 1)).not.toBe(sig("error: pathspec '.' did not match any file(s) known to git", 1));
  });
});

describe("mulberry32", () => {
  it("même graine = même suite ; graines différentes = suites différentes", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const sa = [a(), a(), a()];
    expect(sa).toEqual([b(), b(), b()]);
    expect(sa).not.toEqual([c(), c(), c()]);
    for (const v of sa) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });
});
