// Lot 4 (30/10) : les capacités de brahma-ai-evo réécrites pour Jarod. Logique pure et réponses réseau simulées partout ; sous Windows,
// les scripts PowerShell tournent pour de vrai (OCR, fenêtre active, presse-papiers rétabli, luminosité lue sans être changée).
// Les touches multimédia ne sont JAMAIS pressées par les tests (elles mettraient en pause la musique de l'utilisateur).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { categoryOf, organizePlan, parseWhen, speedTest, weatherFor, WEATHER_CODES } from "../src/daily.js";
import type { ToolContext } from "../src/registry.js";
import { everydayTools, MEDIA_KEYS, PROTOCOLS } from "../src/system/everyday.js";
import { realPsRunner } from "../src/system/ps.js";
import * as E from "../src/system/scripts-everyday.js";
import { tempDir } from "@jarod/kernel/testing";

const win = process.platform === "win32";
const ctx = { sessionId: "s", workspace: null } as ToolContext;

function fakeFetch(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    return new Response(body instanceof Uint8Array ? body : JSON.stringify(body ?? {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
  return { f, seen };
}

describe("météo (Open-Meteo simulé)", () => {
  it("une ville est géocodée, puis la prévision rendue en mots", async () => {
    const { f, seen } = fakeFetch({
      "geocoding-api.open-meteo.com": { results: [{ name: "Dakar", country: "Sénégal", latitude: 14.7, longitude: -17.4 }] },
      "api.open-meteo.com/v1/forecast": {
        current: { temperature_2m: 29, apparent_temperature: 31, relative_humidity_2m: 70, wind_speed_10m: 12, weather_code: 2 },
        daily: { time: ["2026-10-30"], weather_code: [61], temperature_2m_min: [24], temperature_2m_max: [31], precipitation_probability_max: [40] },
      },
    });
    const w = await weatherFor(f, "Dakar", 1);
    expect(w.place).toBe("Dakar (Sénégal)");
    expect(w.located_by).toBe("ville");
    expect(w.now.sky).toBe(WEATHER_CODES[2]);
    expect(w.days[0]).toMatchObject({ sky: "pluie faible", min: 24, max: 31 });
    expect(seen[1]).toContain("latitude=14.7");
  });

  it("sans ville : position de l'adresse IP ; ville inconnue : erreur lisible", async () => {
    const { f, seen } = fakeFetch({ "get.geojs.io": { city: "Paris", latitude: "48.85", longitude: "2.35" }, "api.open-meteo.com": { current: {}, daily: {} } });
    expect((await weatherFor(f)).located_by).toBe("adresse IP");
    expect(seen[0]).toContain("geojs.io");
    const none = fakeFetch({ "geocoding-api.open-meteo.com": { results: [] } });
    await expect(weatherFor(none.f, "Nullepart")).rejects.toThrow(/Ville introuvable/);
  });
});

describe("débit Internet (simulé)", () => {
  it("rend latence, débit descendant et montant en Mb/s", async () => {
    const { f } = fakeFetch({ "__down?bytes=0": new Uint8Array(0), "__down?bytes=25000000": new Uint8Array(1000), "__up": {} });
    const r = await speedTest(f);
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.download_mbps).toBeGreaterThan(0);
    expect(r.upload_mbps).toBeGreaterThan(0);
  });
});

describe("rangement de dossier", () => {
  it("chaque fichier vers sa catégorie, doublons exacts repérés, rien n'est déplacé", async () => {
    const d = tempDir();
    writeFileSync(join(d, "photo.JPG"), "image-a");
    writeFileSync(join(d, "copie de photo.jpg"), "image-a");
    writeFileSync(join(d, "facture.pdf"), "pdf");
    writeFileSync(join(d, "setup.exe"), "exe");
    writeFileSync(join(d, "inconnu.xyz"), "?");
    mkdirSync(join(d, "PDF"));
    writeFileSync(join(d, "PDF", "facture.pdf"), "autre");
    const plan = await organizePlan(d, []);
    expect(plan.files).toBe(5);
    expect(plan.operations.map((o) => o.to.slice(d.length + 1))).toEqual(expect.arrayContaining([join("Images", "photo.JPG"), join("Installateurs", "setup.exe"), join("Autres", "inconnu.xyz")]));
    expect(plan.skipped).toEqual(["facture.pdf : existe déjà dans PDF"]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]!.copies).toHaveLength(1);
    expect(categoryOf("a.Mp3")).toBe("Musique");
  });

  it("un emplacement protégé ou un chemin relatif est refusé", async () => {
    const d = tempDir();
    await expect(organizePlan(d, [d])).rejects.toThrow(/emplacement protégé/);
    await expect(organizePlan("relatif", [])).rejects.toThrow(/absolu/);
  });
});

describe("agenda : dates", () => {
  it("une date lisible est acceptée, une date illisible est une erreur (jamais « maintenant » en silence)", () => {
    expect(new Date(parseWhen("2026-11-02 14:30", "start")).getHours()).toBe(14);
    expect(() => parseWhen("demain vers midi", "start")).toThrow(/illisible/);
    expect(() => parseWhen("", "start")).toThrow(/requis/);
  });
});

describe("outils Windows : politique", () => {
  it("ce qui agit demande un accord ; ce qui lit est audité ; touches et modes connus", () => {
    const tools = everydayTools({ platform: "win32", ps: { json: async () => null } });
    expect(tools.map((t) => [t.name, Boolean(t.dangerous), Boolean(t.audited)])).toEqual([
      ["clipboard", true, true],
      ["media_control", true, true],
      ["active_window", false, true],
      ["screen_read", false, true],
      ["protocol", true, true],
      ["hardware_check", false, true],
    ]);
    expect(everydayTools({ platform: "linux" })).toEqual([]);
    expect(MEDIA_KEYS.play_pause).toBe(0xb3);
    expect(Object.keys(PROTOCOLS)).toEqual(["nuit", "jour", "concentration", "presentation"]);
  });

  it("protocole nuit : chaque réglage passe par le bon script, puis un seul « annuler » rétablit tout", async () => {
    const calls: { script: string; args: unknown }[] = [];
    const ps = {
      json: async (script: string, args?: Record<string, unknown>) => {
        calls.push({ script, args });
        if (script === E.BRIGHTNESS) return { supported: true, percent: 70 };
        if (script.includes("apps_light") || script.includes("AppsUseLightTheme")) return { apps_light: 1 };
        return { output: "60|0" };
      },
    };
    const { UndoStack } = await import("../src/system/undo.js");
    const undo = new UndoStack();
    const protocol = everydayTools({ platform: "win32", ps, undo }).find((t) => t.name === "protocol")!;
    expect(await protocol.precheck!({ name: "nuit" }, ctx)).toBe("Passer en mode nuit");
    const out = JSON.parse(await protocol.run({ name: "nuit" }, ctx));
    expect(out.applied).toEqual(["mode sombre", "volume 25 %", "luminosité 30 %"]);
    expect(undo.peek()?.label).toBe("mode nuit");
    const before = calls.length;
    await undo.undoLast();
    expect(calls.slice(before).map((c) => c.args)).toEqual([{ percent: 70 }, { percent: 60, muted: false }, { enabled: false }]);
  });
});

describe.runIf(win)("sur cette machine (vrai PowerShell)", () => {
  const ps = realPsRunner();

  it("fenêtre active : un titre, un programme, un temps d'inactivité", async () => {
    const r = (await ps.json(E.ACTIVE_WINDOW, undefined, { timeoutMs: 30_000 })) as { title: string; process: string; idleSeconds: number };
    expect(typeof r.title).toBe("string");
    expect(r.idleSeconds).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("presse-papiers : écrire puis relire, et le contenu d'avant est remis", async () => {
    const before = String(((await ps.json(E.CLIPBOARD_GET, undefined, { timeoutMs: 30_000 })) as { text?: string }).text ?? "");
    try {
      await ps.json(E.CLIPBOARD_SET, { text: "Jarod — test du presse-papiers é" }, { timeoutMs: 30_000 });
      const now = ((await ps.json(E.CLIPBOARD_GET, undefined, { timeoutMs: 30_000 })) as { text: string }).text;
      expect(now.trimEnd()).toBe("Jarod — test du presse-papiers é");
    } finally {
      await ps.json(E.CLIPBOARD_SET, { text: before }, { timeoutMs: 30_000 });
    }
  }, 60_000);

  it("luminosité : lue seulement (supportée ou non selon l'écran)", async () => {
    const r = (await ps.json(E.BRIGHTNESS, undefined, { timeoutMs: 30_000 })) as { supported: boolean; percent?: number };
    expect(typeof r.supported).toBe("boolean");
  }, 60_000);

  it("lecture de l'écran : la reconnaissance de texte de Windows répond (texte ou écran vide)", async () => {
    const r = (await ps.json(E.SCREEN_OCR, { target: "screen" }, { timeoutMs: 90_000 })) as { width: number; height: number; lines: unknown };
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  }, 120_000);
});
