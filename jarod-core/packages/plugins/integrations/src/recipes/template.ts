/**
 * Substitution de variables SANS évaluation (phase 6B).
 *
 * Pinokio rend `{{ … }}` en boucle contre une mémoire riche : une valeur venue d'une sortie d'outil devient une
 * expression (injection de gabarit). Ici, un gabarit est `{{nom}}` et rien d'autre : pas d'expression, pas d'appel,
 * pas de point, pas de `secret:` (les secrets passent par le coffre, jamais par une recette). Un seul passage : la
 * valeur substituée n'est jamais relue, même si elle ressemble à un gabarit.
 */

export class TemplateError extends Error {}

export type Vars = Record<string, string>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Tout `{{ … }}` ou `{{` resté ouvert : le contenu est ensuite jugé, il n'est jamais interprété. */
const TOKEN = /\{\{([^{}]*)\}\}|\{\{/g;

function nameOf(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!NAME.test(name)) throw new TemplateError(`gabarit refusé : seules les variables nommées {{nom}} existent (reçu « ${(raw ?? "").slice(0, 40)} »)`);
  return name;
}

/** Les variables référencées, dans l'ordre d'apparition, sans doublon. Lève sur tout gabarit qui n'est pas `{{nom}}`. */
export function referencedVars(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const name = nameOf(m[1]);
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function substitute(text: string, vars: Vars, check?: (value: string, name: string) => void): string {
  return text.replace(TOKEN, (_all, raw: string | undefined) => {
    const name = nameOf(raw);
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) throw new TemplateError(`variable inconnue : ${name}`);
    check?.(value, name);
    return value;
  });
}

/** Applique `substitute` à toute chaîne d'une valeur JSON (tableaux et objets compris) ; les autres types passent tels quels. */
export function substituteDeep<T>(value: T, vars: Vars, check?: (value: string, name: string) => void): T {
  if (typeof value === "string") return substitute(value, vars, check) as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars, check)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, vars, check)])) as T;
  return value;
}
