/**
 * Le guichet main de l'ui-bridge : portage de `Jarod-one/packages/desktop/src/main/ipc.ts:1-53`
 * (rév. 2e180305 — expéditeur de confiance, puis allowlist, puis handler ; refus = exception), passé
 * d'un canal unique `jarod:api` + nom de méthode à un handler PAR CANAL de `@jarod/contracts/ipc`.
 *
 * Un canal autorisé sans handler répond « canal non porté » (exception) : la surface hermesAPI est
 * complète côté renderer, les services derrière arrivent au fil du portage — jamais de succès apparent.
 */
import { assertOneaiChannel, ONEAI_INVOKE_CHANNELS } from "@jarod/contracts/ipc";

export type OneaiHandler = (...args: unknown[]) => unknown;

/** Le sous-ensemble d'`ipcMain` utilisé. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Refuse tout ce qui n'est pas notre fenêtre. Le message ne dit rien de plus : il n'a pas à le faire. */
export function assertTrustedSender(trusted: boolean): void {
  if (!trusted) throw new Error("Unauthorized sender");
}

/** Le chemin complet d'un appel : l'expéditeur, puis l'allowlist, puis le handler (cherché APRÈS le contrôle). */
export function dispatchOneaiCall(
  handlers: Readonly<Record<string, OneaiHandler>>,
  channel: unknown,
  args: unknown[],
  trusted: boolean,
): unknown {
  assertTrustedSender(trusted);
  const ch = assertOneaiChannel("invoke", channel);
  const fn = Object.hasOwn(handlers, ch) ? handlers[ch] : undefined;
  if (typeof fn !== "function") throw new Error(`[oneai] canal non porté : ${ch}`);
  return fn(...args);
}

/**
 * Branche TOUS les canaux invoke autorisés sur `ipcMain` (un handler absent répond « non porté ») ;
 * un handler pour un canal hors allowlist fait échouer l'enregistrement. Rend la désinscription.
 */
export function registerOneaiHandlers(
  ipcMain: IpcMainLike,
  handlers: Readonly<Record<string, OneaiHandler>>,
  isTrusted: (event: unknown) => boolean,
): () => void {
  for (const ch of Object.keys(handlers)) assertOneaiChannel("invoke", ch);
  for (const ch of ONEAI_INVOKE_CHANNELS) {
    ipcMain.handle(ch, (event, ...args) => dispatchOneaiCall(handlers, ch, args, isTrusted(event)));
  }
  return () => {
    for (const ch of ONEAI_INVOKE_CHANNELS) ipcMain.removeHandler(ch);
  };
}

/** Pousse un événement vers le renderer — seulement sur un canal d'événement autorisé. */
export function emitOneai(target: { send(channel: string, ...args: unknown[]): void }, channel: string, ...args: unknown[]): void {
  target.send(assertOneaiChannel("event", channel), ...args);
}
