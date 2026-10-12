/** Refus AVANT de démarrer vitest quand l'opt-in manque (`pnpm gate:p3-telegram`) ; avertissement sinon. */
import { telegramLiveOptIn } from "./telegram-live.js";

const optIn = telegramLiveOptIn();
if (!optIn.ok) {
  console.error(`\n${optIn.refusal}\n`);
  process.exit(2);
}
console.warn(`\n${optIn.warning}\n`);
