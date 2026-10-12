// Phase 4 (audit v4, B2 — Electron fuses) : avec le fuse `runAsNode=false`, `Jarod-One.exe` + `ELECTRON_RUN_AS_NODE=1` ne se comporte
// PLUS comme Node — il relance l'application. Un serveur de langage « du projet » (tsc 7, typescript-language-server, pyright) lancé par
// `process.execPath` sous Electron ouvrirait donc une seconde instance au lieu du serveur. Sous Electron, l'interpréteur est le `node` du PATH ;
// absent, le serveur du projet n'est pas proposé (repli sur le PATH, puis « introuvable ») ; hors Electron (CLI), c'est `process.execPath`.
import { describe, expect, it } from "vitest";
import { nodeInterpreter, nodeLaunch } from "../src/lsp.js";

const electronHost = (node: string | null) => ({ electron: "44.4.5", execPath: "C:\\Apps\\Jarod-One\\Jarod-One.exe", find: (c: string) => (c === "node" ? node : null) });
const nodeHost = { electron: undefined, execPath: "C:\\node\\node.exe", find: () => "C:\\autre\\node.exe" };

describe("interpréteur des serveurs de langage du projet", () => {
  it("sous Electron : le node du PATH, jamais l'exécutable de l'application", () => {
    expect(nodeInterpreter(electronHost("C:\\Program Files\\nodejs\\node.exe"))).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("sous Electron sans node sur le PATH : aucun interpréteur (le serveur du projet n'est pas proposé)", () => {
    expect(nodeInterpreter(electronHost(null))).toBeNull();
    expect(nodeLaunch("C:\\p\\node_modules\\typescript\\bin\\tsc", ["--lsp", "--stdio"], electronHost(null))).toBeNull();
  });

  it("hors Electron (CLI) : process.execPath, qui EST node", () => {
    expect(nodeInterpreter(nodeHost)).toBe("C:\\node\\node.exe");
  });

  it("le lancement ne pose JAMAIS ELECTRON_RUN_AS_NODE (inopérant sous le fuse, et il relancerait l'application)", () => {
    const l = nodeLaunch("C:\\p\\node_modules\\typescript\\bin\\tsc", ["--lsp", "--stdio"], electronHost("C:\\nodejs\\node.exe"));
    expect(l).not.toBeNull();
    expect(l!.command).toBe("C:\\nodejs\\node.exe");
    expect(l!.args).toEqual(["C:\\p\\node_modules\\typescript\\bin\\tsc", "--lsp", "--stdio"]);
    expect(l!.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
