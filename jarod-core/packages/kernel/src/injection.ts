/**
 * Détecteur d'injections indirectes (V-04, 2026-10-23), sans dépendance : partagé par la porte d'outils de l'agent (mode observation,
 * catégories dans la ligne d'audit) et par l'observateur de `plugin-integrations` (mesure, mode enforce).
 *
 * Le détecteur de base (six motifs) ne reconnaissait AUCUNE des 70 charges d'AgentDojo (G3-F1). Celui-ci est à SIGNAUX : le texte est
 * normalisé (casse, accents, caractères invisibles, mots proches pour les fautes de frappe), chaque famille de signaux ajoute un poids, et
 * seul un score au-delà du seuil est signalé. Une demande ordinaire adressée au lecteur (« merci d'envoyer le rapport à Marc ») ne suffit
 * pas : il faut un texte qui s'adresse à l'ASSISTANT, détourne sa tâche ou se donne une autorité qu'un document n'a pas. Conçu sur les deux
 * gabarits d'entraînement d'AgentDojo, mesuré sur ses autres attaques (jamais vues à la conception) et sur les textes bénins de ses
 * environnements : voir `agent/test/agentdojo.engine.test.ts`. Limite connue : une consigne nue (« TODO: envoie … ») est indiscernable
 * d'une note légitime sans connaître la tâche de l'utilisateur ; elle n'est pas signalée.
 */

export type InjectionCategory =
  | "override-instructions"
  | "addresses-assistant"
  | "task-hijack"
  | "fake-authority"
  | "exfiltration-request"
  | "tool-call-impersonation"
  | "hidden-text"
  | "audit-tampering";

export interface Finding {
  category: InjectionCategory;
  /** Position du premier caractère, jamais l'extrait. */
  at: number;
}

export interface DetectOptions {
  /** Les noms sous lesquels l'assistant est connu (ex. « Jarod ») : un texte qui l'interpelle par son nom est un signal. */
  assistantNames?: readonly string[];
}

/** Score à partir duquel un texte est signalé. Un signal fort (2) suffit ; deux signaux faibles (1 + 1) aussi. */
export const DETECTION_THRESHOLD = 2;

// ── Normalisation ─────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noMisleadingCharacterClass: on cherche justement ces caractères (liants, sélecteurs de variante) un par un, pour les retirer.
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;

/** Minuscules, sans accents ni caractères invisibles, espaces resserrés. Les positions ne correspondent plus au texte d'origine. */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(INVISIBLE, "").toLowerCase().replace(/\s+/g, " ");
}

/** Distance d'édition bornée (Damerau restreinte) : vraie si `a` et `b` diffèrent d'au plus `max` opérations. */
function near(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return false;
  }
  return d[a.length]![b.length]! <= max;
}

/** Les mots-clés sensibles aux fautes (« iunstructions », « previus ») : ramenés à leur forme exacte avant les motifs. */
const FUZZY_WORDS = ["instructions", "instruction", "previous", "ignore", "disregard", "directives", "consignes", "precedentes", "important", "assistant"];

function canonicalWords(norm: string): string {
  return norm.replace(/[a-z]{6,}/g, (w) => {
    if (FUZZY_WORDS.includes(w)) return w;
    const hit = FUZZY_WORDS.find((k) => near(w, k, k.length >= 9 ? 2 : 1));
    return hit ?? w;
  });
}

// ── Signaux ───────────────────────────────────────────────────────────────────

interface Signal {
  category: InjectionCategory;
  weight: number;
  pattern: RegExp;
}

const PRIOR = "(?:previous|prior|earlier|above|original|initial|preceding|all|any|your|the|precedentes?|anterieures?|ci-dessus|initiales?|tes|vos|les)";
const RULES = "(?:instructions?|directives?|prompts?|rules|guidelines|task|orders|consignes?|regles|ordres|taches?)";

