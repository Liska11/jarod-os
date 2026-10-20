import { DIAGRAM_DESIGN } from "./diagram-design.js";
import { MATTPOCOCK } from "./mattpocock.js";
import type { BundledPack } from "./types.js";

export type { BundledPack } from "./types.js";

/** Les lots de skills embarquées (cockpit, lots 3 et 5). Installées seulement à la demande, par le hub (analyse et verrou compris). */
export const BUNDLED_PACKS: Record<string, BundledPack> = { mattpocock: MATTPOCOCK, "diagram-design": DIAGRAM_DESIGN };
