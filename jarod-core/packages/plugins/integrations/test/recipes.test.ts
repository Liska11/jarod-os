import { describe, expect, it } from "vitest";
import {
  compileRecipe,
  importPinokioScript,
  type PlanCall,
  RecipeError,
  referencedVars,
  runPlan,
  substitute,
  TemplateError,
} from "../src/index.js";

const ok = (content = "ok") => ({ content, isError: false });

function recorder(answer: (c: PlanCall) => { content: string; isError: boolean } = () => ok()) {
  const calls: PlanCall[] = [];
  return { calls, execute: async (c: PlanCall) => (calls.push(c), answer(c)) };
}

const base = {
  schema: 1,
  id: "demo.tool",
  name: "Demo",
  version: "1.0.0",
  vars: ["name"],
  steps: [
    { id: "w", verb: "fs.write", params: { path: "out/{{name}}.txt", content: "hello {{name}}" } },
    { id: "s", verb: "shell.run", params: { command: ["echo {{name}}", "echo done"] } },
  ],
};

describe("substitution sans évaluation", () => {
  it("remplace des variables nommées, en un seul passage", () => {
    expect(substitute("a {{x}} b {{ y }}", { x: "1", y: "2" })).toBe("a 1 b 2");
    // une valeur qui ressemble à un gabarit reste du texte : pas de second passage
    expect(substitute("{{x}}", { x: "{{y}}", y: "PWNED" })).toBe("{{y}}");
  });

  it("refuse toute expression, appel, coffre ou variable inconnue", () => {
    for (const bad of ["{{ 1 + 1 }}", "{{x.y}}", "{{x()}}", "{{secret:TOKEN}}", "{{ x ? a : b }}", "{{}}", "{{x"]) {
      expect(() => substitute(bad, { x: "1" }), bad).toThrow(TemplateError);
    }
    expect(() => substitute("{{missing}}", {})).toThrow(/inconnue/);
  });

  it("liste les variables référencées", () => {
    expect(referencedVars("{{a}} {{ b }} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("compilation : le plan est connu avant toute exécution", () => {
  it("traduit les verbes en appels d'outils de la porte unique, et force l'isolation du shell", () => {
    const plan = compileRecipe(base);
    expect(plan.steps.map((s) => [s.id, s.tool])).toEqual([
      ["w", "write_file"],
      ["s.0", "run_shell"],
      ["s.1", "run_shell"],
    ]);
    expect(plan.steps[1]!.args).toMatchObject({ isolation: "workspace" });
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(compileRecipe(base).digest).toBe(plan.digest);
  });

  it("refuse les verbes hors liste blanche, nommés un par un", () => {
    for (const verb of ["net.get", "web.expose", "local.set", "gradio.run", "hf.download", "cloudflare.tunnel", "exec.run", "proc.kill", "script.start", "fs.download"]) {
      const r = { ...base, steps: [{ verb, params: {} }] };
      expect(() => compileRecipe(r), verb).toThrow(RecipeError);
      expect(() => compileRecipe(r), verb).toThrow(/verbe refusé|verbe inconnu/);
    }
  });

  it("refuse sudo, env, venv, daemon, next et toute clé inconnue", () => {
    for (const extra of [{ sudo: true }, { env: { A: "1" } }, { venv: "env" }, { daemon: true }, { next: "x" }, { whatever: 1 }]) {
      expect(() => compileRecipe({ ...base, steps: [{ verb: "shell.run", params: { command: "echo a" }, ...extra }] })).toThrow(RecipeError);
      expect(() => compileRecipe({ ...base, steps: [{ verb: "shell.run", params: { command: "echo a", ...extra } }] })).toThrow(RecipeError);
    }
    expect(() => compileRecipe({ ...base, extra: 1 })).toThrow(RecipeError);
  });

  it("refuse une variable non déclarée, un chemin qui sort de la zone, un identifiant en double, trop d'étapes", () => {
    expect(() => compileRecipe({ ...base, vars: [] })).toThrow(/non déclarée/);
    for (const path of ["../x", "/etc/passwd", "C:\\Windows\\x", "\\\\srv\\share\\x", "~/x", "a/../../x"]) {
      expect(() => compileRecipe({ ...base, steps: [{ verb: "fs.read", params: { path } }] }), path).toThrow(/chemin/);
    }
    expect(() => compileRecipe({ ...base, steps: [base.steps[0], base.steps[0]] })).toThrow(/doublon/);
    expect(() => compileRecipe({ ...base, steps: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, verb: "log", params: { message: "x" } })) })).toThrow(/trop d'étapes/);
  });

  it("un modèle ne peut pas faire passer une expression de gabarit", () => {
    expect(() => compileRecipe({ ...base, steps: [{ verb: "shell.run", params: { command: "echo {{ name.toUpperCase() }}" } }] })).toThrow(RecipeError);
  });
});

describe("exécution : chaque étape passe par la porte, et échoue fermé", () => {
  it("exécute dans l'ordre et journalise des empreintes, jamais le contenu", async () => {
    const plan = compileRecipe(base);
    const { calls, execute } = recorder();
    const ledger: unknown[] = [];
    const res = await runPlan(plan, { execute, vars: { name: "alpha" }, record: (e) => ledger.push(e) });
    expect(res).toMatchObject({ ok: true, completed: 3 });
    expect(calls.map((c) => [c.name, (c.args as { command?: string }).command ?? (c.args as { path?: string }).path])).toEqual([
      ["write_file", "out/alpha.txt"],
      ["run_shell", "echo alpha"],
      ["run_shell", "echo done"],
    ]);
    expect(JSON.stringify(ledger)).not.toContain("hello alpha");
    expect(JSON.stringify(ledger)).toMatch(/"argsDigest":"[0-9a-f]{64}"/);
  });

  it("s'arrête à la première erreur, les étapes suivantes ne sont jamais envoyées, puis le retour arrière s'exécute", async () => {
    const plan = compileRecipe({ ...base, rollback: [{ id: "undo", verb: "shell.run", params: { command: "echo rollback" } }] });
    const { calls, execute } = recorder((c) => (c.id === "s.0" ? { content: "boom", isError: true } : ok()));
    const res = await runPlan(plan, { execute, vars: { name: "a" } });
    expect(res).toMatchObject({ ok: false, failedStep: "s.0", completed: 1, rolledBack: true });
    expect(calls.map((c) => c.id)).toEqual(["w", "s.0", "undo.0"]);
  });

  it("une valeur injectée dans une commande avec des métacaractères shell est refusée avant l'appel", async () => {
    const plan = compileRecipe(base);
    for (const evil of ["a & del *", "a | b", "a; b", "$(whoami)", "`id`", "a\nb", 'a" b', "a > f"]) {
      const { calls, execute } = recorder();
      const res = await runPlan(plan, { execute, vars: { name: evil } });
      expect(res.ok, evil).toBe(false);
      expect(calls.filter((c) => c.name === "run_shell"), evil).toHaveLength(0);
    }
  });

  it("une variable manquante ou un chemin devenu invalide à l'exécution est refusé", async () => {
    const plan = compileRecipe(base);
    expect((await runPlan(plan, { execute: recorder().execute, vars: {} })).ok).toBe(false);
    const { calls, execute } = recorder();
    expect((await runPlan(plan, { execute, vars: { name: "../../x" } })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("la sortie d'un outil n'est jamais réinterprétée comme gabarit ni comme commande", async () => {
    const plan = compileRecipe({
      ...base,
      vars: [],
      steps: [
        { id: "r", verb: "fs.read", params: { path: "a.txt" }, save: "data" },
        { id: "x", verb: "shell.run", params: { command: "echo {{data}}" } },
      ],
    });
    const { calls, execute } = recorder((c) => (c.name === "read_file" ? ok("{{secret:KEY}} & del *") : ok()));
    const res = await runPlan(plan, { execute });
    expect(res.ok).toBe(false); // valeur non sûre pour un shell
    expect(calls.map((c) => c.name)).toEqual(["read_file"]);
  });

  it("when : une étape est sautée si la condition structurée est fausse", async () => {
    const plan = compileRecipe({
      ...base,
      vars: ["mode"],
      steps: [
        { id: "a", verb: "log", params: { message: "x" }, when: { var: "mode", equals: "full" } },
        { id: "b", verb: "shell.run", params: { command: "echo b" }, when: { var: "mode", notEquals: "full" } },
      ],
    });
    const { calls, execute } = recorder();
    const res = await runPlan(plan, { execute, vars: { mode: "full" } });
    expect(res).toMatchObject({ ok: true, skipped: 1 });
    expect(calls).toHaveLength(0);
  });
});

describe("importeur de scripts Pinokio JSON simples", () => {
  it("traduit le sous-ensemble sûr et rapporte chaque étape refusée avec sa raison", () => {
    const script = {
      run: [
        { method: "shell.run", params: { message: ["git --version", "echo hi"], path: "app" } },
        { method: "shell.run", params: { message: "pip install x", venv: "env" } },
        { method: "shell.run", params: { message: "choco install y", sudo: true } },
        { method: "fs.write", params: { path: "a.txt", text: "hello {{args.who}}" } },
        { method: "fs.download", params: { uri: "https://x/y.bin", dir: "m" } },
        { method: "input", params: { title: "ok?" } },
        { method: "shell.run", params: { message: "echo {{ args.n + 1 }}" } },
      ],
    };
    const r = importPinokioScript(script, { id: "imp.demo", name: "Imported" });
    expect(r.recipe.steps.map((s) => s.verb)).toEqual(["shell.run", "fs.write"]);
    expect(r.refused.map((x) => [x.index, x.reason.split(":")[0]])).toEqual([
      [1, "venv"],
      [2, "sudo"],
      [4, "fs.download"],
      [5, "input"],
      [6, "expression"],
    ]);
    expect(r.recipe.vars).toEqual(["who"]);
    expect(() => compileRecipe(r.recipe)).not.toThrow();
  });

  it("refuse un script qui n'est pas un objet avec une liste d'étapes", () => {
    expect(() => importPinokioScript({ nope: 1 }, { id: "a.b", name: "x" })).toThrow(RecipeError);
    expect(() => importPinokioScript("run", { id: "a.b", name: "x" })).toThrow(RecipeError);
  });
});
