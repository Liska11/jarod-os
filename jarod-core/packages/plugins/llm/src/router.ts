// Portage de packages/core/src/services/router.ts (rév. 2e180305).
export interface RouteRequest {
  method: string;
  path: string;
  /** Les segments du chemin, décodés : `/documents/:id/pdf` rend `{ id: "12" }`. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface RouteReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type RouteHandler = (request: RouteRequest) => RouteReply | Promise<RouteReply>;

interface Mounted {
  owner: string;
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/**
 * Les routes qu'un plugin peut exposer.
 *
 * C'était le premier des deux verrous : un plugin « à route » — automatisation, accès distant — n'a
 * aucun moyen d'être appelé de l'extérieur, parce que rien ne relie un chemin HTTP à une fonction.
 * Le serveur d'écoute existait déjà pour les déclencheurs signés ; il ne savait servir que des
 * déclencheurs.
 *
 * Deux règles. Le propriétaire est **toujours** retenu : désactiver un plugin doit retirer ses
 * routes, sinon une surface désactivée reste joignable et l'utilisateur croit avoir fermé une porte
 * qu'il n'a pas fermée. Et une route de plugin ne peut pas réclamer le chemin réservé aux
 * déclencheurs : deux propriétaires sur un chemin, c'est le dernier chargé qui gagne, ce qui est une
 * façon de perdre sans le dire.
 */
export class Router {
  private readonly routes: Mounted[] = [];

  /** Le préfixe réservé au cœur : un plugin n'y touche pas. */
  static readonly RESERVED = ["/hook"];

  register(owner: string, method: string, path: string, handler: RouteHandler): void {
    const verb = method.toUpperCase();
    if (!path.startsWith("/")) throw new Error(`ROUTE_INVALID: ${path} doit commencer par /`);
    for (const reserved of Router.RESERVED) {
      if (path === reserved || path.startsWith(`${reserved}/`)) {
        throw new Error(`ROUTE_RESERVED: ${reserved} appartient au cœur, pas à ${owner}`);
      }
    }
    const segments = path.split("/").filter(Boolean);
    const clash = this.routes.find(
      (route) =>
        route.method === verb &&
        route.segments.length === segments.length &&
        route.segments.every((segment, index) => segment === segments[index] || segment.startsWith(":")),
    );
    if (clash) throw new Error(`ROUTE_TAKEN: ${verb} ${path} est déjà tenu par ${clash.owner}`);
    this.routes.push({ owner, method: verb, segments, handler });
  }

  /** Retire tout ce qu'un propriétaire tenait. Rend ce qui a été retiré, pour pouvoir le dire. */
  unmount(owner: string): number {
    const before = this.routes.length;
    for (let index = this.routes.length - 1; index >= 0; index -= 1) {
      if (this.routes[index]?.owner === owner) this.routes.splice(index, 1);
    }
    return before - this.routes.length;
  }

  list(): { owner: string; method: string; path: string }[] {
    return this.routes.map((route) => ({
      owner: route.owner,
      method: route.method,
      path: `/${route.segments.join("/")}`,
    }));
  }

  /** Trouve la route, ou rien. `null` laisse l'appelant décider du code — ici, un 404 honnête. */
  match(method: string, pathname: string): { route: Mounted; request: Omit<RouteRequest, "body"> } | null {
    const verb = method.toUpperCase();
    const segments = pathname.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== verb || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const pattern = route.segments[index] as string;
        const actual = segments[index] as string;
        if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(actual);
        else if (pattern !== actual) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return {
          route,
          request: { method: verb, path: pathname, params, query: {}, headers: {} },
        };
      }
    }
    return null;
  }

  async handle(request: RouteRequest): Promise<RouteReply> {
    const found = this.match(request.method, request.path);
    if (!found) return { status: 404, body: { error: "not_found" } };
    try {
      const reply = await found.route.handler({ ...request, params: found.request.params });
      return { status: reply.status ?? 200, headers: reply.headers, body: reply.body ?? {} };
    } catch (error) {
      // Une route qui casse ne doit pas emporter le serveur qui écoute les déclencheurs.
      return {
        status: 500,
        body: { error: "route_failed", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
}
