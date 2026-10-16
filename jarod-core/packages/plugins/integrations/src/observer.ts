/**
 * Observateur d'injections indirectes dans les sorties d'outils (vague A4), en mode OBSERVATION d'abord.
 *
 * En `observe`, rien n'est jamais bloqué ni modifié : le résultat de l'outil passe tel quel, et seules des
 * catégories et des compteurs sont journalisés (jamais le texte, qui peut contenir ce qu'on cherche à ne pas
 * répandre). Le détecteur de base est volontairement simple (motifs d'instructions adressées au modèle) ; c'est
 * le point d'accroche où brancher le paquet externe une fois épinglé.
 *
 * `measure` calcule le taux de faux positifs et de détection sur un corpus étiqueté. Le mode `enforce` est
 * refusé tant qu'une mesure sous le seuil n'est pas fournie : bloquer sans avoir mesuré, c'est casser l'usage
 * légitime.
 */
import { MAX_FALSE_POSITIVE_RATE } from "./adapters.js";

export type InjectionCategory = "override-instructions" | "exfiltration-request" | "tool-call-impersonation" | "hidden-text" | "audit-tampering";

export interface Finding {
  category: InjectionCategory;
  /** Position du premier caractère, jamais l'extrait. */
  at: number;
}

const RULES: { category: InjectionCategory; pattern: RegExp }[] = [
  { category: "override-instructions", pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?)\b/i },
  { category: "override-instructions", pattern: /\b(ignore|oublie|ignorez?)\b[^.\n]{0,40}\b(instructions?|consignes?|règles)\b[^.\n]{0,20}\b(précédentes?|ci-dessus|antérieures?)\b/i },
  { category: "exfiltration-request", pattern: /\b(send|post|upload|envoie[rz]?|transmets?)\b[^.\n]{0,60}\b(api[ _-]?key|token|password|mot de passe|secret|clé privée|\.ssh|credentials?)\b/i },
  { category: "tool-call-impersonation", pattern: /<\s*(tool_call|function_call|tool_use)\b|"name"\s*:\s*"(run_shell|write_file|http_request)"/i },
  { category: "hidden-text", pattern: /[​-‏⁠‪-‮]{3,}/ },
  { category: "audit-tampering", pattern: /\b(disable|turn off|désactive[rz]?|supprime[rz]?)\b[^.\n]{0,30}\b(audit|logs?|journal)\b/i },
];

export function detect(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { category, pattern } of RULES) {
    const m = pattern.exec(text);
    if (m) out.push({ category, at: m.index });
  }
  return out;
}

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
    const findings = detect(output);
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

export function measure(benign: string[], malicious: string[]): Measurement {
  const falsePositives = benign.filter((t) => detect(t).length > 0).length;
  const detected = malicious.filter((t) => detect(t).length > 0).length;
  return {
    benign: benign.length,
    malicious: malicious.length,
    falsePositives,
    detected,
    falsePositiveRate: benign.length ? falsePositives / benign.length : 0,
    detectionRate: malicious.length ? detected / malicious.length : 0,
  };
}
