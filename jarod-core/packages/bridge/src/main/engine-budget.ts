/**
 * Le budget mémoire « tient-il ? » du moteur local (SPECS-P5-GGUF-FIT.md, SPECS-P5-UI-PARITE.md §3.5) : VRAM du plus gros GPU quand elle atteint 4 Go, 70 % de la
 * mémoire unifiée d'un Mac Apple Silicon, sinon la moitié de la RAM. Partagé par l'écran Local engine et par l'écran Hugging Face (`hf-fit`) : UN calcul, jamais deux.
 */
import { type Hardware, memoryBudgetGb } from "@jarod/plugin-llm";

const GIB = 1024 ** 3;

export type EngineBudgetBasis = "gpu-memory" | "unified-memory" | "half-ram";

export function engineBudget(hw: Hardware): { bytes: number; basis: EngineBudgetBasis } {
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramGb ?? 0));
  const basis: EngineBudgetBasis = hw.appleSilicon ? "unified-memory" : vram >= 4 ? "gpu-memory" : "half-ram";
  return { bytes: memoryBudgetGb(hw) * GIB, basis };
}
