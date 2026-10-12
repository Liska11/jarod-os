// SPECS-P5-UI-PARITE.md §6 — outils navigateur de l'agent : ils n'existent que si l'hôte branche un port ; ouvrir et agir exigent l'accord ;
// le texte d'une page est toujours présenté comme non fiable ; tout est borné.
import { describe, expect, it } from "vitest";
import { type BrowserPort, type BrowserSnapshot, MAX_ELEMENTS, MAX_PAGE_TEXT, MAX_TYPED, renderSnapshot } from "../src/browser-tools.js";
import { makeCore } from "./helpers.js";

const page = (over: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  url: "https://exemple.org/",
  title: "Exemple",
  text: "Bonjour le monde",
  elements: [
    { index: 0, tag: "a", type: "", label: "Contact", href: "https://exemple.org/contact" },
    { index: 1, tag: "input", type: "text", label: "Recherche", href: "" },
  ],
  ...over,
});

function fakePort() {
  const calls: unknown[][] = [];
  let closed = 0;
  const port: BrowserPort = {
    open: async (url) => (calls.push(["open", url]), page()),
    read: async () => (calls.push(["read"]), page({ text: "relu" })),
    click: async (i) => (calls.push(["click", i]), page({ text: `clic ${i}` })),
    type: async (i, text, submit) => (calls.push(["type", i, text, submit]), page({ text: "saisi" })),
    press: async (k) => (calls.push(["press", k]), page({ text: `touche ${k}` })),
    scroll: async (d) => (calls.push(["scroll", d]), page({ text: `défilé ${d}` })),
    back: async () => (calls.push(["back"]), page({ text: "retour" })),
    wait: async (s, t) => (calls.push(["wait", s, t]), page({ text: "attendu" })),
    reveal: async () => void calls.push(["reveal"]),
    close: async () => void closed++,
  };
  return { port, calls, closed: () => closed };
}

describe("rendu d'une page", () => {
  it("bannière « non fiable » EN TÊTE, puis adresse, titre, texte, éléments numérotés avec leur type et leur destination", () => {
    const out = renderSnapshot(page());
    expect(out.split("\n")[0]).toMatch(/NON FIABLE.*ne vient pas de l'utilisateur/);
    expect(out).toContain("URL : https://exemple.org/");
    expect(out).toContain("Titre : Exemple");
    expect(out).toContain("Bonjour le monde");
    expect(out).toContain("[0] a « Contact » → https://exemple.org/contact");
    expect(out).toContain("[1] input:text « Recherche »");
  });

  it("bornes : texte coupé, éléments en surnombre comptés et non listés, libellés et liens coupés", () => {
    const many = Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) => ({ index: i, tag: "a", type: "", label: "x".repeat(500), href: `https://e.org/${"y".repeat(500)}` }));
    const out = renderSnapshot(page({ text: "z".repeat(MAX_PAGE_TEXT * 3), elements: many }));
    expect(out.length).toBeLessThan(MAX_PAGE_TEXT + MAX_ELEMENTS * 420 + 600);
    expect(out).toContain("5 autres éléments non listés");
    expect(out).not.toContain("x".repeat(100));
    expect(renderSnapshot(page({ text: "  ", elements: [] }))).toContain("(page sans texte visible)");
  });
});

