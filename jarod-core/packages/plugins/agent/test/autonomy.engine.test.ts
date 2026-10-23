// Autonomie configurable (2026-10-21) — parcours réel, boucle réelle, ressources de DÉMONSTRATION seulement (dossiers jetables) :
// `system_files` (déplacement réel, Windows) sans accord DANS le dossier accordé ; accord demandé dehors, pour un `..`, une fois les utilisations
// épuisées, après l'échéance et après révocation. Puis l'opération réservée d'osquery (requête libre) : refusée sans règle avec « je sais faire,
// mais… », exécutée avec la règle. Les règles sont écrites dans `permissionsRules` comme le fait la commande `jarod permissions` (même liste).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatRequest, PermissionRule } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { planGrant, planRevoke } from "@jarod/plugin-permissions";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

const win = process.platform === "win32";
const ROOT = resolve(__dirname, "../../../../..");
const OSQ = join(ROOT, "engines", "osquery", "osqueryi.exe");
afterEach(() => {
  delete process.env.JAROD_OSQUERYI;
});

async function boot() {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  const core = (await bootApp(plugins)).agent;
  core.settings.set("autoTitle", false);
  let next: { name: string; args: Record<string, unknown> } | null = null;
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.at(-1)?.role === "tool" || !next
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: `t${Date.now()}`, ...next }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  let asked = 0;
  /** Une conversation d'un appel : rend le résultat de l'outil et le nombre d'accords demandés (toujours refusés : on voit qu'on a demandé). */
  const call = async (name: string, args: Record<string, unknown>, session?: string, answer = false) => {
    next = { name, args };
    const s = session ?? core.sessions.create().id;
    const before = asked;
    await core.runAndWait(s, "fais-le", {
      emit: () => {},
      approve: async () => {
        asked++;
        return answer;
      },
    });
    const tool = core.messages.list(s).filter((m) => m.role === "tool").at(-1);
    return { content: String(tool?.content ?? ""), isError: tool?.isError === true, asked: asked - before };
  };
  /** Ce que fait `jarod permissions add/revoke` une fois le code retapé : la même préparation, la même liste. */
  const rules = () => [...core.settings.get("permissionsRules")] as PermissionRule[];
  const write = (r: PermissionRule[]) => core.settings.set("permissionsRules", r);
  return { core, call, rules, write };
}

describe.skipIf(!win)("autorisation (avec accord) bornée en nombre — boucle réelle, dossier de démonstration", () => {
  it("l'utilisation est retirée à l'exécution ACCORDÉE, jamais à un refus ; épuisée, la règle ne joue plus", async () => {
    const { call, rules, write } = await boot();
    const demo = tempDir();
    mkdirSync(join(demo, "rangé"));
    for (const f of ["a.txt", "b.txt"]) writeFileSync(join(demo, f), f);
    const move = (from: string) => ({ action: "move", path: join(demo, from), to: join(demo, "rangé") });
    write(planGrant(rules(), { tool: "system_files", decision: "allow", target: `${demo}\\*`, uses: 1 }, Date.now()).rules);
    // Refusé à l'accord : rien ne bouge, le compteur reste.
    expect((await call("system_files", move("a.txt"))).asked).toBe(1);
    expect(rules()[0]!.uses).toBe(1);
    // Accordé : exécuté, le compteur tombe à 0.
    const ok = await call("system_files", move("a.txt"), undefined, true);
    expect(ok).toMatchObject({ asked: 1, isError: false });
    expect(existsSync(join(demo, "rangé", "a.txt"))).toBe(true);
    expect(rules()[0]!.uses).toBe(0);
    // Épuisée : la règle ne joue plus (repli du registre : outil sensible → accord).
    expect((await call("system_files", move("b.txt"))).asked).toBe(1);
    expect(rules()[0]!.uses).toBe(0);
  }, 60_000);
});

