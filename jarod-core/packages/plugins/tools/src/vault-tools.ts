// Portage de packages/core/src/tools/vault.ts (rév. 2e180305).
import { factsOf, httpProof, recordFacts } from "./proofs.js";
import { VaultService } from "@jarod/plugin-rag";
import { truncate, withTimeout } from "@jarod/kernel/util";
import type { ToolDef } from "./registry.js";

const MAX_RESPONSE = 30_000;
const MAX_BODY = 1024 * 1024;

/**
 * The vault seen from the agent: what exists (never a value), and a request that can carry a secret
 * to the sites it belongs to. Shell commands get theirs through `run_shell`'s `secrets` argument.
 */
export function vaultTools(): ToolDef[] {
  return [
    {
      name: "vault_list",
      description:
        "Liste les identifiants du coffre de l'utilisateur : noms, usage, domaines permis — jamais les valeurs. Pour t'en servir : run_shell avec secrets:[NOM] (variable d'environnement), ou http_request avec {{secret:NOM}} dans un en-tête ou le corps, vers un domaine permis.",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run(_args, ctx) {
        const entries = ctx.vault?.list() ?? [];
        if (!entries.length) {
          return "Le coffre est vide. L'utilisateur ajoute des identifiants dans Paramètres → Outils → Coffre d'identifiants.";
        }
        return entries
          .map(
            (e) =>
              `- ${e.name}${e.description ? ` : ${e.description}` : ""}\n  shell : ${e.allowShell ? `oui (variable ${e.envVar})` : "non"} · requêtes HTTP vers : ${e.domains.join(", ") || "aucun domaine"}`,
          )
          .join("\n");
      },
    },
    {
      name: "http_request",
      targetOf: (args) => (typeof args.url === "string" ? args.url : undefined),
      description:
        "Envoie une requête HTTP (GET, POST, PUT, PATCH, DELETE) et renvoie le statut et le corps de la réponse. Les en-têtes et le corps peuvent contenir {{secret:NOM}} : la valeur du coffre y est mise au dernier moment, seulement en https et vers un domaine permis pour ce secret, et elle est masquée dans la réponse.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        required: ["url"],
      },
      // It can change things on a server, and it can carry a credential: the user sees it first.
      dangerous: true,
      source: "builtin",
      // V-10 : la réponse réellement reçue (statut, hôte, taille ; une redirection non suivie et où elle menait), constatée par `run`.
      async verify(args) {
        const f = factsOf(args);
        return f?.kind === "http" ? httpProof(f) : { status: "unverifiable", evidence: "aucune réponse constatée" };
      },
      async run(args, ctx) {
        const url = new URL(String(args.url));
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error("Seuls http et https sont autorisés.");
        const method = String(args.method ?? "GET").toUpperCase();
        const headers = Object.entries((args.headers ?? {}) as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)] as const,
        );
        const body = args.body === undefined || args.body === null ? undefined : String(args.body);
        const raw = [...headers.map(([, v]) => v), body ?? ""];
        const wantsSecret = raw.some((p) => p.includes("{{secret:"));
        if (wantsSecret && !ctx.vault) throw new Error("Aucun coffre d'identifiants n'est disponible ici.");
        // The URL itself never carries a secret: it ends up in logs and proxies.
        if (url.href.includes("{{secret:") || decodeURIComponent(url.href).includes("{{secret:")) {
          throw new Error("Un secret ne se met jamais dans l'URL : utilise un en-tête ou le corps.");
        }
        const filled = wantsSecret && ctx.vault ? ctx.vault.fillRequest(url, raw) : { parts: raw, used: [] };
        const finalHeaders: Record<string, string> = { "user-agent": "Jarod-One" };
        headers.forEach(([k], i) => {
          finalHeaders[k] = filled.parts[i]!;
        });
        const finalBody = body === undefined ? undefined : filled.parts[headers.length];
        const res = await fetch(url, {
          method,
          headers: finalHeaders,
          ...(finalBody !== undefined && method !== "GET" ? { body: finalBody } : {}),
          redirect: wantsSecret ? "manual" : "follow",
          signal: withTimeout(ctx.signal, 30_000),
        });
        let text = "";
        let size = 0;
        let capped = false;
        if (res.body) {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
            if (size > MAX_BODY) {
              capped = true;
              await reader.cancel().catch(() => {});
              break;
            }
          }
          text = Buffer.concat(chunks).toString("utf8");
        }
        const location = res.headers.get("location");
        recordFacts(args, { kind: "http", status: res.status, requested: url.href, final: res.url || url.href, bytes: size, capped, type: res.headers.get("content-type") ?? "", ...(location ? { location } : {}) });
        const out = `HTTP ${res.status} ${method} ${url.href}${location ? `\nLocation : ${location}` : ""}\n\n${text}`;
        return VaultService.redact(truncate(out, MAX_RESPONSE), filled.used);
      },
    },
  ];
}
