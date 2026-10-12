// Chantier 5b de SPECS-P5-MODELS.md, barre (5b-I) : `JAROD_TEST_HF_BASE` et sa triple garde (JAROD_TEST_MODE=1 ET application non empaquetée ET origine de boucle locale),
// calquée sur `JAROD_TEST_TELEGRAM_API`. Barres figées dans DECISIONS AVANT ce code. Hors mode test la variable est IGNORÉE : ni réglage, ni IPC, ni environnement ne peut
// rediriger l'application vers un autre hôte en production.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTestHfBase } from "../src/main/hf-base.js";

const base = (env: Record<string, string | undefined>, packaged = false) => resolveTestHfBase({ env, packaged });
const TEST = { JAROD_TEST_MODE: "1" };

describe("(5b-I) table de vérité de resolveTestHfBase", () => {
  it("UN seul cas accepté : mode test, non empaquetée, http sur 127.0.0.1 ou [::1] avec un port", () => {
    expect(base({ ...TEST, JAROD_TEST_HF_BASE: "http://127.0.0.1:43211" })).toEqual({ baseUrl: "http://127.0.0.1:43211", ignoredReason: null });
    expect(base({ ...TEST, JAROD_TEST_HF_BASE: "http://[::1]:43211" })).toEqual({ baseUrl: "http://[::1]:43211", ignoredReason: null });
    expect(base({ ...TEST, JAROD_TEST_HF_BASE: "http://127.0.0.1:43211/" }).baseUrl).toBe("http://127.0.0.1:43211"); // l'origine seulement : le chemin n'est jamais gardé
  });

  it("variable absente ou vide : rien, sans bruit", () => {
    expect(base({ ...TEST })).toEqual({ baseUrl: null, ignoredReason: null });
    expect(base({ ...TEST, JAROD_TEST_HF_BASE: "" })).toEqual({ baseUrl: null, ignoredReason: null });
  });

  it.each([
    ["mode test absent", {}, false],
    ["mode test à 0", { JAROD_TEST_MODE: "0" }, false],
    ["mode test à true (seul « 1 » compte)", { JAROD_TEST_MODE: "true" }, false],
  ])("%s : variable IGNORÉE avec sa raison", (_name, mode, packaged) => {
    const r = base({ ...mode, JAROD_TEST_HF_BASE: "http://127.0.0.1:43211" }, packaged);
    expect(r.baseUrl).toBeNull();
    expect(r.ignoredReason).toMatch(/mode test/i);
  });

  it("application empaquetée : IGNORÉE même en mode test, même sur une adresse locale", () => {
    const r = base({ ...TEST, JAROD_TEST_HF_BASE: "http://127.0.0.1:43211" }, true);
    expect(r.baseUrl).toBeNull();
    expect(r.ignoredReason).toMatch(/empaquet/i);
  });

  it.each([
    "http://localhost:43211",
    "http://127.0.0.2:43211",
    "http://0.0.0.0:43211",
    "http://[::2]:43211",
    "http://192.168.1.10:43211",
    "https://huggingface.co",
    "https://127.0.0.1:43211",
    "http://127.0.0.1",
    "http://user:pass@127.0.0.1:43211",
    "http://127.0.0.1:43211@evil.example",
    "http://127.0.0.1.evil.example:43211",
    "file:///C:/Windows",
    "ftp://127.0.0.1:21",
    "127.0.0.1:43211",
    "pas une adresse",
  ])("adresse refusée en mode test : %s", (url) => {
    const r = base({ ...TEST, JAROD_TEST_HF_BASE: url });
    expect(r.baseUrl).toBeNull();
    expect(r.ignoredReason).toBeTruthy();
  });
});
