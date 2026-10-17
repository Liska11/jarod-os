/**
 * Réseau de jarod-sandbox : COUPÉ par défaut (aucune capacité), ouvert seulement par `--network`. Preuve avec le vrai binaire.
 *
 * Le témoin ne peut pas être un serveur de cette machine : MESURÉ le 2026-10-17, un AppContainer n'atteint pas le bouclage (ETIMEDOUT), même avec la capacité réseau —
 * un « refus » vers 127.0.0.1 ne prouverait donc rien. Le témoin est une poignée de main TCP vers une adresse publique (1.1.1.1:443, sans aucune donnée envoyée) :
 * hors du conteneur elle aboutit, sans réseau le NOYAU la refuse (EACCES, pas un délai), avec `--network` elle aboutit.
 *
 * Contact réseau externe, donc SUR DEMANDE : JAROD_NET_PROBE=1 (et un binaire construit). Sans cela, l'essai est ignoré.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const binaire = join(__dirname, "..", "..", "..", "..", "..", "host-rust", "target", "debug", "jarod-sandbox.exe");
const actif = process.platform === "win32" && existsSync(binaire) && process.env.JAROD_NET_PROBE === "1";

const JS = "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:6000});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('timeout',()=>{console.log('TIMEOUT');process.exit(4)});s.on('error',e=>{console.log('ERR '+e.code);process.exit(3)})";

describe.skipIf(!actif)("jarod-sandbox : le réseau est coupé par défaut", () => {
  it("MESURE : hors conteneur la connexion aboutit ; dans le conteneur elle est refusée par le noyau (EACCES) ; avec --network elle aboutit", () => {
    const ws = tempDir();
    const outils = tempDir();
    copyFileSync(process.execPath, join(outils, "node.exe"));
    const run = (extra: string[]) => spawnSync(binaire, ["exec", "--workspace", ws, "--timeout", "30", "--read-root", outils, ...extra, "--", `node -e "${JS}"`], { encoding: "utf8", timeout: 60_000 });

    const temoin = spawnSync(process.execPath, ["-e", JS], { encoding: "utf8", timeout: 30_000 });
    expect(temoin.stdout, "le témoin lui-même doit aboutir, sinon l'essai ne prouve rien").toContain("CONNECTED");

    const sans = run([]);
    expect(sans.stdout).toContain("ERR EACCES");
    expect(sans.stdout).not.toContain("CONNECTED");

    const avec = run(["--network"]);
    expect(avec.stdout).toContain("CONNECTED");
  });
});
