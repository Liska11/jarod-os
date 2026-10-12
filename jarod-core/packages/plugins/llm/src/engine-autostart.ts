// Le démarrage automatique du moteur local, avec ses trois gardes, partagé par `jarod serve` (CLI) et le processus main du bureau :
//  a) un échec de démarrage n'est jamais fatal : il est journalisé et l'appelant continue sans moteur ;
//  b) un test (`JAROD_TEST_MODE=1`) ou un profil temporaire ne lance jamais de `llama-server` d'après un réglage copié ;
//  c) la ligne d'annonce dit l'état RÉEL du moteur après coup, jamais le réglage.
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { LocalEngineConfig } from "@jarod/contracts";
import type { LlamaServerState } from "./llama-server.js";

/** Ce que le démarrage automatique demande au moteur local (`EngineService` le satisfait). */
export interface AutoStartEngine {
  config(): LocalEngineConfig;
  start(): Promise<LlamaServerState>;
  running(): boolean;
}

function isUnder(dir: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolvePath(p).toLowerCase() : resolvePath(p));
  const rel = relative(norm(parent), norm(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Pourquoi le démarrage automatique du moteur est interdit ici, ou `null`. Un test (`JAROD_TEST_MODE=1`) ou un profil temporaire (les gates et
 * les tests créent leur `JAROD_HOME` dans le dossier temporaire) ne doit jamais lancer un `llama-server` d'après un réglage copié.
 * LIMITE ASSUMÉE (DECISIONS 2026-10-03) : un profil RÉEL placé sous le dossier temporaire du système ne démarre pas non plus le moteur — un choix, pas un accident.
 */
export function engineAutoStartBlock(root: string, env: NodeJS.ProcessEnv, tmpRoot: string = tmpdir()): string | null {
  if (env.JAROD_TEST_MODE === "1") return "mode test";
  if (isUnder(root, tmpRoot)) return "profil temporaire";
  return null;
}

/**
 * Le démarrage automatique du moteur local, puis SA LIGNE D'ANNONCE — l'état du moteur après coup, jamais le réglage. Un échec n'est pas fatal :
 * il est journalisé et l'appelant continue sans moteur.
 */
export async function startLocalEngine(
  engine: AutoStartEngine | undefined,
  block: string | null,
  log: (line: string) => void,
  /** Qui continue sans moteur après un échec (« serve » pour le démon, « l'application » par défaut). */
  who = "l'application",
): Promise<string> {
  if (!engine) return "Moteur local : non démarré (indisponible dans ce profil)";
  const cfg = engine.config();
  if (!cfg.autoStart) return engine.running() ? "Moteur local : actif" : "Moteur local : non démarré (démarrage automatique non demandé)";
  const ignored = (why: string) => `Moteur local : non démarré — le démarrage automatique est activé mais ignoré (${why})`;
  if (block) return ignored(block);
  if (!cfg.installed) return ignored("moteur llama.cpp non installé");
  if (!cfg.activePreset) return ignored("aucun préréglage actif");
  let failure: string | null = null;
  try {
    await engine.start();
  } catch (e) {
    failure = (e as Error).message.slice(0, 300);
    log(`Moteur local : échec du démarrage — ${failure}`);
  }
  if (engine.running()) {
    const preset = cfg.presets.find((p) => p.id === cfg.activePreset);
    return `Moteur local : actif (port ${cfg.port}${preset ? `, préréglage « ${preset.name} »` : ""})`;
  }
  return `Moteur local : non démarré (échec du démarrage : ${failure ?? "arrêté aussitôt"}) — ${who} continue sans moteur local`;
}
