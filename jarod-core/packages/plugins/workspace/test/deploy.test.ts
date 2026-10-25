/**
 * Déploiements : commande fixe par fournisseur, aperçu ou production, et lancement dans le dossier du projet.
 */
import { describe, expect, it } from "vitest";
import { deployCommand, deployDescription, runDeploy } from "../src/deploy.js";

describe("deployCommand", () => {
  it("Vercel : aperçu par défaut, production avec --prod", () => {
    expect(deployCommand("vercel", false).args).toEqual(["deploy", "--yes"]);
    expect(deployCommand("vercel", true).args).toEqual(["deploy", "--yes", "--prod"]);
  });

  it("gcloud : une version non promue en aperçu", () => {
    expect(deployCommand("gcloud", false).args).toContain("--no-promote");
    expect(deployCommand("gcloud", true).args).not.toContain("--no-promote");
  });

  it("refuse un fournisseur inconnu", () => {
    expect(() => deployCommand("aws", true)).toThrow(/fournisseur inconnu/);
  });
});

describe("runDeploy", () => {
  it("lance la commande du fournisseur dans le dossier du projet", async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    await runDeploy({ provider: "railway", cwd: process.cwd(), production: true }, async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { code: 0, stdout: Buffer.from("ok"), stderr: "" };
    });
    expect(calls).toEqual([{ command: "railway", args: ["up", "--ci"], cwd: process.cwd() }]);
  });

  it("refuse un dossier relatif", async () => {
    await expect(runDeploy({ provider: "vercel", cwd: "projet", production: false })).rejects.toThrow(/absolu/);
  });

  it("le libellé d'approbation nomme le fournisseur, le dossier et le mode", () => {
    const text = deployDescription({ provider: "vercel", cwd: "/app", production: true });
    expect(text).toContain("vercel");
    expect(text).toContain("PRODUCTION");
    expect(text).toContain("/app");
  });
});
