/**
 * Écran « Capacités » (cockpit, lot 1) : le registre vivant de plugin-integrations, en lecture seule. Le renderer ne désigne qu'un
 * identifiant de capacité à resonder ; il ne déclare rien, ne lance rien et ne voit aucune valeur de secret (les sondes n'en lisent pas).
 */
import type { CapabilityRow, HandlerContext } from "./context.js";

const ID = /^[a-z0-9][a-z0-9_.-]{0,120}$/i;

export function createCapabilityHandlers(ctx: HandlerContext) {
  const port = () => ctx.kernel().capabilities;
  return {
    "capabilities-list": async (): Promise<CapabilityRow[]> => (await port()?.list()) ?? [],
    "capabilities-check": async (id: unknown): Promise<CapabilityRow | null> => {
      if (typeof id !== "string" || !ID.test(id)) return null;
      const p = port();
      return p ? p.check(id) : null;
    },
  };
}
