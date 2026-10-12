/**
 * Opt-in de la gate P3 Telegram VIVANTE (décision utilisateur 2026-09-27) : la gate envoie un vrai
 * message Telegram au propriétaire du bot et attend une réponse HUMAINE. Elle ne tourne que si
 * `GATE_TELEGRAM_LIVE=1` ; sinon, refus explicite (échec, jamais un vert apparent ni un « skip »).
 * Délai d'attente de la réponse humaine : `JAROD_GATE_TG_WAIT_S` (secondes, défaut 600).
 */
export const TELEGRAM_LIVE_ENV = "GATE_TELEGRAM_LIVE";
export const TELEGRAM_WAIT_ENV = "JAROD_GATE_TG_WAIT_S";
export const TELEGRAM_WAIT_DEFAULT_S = 600;

export type LiveOptIn = { ok: true; waitS: number; warning: string } | { ok: false; refusal: string };

export function telegramLiveOptIn(env: Record<string, string | undefined> = process.env): LiveOptIn {
  const rawWait = env[TELEGRAM_WAIT_ENV];
  const waitS = rawWait === undefined || rawWait === "" ? TELEGRAM_WAIT_DEFAULT_S : Number(rawWait);
  if (env[TELEGRAM_LIVE_ENV] !== "1") {
    return {
      ok: false,
      refusal: [
        "GATE P3 TELEGRAM REFUSÉE : gate vivante, opt-in absent.",
        `Elle envoie un VRAI message Telegram au chat appairé du profil default (coffre du profil) et attend sa réponse humaine.`,
        `Pour la lancer : ${TELEGRAM_LIVE_ENV}=1 (PowerShell : $env:${TELEGRAM_LIVE_ENV}="1"; pnpm gate:p3-telegram).`,
        `Délai d'attente de la réponse : ${TELEGRAM_WAIT_ENV} (secondes, défaut ${TELEGRAM_WAIT_DEFAULT_S}).`,
      ].join("\n"),
    };
  }
  if (!Number.isInteger(waitS) || waitS <= 0) {
    return { ok: false, refusal: `GATE P3 TELEGRAM REFUSÉE : ${TELEGRAM_WAIT_ENV}="${rawWait}" n'est pas un nombre entier de secondes > 0.` };
  }
  return {
    ok: true,
    waitS,
    warning: [
      "⚠ GATE VIVANTE (GATE_TELEGRAM_LIVE=1) : processus réel `jarod serve` sur le vrai Bot API Telegram.",
      "⚠ Un message va être ENVOYÉ au propriétaire du bot ; répondez-lui par un texte (pas /start).",
      `⚠ Attente de la réponse humaine : ${waitS} s (${TELEGRAM_WAIT_ENV}). Gate Hermes et desktop Jarod arrêtés (getUpdates exclusif).`,
    ].join("\n"),
  };
}
