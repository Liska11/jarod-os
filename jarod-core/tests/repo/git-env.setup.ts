// Chargé avant chaque fichier de `vitest.integration.config.ts`, en seconde ligne : chaque test qui lance git passe déjà `isolatedGitEnv()`.
// Ceci ne vide que l'environnement du processus de test (jamais celui du shell appelant), pour un appel git qui l'aurait oublié.
import { stripGitEnv } from "./git-env.js";

const removed = stripGitEnv();
if (removed.length) console.warn(`[tests] variables Git héritées retirées : ${removed.join(", ")}`);