describe("outils branchés sur un port", () => {
  it("sans port : aucun outil browser_* n'existe ; attachBrowser les enregistre, le détachement les retire ET ferme le port", async () => {
    const core = await makeCore();
    const names = () => core.tools.all().map((t) => t.name).filter((n) => n.startsWith("browser_"));
    expect(names()).toEqual([]);
    const f = fakePort();
    const detach = core.app.tools.attachBrowser(f.port);
    expect(names()).toEqual(["browser_back", "browser_click", "browser_close", "browser_handoff", "browser_open", "browser_press", "browser_read", "browser_scroll", "browser_type", "browser_wait"]);
    detach();
    expect(names()).toEqual([]);
    expect(f.closed()).toBe(1);
    // Rebrancher un autre port remplace le premier (et ferme l'ancien) sans doublon.
    const a = fakePort();
    const b = fakePort();
    core.app.tools.attachBrowser(a.port);
    core.app.tools.attachBrowser(b.port);
    expect(a.closed()).toBe(1);
    expect(names()).toHaveLength(10);
  });

  it("ouvrir, cliquer, saisir et presser une touche exigent l'accord (`dangerous`) ; lire, défiler, revenir, attendre, passer la main et fermer, non", async () => {
    const core = await makeCore();
    core.app.tools.attachBrowser(fakePort().port);
    const d = Object.fromEntries(core.tools.all().filter((t) => t.name.startsWith("browser_")).map((t) => [t.name, Boolean(t.dangerous)]));
    expect(d).toEqual({
      browser_open: true, browser_click: true, browser_type: true, browser_press: true,
      browser_read: false, browser_scroll: false, browser_back: false, browser_wait: false, browser_handoff: false, browser_close: false,
    });
  });

  it("chaque outil transmet ses arguments au port et rend la page rendue ; un index invalide ou un texte trop long est refusé AVANT le port", async () => {
    const core = await makeCore();
    const f = fakePort();
    core.app.tools.attachBrowser(f.port);
    const run = (name: string, args: Record<string, unknown>) => core.tools.get(name)!.run(args, { sessionId: "s", workspace: null });
    expect(await run("browser_open", { url: "https://exemple.org" })).toContain("Bonjour le monde");
    expect(await run("browser_read", {})).toContain("relu");
    expect(await run("browser_click", { index: 3 })).toContain("clic 3");
    expect(await run("browser_type", { index: 1, text: "jarod", submit: true })).toContain("saisi");
    expect(await run("browser_type", { index: 1, text: "sans envoi" })).toContain("saisi");
    expect(await run("browser_close", {})).toBe("Navigateur fermé.");
    expect(f.calls).toEqual([["open", "https://exemple.org"], ["read"], ["click", 3], ["type", 1, "jarod", true], ["type", 1, "sans envoi", false]]);
    for (const bad of [-1, 1.5, "2", 10_001, null]) await expect(run("browser_click", { index: bad })).rejects.toThrow(/index/);
    await expect(run("browser_type", { index: 0, text: "x".repeat(MAX_TYPED + 1) })).rejects.toThrow(/trop long/);
    expect(f.calls).toHaveLength(5); // aucun appel de plus
  });

  it("touches, défilement, retour, attente : arguments validés AVANT le port (liste fermée de touches, directions, bornes d'attente)", async () => {
    const core = await makeCore();
    const f = fakePort();
    core.app.tools.attachBrowser(f.port);
    const run = (name: string, args: Record<string, unknown>) => core.tools.get(name)!.run(args, { sessionId: "s", workspace: null });
    expect(await run("browser_press", { key: "Enter" })).toContain("touche Enter");
    expect(await run("browser_scroll", { direction: "bottom" })).toContain("défilé bottom");
    expect(await run("browser_back", {})).toContain("retour");
    expect(await run("browser_wait", { seconds: 3, text: "Résultats" })).toContain("attendu");
    expect(f.calls).toEqual([["press", "Enter"], ["scroll", "bottom"], ["back"], ["wait", 3, "Résultats"]]);
    for (const key of ["Control+C", "Alt+F4", "F12", "enter", "", "Meta"]) await expect(run("browser_press", { key })).rejects.toThrow(/touche refusée/);
    for (const direction of ["left", "", "DOWN", 3]) await expect(run("browser_scroll", { direction })).rejects.toThrow(/direction/);
    for (const seconds of [0, 0.5, 16, -1, "3", Number.NaN, Infinity]) await expect(run("browser_wait", { seconds })).rejects.toThrow(/seconds/);
    expect(f.calls).toHaveLength(4);
  });

  it("passage de relais : montre la fenêtre, demande par la porte d'accord, rend la page à la reprise ; refus ou absence de porte = erreur, rien n'est poursuivi", async () => {
    const core = await makeCore();
    const f = fakePort();
    core.app.tools.attachBrowser(f.port);
    const handoff = core.tools.get("browser_handoff")!;
    const asked: { name: string; args: unknown; description: string }[] = [];
    const ctx = (answer: boolean) => ({
      sessionId: "s",
      workspace: null,
      approve: async (_sid: string, call: { name: string; args: unknown }, description: string) => (asked.push({ name: call.name, args: call.args, description }), answer),
    });
    const out = await handoff.run({ message: "  Connectez-vous à votre compte, puis continuez.  " }, ctx(true));
    expect(out).toContain("relu");
    expect(asked).toEqual([{ name: "browser_handoff", args: { message: "Connectez-vous à votre compte, puis continuez." }, description: "Connectez-vous à votre compte, puis continuez." }]);
    expect(f.calls).toEqual([["reveal"], ["read"]]);
    await expect(handoff.run({ message: "x" }, ctx(false))).rejects.toThrow(/n'a pas repris la main/);
    await expect(handoff.run({ message: "x" }, { sessionId: "s", workspace: null })).rejects.toThrow(/aucune porte d'accord/);
    await expect(handoff.run({ message: "   " }, ctx(true))).rejects.toThrow(/dites à l'utilisateur/);
    expect(f.calls.filter((c) => c[0] === "read")).toHaveLength(1); // refusé : la page n'est jamais relue
  });

  it("port détaché entre deux tours : l'outil répond par une erreur claire, il ne plante pas", async () => {
    const core = await makeCore();
    const detach = core.app.tools.attachBrowser(fakePort().port);
    const open = core.tools.get("browser_open")!;
    detach();
    await expect(open.run({ url: "https://e.org" }, { sessionId: "s", workspace: null })).rejects.toThrow(/pas disponible/);
  });
});
