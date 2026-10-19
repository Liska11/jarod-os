// Mêmes cas que apps/desktop/shared/legacy-env.test.ts : les deux copies doivent se comporter à l'identique.
import { describe, expect, it } from "vitest";
import { adoptLegacyEnv, NEVER_ADOPTED } from "../src/legacy-env.js";

describe("adoptLegacyEnv (noyau) : HERALD_OS_* reste lu, JAROD_OS_* l'emporte", () => {
  it("l'ancien nom seul : le nouveau prend sa valeur, l'ancien reste en place", () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_BACKEND: "hermes", PATH: "x" };
    expect(adoptLegacyEnv(env)).toEqual(["JAROD_OS_BACKEND"]);
    expect(env.JAROD_OS_BACKEND).toBe("hermes");
    expect(env.HERALD_OS_BACKEND).toBe("hermes");
  });

  it("les deux noms : le nouveau l'emporte, rien n'est écrasé", () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_BACKEND: "hermes", JAROD_OS_BACKEND: "jarod" };
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(env.JAROD_OS_BACKEND).toBe("jarod");
  });

  it("un nouveau nom vide compte comme posé", () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_SCALE: "2", JAROD_OS_SCALE: "" };
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(env.JAROD_OS_SCALE).toBe("");
  });

  it("HERALD_OS_DEV_UNSIGNED (contrat c8) n'a jamais de second nom", () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_DEV_UNSIGNED: "1" };
    expect(NEVER_ADOPTED.has("HERALD_OS_DEV_UNSIGNED")).toBe(true);
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(env.JAROD_OS_DEV_UNSIGNED).toBeUndefined();
  });

  it("ne rend que des noms, jamais une valeur", () => {
    const tokenValue = "ctl-0123456789abcdef";
    const out = adoptLegacyEnv({ HERALD_OS_CONTROL_TOKEN: tokenValue, HERALD_OS_SCALE: "2" });
    expect(out).toEqual(["JAROD_OS_CONTROL_TOKEN", "JAROD_OS_SCALE"]);
    expect(JSON.stringify(out)).not.toContain(tokenValue);
  });

  it("les noms voisins ne sont pas touchés", () => {
    const env: NodeJS.ProcessEnv = { HERALD_SANDBOX_BIN: "a", HERMES_OS_BACKEND: "b", JAROD_GATEWAY_TOKEN: "c" };
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(Object.keys(env).sort()).toEqual(["HERALD_SANDBOX_BIN", "HERMES_OS_BACKEND", "JAROD_GATEWAY_TOKEN"]);
  });
});