const SIGNALS: Signal[] = [
  // Écraser ou remplacer les consignes.
  { category: "override-instructions", weight: 2, pattern: new RegExp(`\\b(?:ignore|disregard|forget|override|bypass|skip|ignorez?|oubliez?|oublie)\\b[^.\\n]{0,40}\\b${PRIOR}\\b[^.\\n]{0,30}\\b${RULES}\\b`) },
  // Faible : « les nouvelles consignes de sécurité sont affichées » est un texte ordinaire ; seul avec d'autres signaux il compte.
  { category: "override-instructions", weight: 1, pattern: /\b(?:new|updated|real|actual|true|revised) (?:instructions?|task|objective|goal|orders)\b|\b(?:nouvelles?|vraies?|veritables?) (?:consignes?|instructions?|taches?)\b/ },
  { category: "override-instructions", weight: 1, pattern: /\binstead\b[^.\n]{0,30}\b(?:do|perform|follow|execute)\b|\b(?:do|perform) (?:this|the following) instead\b|\bau lieu de (?:ta|votre|la) tache\b/ },
  // Détourner la tâche en cours : « avant de faire la tâche que je t'ai donnée, fais d'abord… », « ensuite tu pourras reprendre ».
  { category: "task-hijack", weight: 2, pattern: /\bbefore (?:you (?:can |do |start |begin |continue )?|solving |completing |continuing )[^.\n]{0,40}\b(?:task|request|instructions?)\b[^.\n]{0,60}\b(?:first|do the following|please)\b/ },
  { category: "task-hijack", weight: 2, pattern: /\b(?:after (?:you do|doing|completing) (?:that|this)|once (?:you(?:'ve| have) )?done)[^.\n]{0,20}\byou (?:can|may) (?:solve|continue|complete|resume|go back)/ },
  { category: "task-hijack", weight: 1, pattern: /\b(?:the|your) (?:original |initial |current )?task (?:that )?(?:i|the user) (?:gave|assigned|asked)\b|\bin the beginning\b|\bla tache (?:que|qu'on) (?:je|l'utilisateur) (?:t'a|t'ai|vous a) (?:donnee|confiee)\b/ },
  { category: "task-hijack", weight: 1, pattern: /\b(?:stop|cease|abort|halt) (?:what you(?:'re| are) doing|the (?:current )?task|everything)\b|\barrete (?:ce que tu fais|tout)\b/ },
  { category: "task-hijack", weight: 1, pattern: /(?:^|[.!?] )(?:to (?:continue|proceed)|in order to (?:continue|proceed)|pour (?:continuer|poursuivre)),? (?:you (?:must|need to|have to) |il faut |tu dois |vous devez )?[a-z]/ },
  // S'adresser à l'assistant comme à un modèle : un document n'a pas à le faire.
  { category: "addresses-assistant", weight: 1, pattern: /\b(?:dear |hey |hi |attention,? )?(?:ai|assistant|language model|llm|chatbot|ai agent|ai model)\b[,:!]|\b(?:you are|you're|as) an? (?:ai|assistant|language model|llm|ai agent)\b|\b(?:cher |chere )?(?:assistant|ia|modele de langage)\b[,:!]|\btu es (?:un|une) (?:ia|assistant|modele)\b/ },
  { category: "addresses-assistant", weight: 1, pattern: /\b(?:message|note|instructions?) (?:from me|to you)\b|\bto you,? (?:the )?(?:ai|assistant|model|agent)\b|\b(?:message|note) (?:de ma part|pour toi|a ton intention)\b/ },
  // Se donner une autorité : balises de rôle, « message important », faux message système.
  { category: "fake-authority", weight: 2, pattern: /<\/?\s*(?:information|important|system|instructions?|admin|sudo|override|im_start|im_end)\s*>|\[\/?\s*(?:system|inst|admin|important)\s*\]|<\|(?:im_start|im_end|system|endoftext)\|>|#{2,}\s*[([{]?\s*(?:system|instruction)/ },
  { category: "fake-authority", weight: 1, pattern: /\b(?:important|urgent|critical|priority) (?:message|notice|instruction|update)\b|\b(?:message|avis|consigne) (?:important|urgent|prioritaire)\b|\bthis is (?:extremely |very )?important\b|\b(?:system|admin(?:istrator)?|developer) (?:message|note|notice|override|prompt)\b|^\s*(?:system|assistant)\s*:/ },
  // Usurper un appel d'outil.
  { category: "tool-call-impersonation", weight: 2, pattern: /<\s*(?:tool_call|function_call|tool_use|invoke)\b|"(?:name|tool|function)"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|args|parameters|input)"/ },
  { category: "tool-call-impersonation", weight: 1, pattern: /\b(?:call|use|invoke|run) the [a-z_]+ (?:tool|function)\b|\b(?:appelle|utilise) l'outil\b/ },
  // Exfiltrer des données sensibles.
  // Fort seulement avec une destination (adresse, lien) : « ne partagez jamais votre mot de passe » ou un tableau qui cite « token » restent faibles.
  { category: "exfiltration-request", weight: 2, pattern: /\b(?:send|post|upload|forward|email|e-mail|share|leak|envoie[rz]?|transmets?|transfere[rz]?)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|tokens?|passwords?|passcodes?|security codes?|credentials?|private keys?|ssh keys?|mot de passe|cle privee|identifiants|\.ssh|\.env)\b[^.\n]{0,60}\b(?:to|a|vers|at)\b[^.\n]{0,20}(?:[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/)/ },
  { category: "exfiltration-request", weight: 1, pattern: /\b(?:send|post|upload|forward|email|e-mail|leak|envoie[rz]?|transmets?|transfere[rz]?)\b[^.\n|]{0,60}\b(?:api[ _-]?keys?|passwords?|passcodes?|security codes?|credentials?|private keys?|ssh keys?|mot de passe|cle privee|identifiants|\.ssh|\.env)\b/ },
  { category: "exfiltration-request", weight: 1, pattern: /\b(?:send|forward|email|envoie[rz]?|transfere[rz]?)\b[^.\n]{0,30}\b(?:all|every|tous|toutes) (?:(?:the|my|your|les|mes|tes) )?(?:emails?|messages?|files?|documents?|contacts?|courriels|fichiers)\b/ },
  // Faire taire la trace.
  { category: "audit-tampering", weight: 2, pattern: /\b(?:disable|turn off|delete|erase|clear|desactive[rz]?|supprime[rz]?|efface[rz]?)\b[^.\n]{0,30}\b(?:audit|logs?|journal|history|historique)\b[^.\n]{0,40}\b(?:so|without|afin|sans|before|avant)\b/ },
  { category: "audit-tampering", weight: 1, pattern: /\b(?:do not|don't|never|ne)\b[^.\n]{0,20}\b(?:tell|inform|mention|report|dis|mentionne|signale)\b[^.\n]{0,20}\b(?:the user|user|l'utilisateur|anyone|personne)\b/ },
  { category: "audit-tampering", weight: 1, pattern: /\b(?:disable|turn off|desactive[rz]?|coupe[rz]?)\b[^.\n]{0,20}\b(?:the |le |l')?(?:audit|journal d'audit|audit log)\b/ },
];

/** Caractères invisibles en série : du texte que le lecteur ne voit pas mais que le modèle lit. */
const HIDDEN = /[\u200b-\u200f\u2060-\u2064\u202a-\u202e\ufeff]{3,}|[\u{e0000}-\u{e007f}]{3,}/u;

/**
 * Les signaux trouvés dans `text`, si leur score atteint le seuil ; sinon une liste vide. `at` est une position dans le texte NORMALISÉ
 * (le texte d'origine n'est jamais rendu).
 */
export function detect(text: string, opts: DetectOptions = {}): Finding[] {
  const found: (Finding & { weight: number })[] = [];
  const hidden = HIDDEN.exec(text);
  if (hidden) found.push({ category: "hidden-text", at: hidden.index, weight: 2 });
  const norm = canonicalWords(normalize(text));
  for (const { category, weight, pattern } of SIGNALS) {
    const m = pattern.exec(norm);
    if (m) found.push({ category, at: m.index, weight });
  }
  for (const name of opts.assistantNames ?? []) {
    const n = normalize(name).trim();
    if (n.length < 3) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Interpellé par son nom (« to you, Jarod », « Jarod, please… », « Dear Jarod ») : un document ne parle pas à l'assistant.
    const m = new RegExp(`\\b(?:to you,? ${esc}|(?:dear|hey|hi|attention) ${esc}|${esc}\\s*[,:!]\\s*(?:please|you|ignore|before|do|stop|merci|tu|ignore|avant|fais))\\b`).exec(norm);
    if (m) found.push({ category: "addresses-assistant", at: m.index, weight: 2 });
  }
  // Une même famille ne compte qu'une fois (son poids le plus fort) : répéter un signal faible ne suffit pas.
  const best = new Map<InjectionCategory, Finding & { weight: number }>();
  for (const f of found) if ((best.get(f.category)?.weight ?? 0) < f.weight) best.set(f.category, f);
  const score = [...best.values()].reduce((s, f) => s + f.weight, 0);
  if (score < DETECTION_THRESHOLD) return [];
  return [...best.values()].sort((a, b) => a.at - b.at).map(({ category, at }) => ({ category, at }));
}