describe.skipIf(!win)("autonomie bornée — system_files sur un dossier de démonstration (boucle réelle)", () => {
  it("sans accord dans le dossier ; demandé dehors, pour `..`, une fois épuisée, échue ou révoquée", async () => {
    const { core, call, rules, write } = await boot();
    const demo = tempDir();
    const outside = tempDir();
    mkdirSync(join(demo, "rangé"));
    for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(demo, f), f);
    writeFileSync(join(outside, "x.txt"), "x");
    const move = (from: string, to: string) => ({ action: "move", path: from, to });

    // 1. Aucune règle : outil sensible → l'accord est demandé (et refusé ici) ; rien ne bouge.
    const r1 = await call("system_files", move(join(demo, "a.txt"), join(demo, "rangé")));
    expect(r1.asked).toBe(1);
    expect(existsSync(join(demo, "a.txt"))).toBe(true);

    // 2. L'utilisateur accorde : sans accord, dossier de démo seulement, 2 utilisations, 1 heure.
    write(planGrant(rules(), { tool: "system_files", decision: "allow", autonomous: true, target: `${demo}\\*`, uses: 2, durationMs: 3_600_000 }, Date.now()).rules);
    const r2 = await call("system_files", move(join(demo, "a.txt"), join(demo, "rangé")));
    expect(r2).toMatchObject({ asked: 0, isError: false });
    expect(existsSync(join(demo, "rangé", "a.txt"))).toBe(true);
    expect(rules()[0]!.uses).toBe(1);
    expect(core.auditLog(20).find((a) => a.tool === "system_files" && a.decision === "autorisé (règle)")).toMatchObject({ ok: true });

    // 3. Une cible dehors (la destination) : l'autorisation ne couvre pas TOUTES les cibles → accord demandé.
    expect((await call("system_files", move(join(demo, "b.txt"), outside))).asked).toBe(1);
    expect(existsSync(join(demo, "b.txt"))).toBe(true);
    // 4. Un chemin qui remonte depuis le dossier accordé : accord demandé.
    expect((await call("system_files", move(join(demo, "..", outside.split("\\").at(-1)!, "x.txt"), join(demo, "rangé")))).asked).toBe(1);
    expect(existsSync(join(outside, "x.txt"))).toBe(true);
    expect(rules()[0]!.uses).toBe(1); // un appel qui n'a pas joué la règle ne consomme rien

    // 5. Dernière utilisation, puis épuisée.
    expect((await call("system_files", move(join(demo, "b.txt"), join(demo, "rangé")))).asked).toBe(0);
    expect(rules()[0]!.uses).toBe(0);
    expect((await call("system_files", move(join(demo, "c.txt"), join(demo, "rangé")))).asked).toBe(1);

    // 6. Échue : une règle dont l'échéance est passée ne joue plus (écrite à 1,2 s, relue après).
    write(planGrant(rules(), { tool: "system_files", decision: "allow", autonomous: true, target: `${demo}\\*`, durationMs: 1_200 }, Date.now()).rules);
    await new Promise((r) => setTimeout(r, 1_400));
    expect((await call("system_files", move(join(demo, "c.txt"), join(demo, "rangé")))).asked).toBe(1);

    // 7. Révoquée : accordée de nouveau, puis retirée → l'accord est redemandé.
    write(planGrant(rules(), { tool: "system_files", decision: "allow", autonomous: true, target: `${demo}\\*`, durationMs: 3_600_000 }, Date.now()).rules);
    const id = rules()[0]!.id!;
    write(planRevoke(rules(), id, Date.now()).rules);
    expect((await call("system_files", move(join(demo, "c.txt"), join(demo, "rangé")))).asked).toBe(1);
    expect(existsSync(join(demo, "c.txt"))).toBe(true);

    // 8. Un refus explicite placé avant gagne sur l'autonomie, et le message dit ce qui manque.
    write([{ tool: "system_files", decision: "deny", id: "p-stop01" }, ...planGrant([], { tool: "system_files", decision: "allow", autonomous: true, target: `${demo}\\*`, durationMs: 3_600_000 }, Date.now()).rules]);
    const r8 = await call("system_files", move(join(demo, "c.txt"), join(demo, "rangé")));
    expect(r8).toMatchObject({ asked: 0, isError: true });
    expect(r8.content).toMatch(/Je sais faire « system_files », mais une règle de permissions le refuse.*jarod permissions revoke p-stop01/s);
  }, 120_000);

  it("l'agent lit ses permissions (permissions_explain) mais n'a aucun outil pour les écrire", async () => {
    const { core, call, write } = await boot();
    write([{ tool: "media_fetch", decision: "allow", autonomous: true, operation: "subtitles", target: "*.youtube.com", id: "p-yt0001", expiresAt: Date.now() + 3_600_000 }]);
    const r = await call("permissions_explain", { tool: "media_fetch", target: "www.youtube.com", operation: "audio" });
    expect(r.content).toMatch(/accord demandé/);
    expect(r.content).toMatch(/jarod permissions add auto media_fetch --cible www\.youtube\.com --operation audio/);
    expect((await call("permissions_explain", { tool: "media_fetch", target: "www.youtube.com", operation: "subtitles" })).content).toMatch(/autorisé sans accord.*p-yt0001/s);
    const writers = core.tools.all().filter((t) => /permission/i.test(t.name));
    expect(writers.map((t) => t.name)).toEqual(["permissions_explain"]);
  }, 60_000);
});

describe.skipIf(!win || !existsSync(OSQ))("opération réservée — requête osquery libre (osquery réel)", () => {
  it("refusée sans règle (« je sais faire, mais… ») ; exécutée sans accord avec la règle ; tables réseau toujours refusées", async () => {
    process.env.JAROD_OSQUERYI = OSQ;
    const { call, rules, write } = await boot();
    const sql = { query: "sql", sql: "select name, version from os_version" };
    const r1 = await call("system_diagnostics", sql);
    expect(r1).toMatchObject({ isError: true, asked: 0 });
    expect(r1.content).toMatch(/Je sais faire « system_diagnostics » avec l'opération « sql », mais elle est réservée.*jarod permissions add allow system_diagnostics --operation sql/s);
    // Le joker « * » posé pour autre chose n'ouvre pas l'opération réservée.
    write([{ tool: "*", decision: "allow" }]);
    expect((await call("system_diagnostics", sql)).isError).toBe(true);

    write(planGrant([], { tool: "system_diagnostics", decision: "allow", operation: "sql", durationMs: 3_600_000 }, Date.now()).rules);
    const r2 = await call("system_diagnostics", sql);
    expect(r2).toMatchObject({ isError: false, asked: 0 });
    expect(r2.content).toMatch(/requête libre .* \d+ ligne/);
    expect((await call("system_diagnostics", { query: "sql", sql: "select * from curl where url = 'http://example.com'" })).content).toMatch(/réseau/);
    expect(rules()).toHaveLength(1);
    // Diagnostic paramétré : valeur validée, jamais du SQL.
    expect((await call("system_diagnostics", { query: "service-status", name: "x'; drop" })).content).toMatch(/name requis/);
  }, 120_000);
});
