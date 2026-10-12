/**
 * Décompte des canaux hermesAPI (D1(b)) : servis + restants = 229, chaque restant rangé dans une famille HORS
 * du portage courant, nommée canal par canal (une liste explicite : un canal perdu ou mal compté se voit).
 * Utilisé par le test de la carte des handlers et par `scripts/channels-count.ts` (ligne de STATE.md).
 */
import { HERMES_INVOKE_CHANNELS } from "@jarod/contracts/ipc";

/** Familles non servies, avec la raison (BESOINS Q8, PLAN §2). */
export const UNSERVED_FAMILIES = {
  /** Volet Portefeuilles : hors Q8 (backend `ethers`/wallets absent de Jarod). */
  Portefeuilles: [
    "list-wallets",
    "wallet-sync",
    "wallet-portfolio",
    "wallet-provision",
    "create-wallet",
    "import-wallet",
    "rename-wallet",
    "delete-wallet",
    "get-token-balances",
  ],
  /** Écran 3D « Office » (Claw3D) : hors Q8. */
  Claw3D: [
    "claw3d-status",
    "claw3d-setup",
    "claw3d-get-port",
    "claw3d-set-port",
    "claw3d-get-ws-url",
    "claw3d-set-ws-url",
    "claw3d-start-all",
    "claw3d-stop-all",
    "claw3d-get-logs",
    "claw3d-start-dev",
    "claw3d-stop-dev",
    "claw3d-start-adapter",
    "claw3d-stop-adapter",
  ],
} as const;

export type UnservedFamily = keyof typeof UNSERVED_FAMILIES;

export interface ChannelCensus {
  total: number;
  served: string[];
  families: Record<UnservedFamily, string[]>;
  /** Non servis hors de toute famille : canal perdu (doit rester vide). */
  unclassified: string[];
  /** Servis alors que leur famille est déclarée non servie : liste à mettre à jour (doit rester vide). */
  servedInFamily: string[];
  /** Noms de famille absents du contrat hermesAPI (faute de frappe, canal renommé ; doit rester vide). */
  unknown: string[];
}

export function channelCensus(handlerKeys: readonly string[]): ChannelCensus {
  const all = HERMES_INVOKE_CHANNELS as readonly string[];
  const keys = new Set(handlerKeys);
  const served = all.filter((c) => keys.has(c));
  const listed = new Map<string, UnservedFamily>();
  for (const [family, channels] of Object.entries(UNSERVED_FAMILIES) as [UnservedFamily, readonly string[]][]) {
    for (const c of channels) listed.set(c, family);
  }
  const families = Object.fromEntries(Object.keys(UNSERVED_FAMILIES).map((f) => [f, [] as string[]])) as Record<UnservedFamily, string[]>;
  const unclassified: string[] = [];
  for (const c of all) {
    if (keys.has(c)) continue;
    const family = listed.get(c);
    if (family) families[family].push(c);
    else unclassified.push(c);
  }
  return {
    total: all.length,
    served,
    families,
    unclassified,
    servedInFamily: served.filter((c) => listed.has(c)),
    unknown: [...listed.keys()].filter((c) => !all.includes(c)),
  };
}

/** Servis + restants = total, et chaque restant dans sa famille. */
export function censusOk(c: ChannelCensus): boolean {
  const sum = c.served.length + Object.values(c.families).reduce((n, l) => n + l.length, 0) + c.unclassified.length;
  return sum === c.total && c.unclassified.length === 0 && c.servedInFamily.length === 0 && c.unknown.length === 0;
}

/** Une ligne : `229 = servis 207 + Portefeuilles 9 + Claw3D 13 + non classés 0`. */
export function censusLine(c: ChannelCensus): string {
  const parts = Object.entries(c.families).map(([f, list]) => `${f} ${list.length}`);
  return `${c.total} = servis ${c.served.length} + ${parts.join(" + ")} + non classés ${c.unclassified.length}${censusOk(c) ? "" : " — ÉCART"}`;
}
