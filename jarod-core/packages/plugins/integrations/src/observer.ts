/**
 * Observateur d'injections indirectes dans les sorties d'outils (vague A4), en mode OBSERVATION d'abord.
 *
 * En `observe`, rien n'est jamais bloqué ni modifié : le résultat de l'outil passe tel quel, et seules des
 * catégories et des compteurs sont journalisés (jamais le texte, qui peut contenir ce qu'on cherche à ne pas
 * répandre).
 *
 * V-04 (2026-10-23) : la détection vit dans `@jarod/kernel/injection` (partagée avec la porte d'outils de l'agent) ; ce module garde
 * l'observateur et la mesure, et réexporte la détection.
 *
 * `measure` calcule le taux de faux positifs et de détection sur un corpus étiqueté. Le mode `enforce` est
 * refusé tant qu'une mesure sous le seuil n'est pas fournie : bloquer sans avoir mesuré, c'est casser l'usage
 * légitime.
 */
import { type DetectOptions, detect, type Finding, type InjectionCategory } from "@jarod/kernel/injection";
import { MAX_FALSE_POSITIVE_RATE } from "./adapters.js";

export { DETECTION_THRESHOLD, type DetectOptions, detect, type Finding, type InjectionCategory, normalize } from "@jarod/kernel/injection";

export interface ObserverEvent {
  at: number;
  tool: string;
  categories: InjectionCategory[];
  length: number;
}

export interface ObserverOptions {
  mode: "observe" | "enforce";
  onEvent?: (e: ObserverEvent) => void;
  /** Exigé pour `enforce`. */
  measured?: { falsePositiveRate: number };
  /** Voir `DetectOptions.assistantNames`. */
  assistantNames?: readonly string[];
}

export class InjectionObserver {
  constructor(private readonly o: ObserverOptions) {
    if (o.mode === "enforce") {
      if (!o.measured) throw new Error("enforce refusé : aucun taux de faux positifs mesuré");
      if (o.measured.falsePositiveRate > MAX_FALSE_POSITIVE_RATE) {
        throw new Error(`enforce refusé : faux positifs ${o.measured.falsePositiveRate} > ${MAX_FALSE_POSITIVE_RATE}`);
      }
    }
  }

  /** Rend le texte à donner au modèle. En observation, TOUJOURS le texte d'origine, inchangé. */
  inspect(tool: string, output: string): { text: string; findings: Finding[]; blocked: boolean } {
    const findings = detect(output, { assistantNames: this.o.assistantNames });
    if (findings.length) this.o.onEvent?.({ at: Date.now(), tool, categories: [...new Set(findings.map((f) => f.category))], length: output.length });
    if (this.o.mode === "enforce" && findings.length) {
      return { text: `[sortie de « ${tool} » retenue : instructions suspectes (${[...new Set(findings.map((f) => f.category))].join(", ")})]`, findings, blocked: true };
    }
    return { text: output, findings, blocked: false };
  }
}

export interface Measurement {
  benign: number;
  malicious: number;
  falsePositives: number;
  detected: number;
  falsePositiveRate: number;
  detectionRate: number;
}

export function measure(benign: string[], malicious: string[], opts: DetectOptions = {}): Measurement {
  const falsePositives = benign.filter((t) => detect(t, opts).length > 0).length;
  const detected = malicious.filter((t) => detect(t, opts).length > 0).length;
  return {
    benign: benign.length,
    malicious: malicious.length,
    falsePositives,
    detected,
    falsePositiveRate: benign.length ? falsePositives / benign.length : 0,
    detectionRate: malicious.length ? detected / malicious.length : 0,
  };
}
