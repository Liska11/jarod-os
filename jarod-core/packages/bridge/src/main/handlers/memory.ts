/**
 * Mémoire, profil utilisateur et SOUL.md aux formes hermesAPI.
 * Sources des formes : SANK-UI `src/main/memory.ts:7-31` (`MemoryInfo`, entrées séparées par « § »),
 * `:123-142` (`readMemory`), `:168-242` (ajout / mise à jour / retrait PAR INDEX, `{ success, error }`),
 * `ipc/register.ts:2438-2499` (rév. 3aaadb0, MIT © github.com/fathah).
 *
 * Correspondance Jarod : MEMORY.md ↔ table `memories` (plugin-memory), entrées dans l'ordre d'INSERTION
 * (`seq`, clé auto-incrémentée : deux ajouts dans la même milliseconde gardent leur ordre, une mise à jour
 * ne déplace rien — l'index Hermes reste stable) ; USER.md ↔ `userProfile` (même nom de fichier) ;
 * SOUL.md ↔ `ctx.persona` (Q4 = A). Limites : Jarod ne plafonne pas la mémoire (limite affichée =
 * `Number.MAX_SAFE_INTEGER`, « aucune »), le profil l'est par `MAX_PROFILE_CHARS` (4000).
 * `reset-soul` rend la persona après effacement : "" (Jarod n'invente pas de persona par défaut).
 * `discover-memory-providers` : `[]` (aucun fournisseur externe, réponse SANK-UI sans dossier de plugins).
 */
import { assertProfile, type HandlerContext } from "./context.js";

/** V-18 : un identifiant de souvenir (newId, ou un identifiant importé) : court, sans séparateur de chemin ni caractère de contrôle. */
const MEMORY_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const ENTRY_DELIMITER = "\n§\n";
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const USER_LIMIT = 4000; // MAX_PROFILE_CHARS (plugin-memory/user-profile.ts:8)

export function createMemoryHandlers(ctx: HandlerContext) {
  const agent = () => ctx.kernel().agent;
  const entries = () =>
    agent().db.all<{ id: string; content: string; updated_at: number }>("SELECT id, content, updated_at FROM memories ORDER BY seq");
  const persona = () => {
    const p = ctx.kernel().persona;
    if (!p) throw new Error("[oneai] SOUL.md : plugin-persona désactivé");
    return p;
  };
  const guard =
    <A extends unknown[], R>(n: number, fn: (...a: A) => R) =>
    (...a: A): R => {
      assertProfile(ctx, a[n]);
      return fn(...a);
    };

  return {
    "read-memory": guard(0, (_profile?: unknown) => {
      const list = entries();
      const content = list.map((m) => m.content).join(ENTRY_DELIMITER);
      const lastMs = list.reduce<number | null>((max, m) => (max === null || m.updated_at > max ? m.updated_at : max), null);
      const user = agent().userProfile;
      const userContent = user.read();
      const db = agent().db;
      return {
        memory: {
          content,
          exists: list.length > 0,
          lastModified: lastMs === null ? null : Math.floor(lastMs / 1000),
          entries: list.map((m, index) => ({ index, content: m.content })),
          charCount: content.length,
          charLimit: NO_LIMIT,
        },
        user: {
          content: userContent,
          exists: user.exists(),
          lastModified: null,
          charCount: userContent.length,
          charLimit: USER_LIMIT,
        },
        stats: {
          totalSessions: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")?.n ?? 0,
          totalMessages: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages")?.n ?? 0,
        },
      };
    }),
    "add-memory-entry": guard(1, (content: unknown, _profile?: unknown) => {
      if (typeof content !== "string" || !content.trim()) return { success: false, error: "Empty entry" };
      agent().memory.add(content);
      return { success: true };
    }),
    "update-memory-entry": guard(2, (index: unknown, content: unknown, _profile?: unknown) => {
      const list = entries();
      if (typeof index !== "number" || index < 0 || index >= list.length) return { success: false, error: "Entry not found" };
      if (typeof content !== "string" || !content.trim()) return { success: false, error: "Empty entry" };
      agent().memory.update(list[index]!.id, content.trim());
      return { success: true };
    }),
    "remove-memory-entry": guard(1, (index: unknown, _profile?: unknown) => {
      const list = entries();
      if (typeof index !== "number" || index < 0 || index >= list.length) return false;
      agent().memory.delete(list[index]!.id);
      return true;
    }),
    "write-user-profile": guard(1, (content: unknown, _profile?: unknown) => {
      try {
        agent().userProfile.write(typeof content === "string" ? content : "");
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
    "read-soul": guard(0, (_profile?: unknown) => persona().read()),
    "write-soul": guard(1, (content: unknown, _profile?: unknown) => {
      persona().write(typeof content === "string" ? content : "");
      return true;
    }),
    "reset-soul": guard(0, (_profile?: unknown) => {
      persona().reset();
      return persona().read();
    }),
    /**
     * D1(b) — `installer.ts:1327-1400` (`discoverMemoryProviders`) : fournisseurs de mémoire EXTERNES (Honcho,
     * mem0…) livrés comme plugins Python du dépôt Hermes ; sans ce dossier, SANK-UI rend `[]`. Jarod n'a pas de
     * fournisseur externe (mémoire intégrée, plugin-memory) : même réponse, `[]`.
     */
    "discover-memory-providers": guard(0, (_profile?: unknown): never[] => []),
    /** V-18 : les changements de la mémoire, du plus récent au plus ancien (un souvenir, ou tous). Lecture seule. */
    "memory-history": (memoryId?: unknown, limit?: unknown) => {
      if (memoryId !== undefined && memoryId !== null && (typeof memoryId !== "string" || !MEMORY_ID.test(memoryId))) throw new Error("[oneai] souvenir invalide");
      return agent().memory.history({
        ...(typeof memoryId === "string" ? { memoryId } : {}),
        ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
      });
    },
    /** V-18 : défait un changement (rétablit un souvenir retiré, un texte d'avant, retire un ajout) ; le geste laisse sa propre ligne. */
    "memory-restore": (seq: unknown) => {
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new Error("[oneai] changement invalide");
      return agent().memory.restore(seq);
    },
    /**
     * V-18 : efface l'historique (d'un souvenir, ou tout). Irréversible, et c'est le moyen pour qu'un souvenir retiré exprès ne survive
     * pas dans l'historique : confirmation native, « Annuler » par défaut.
     */
    "memory-history-purge": async (memoryId?: unknown): Promise<{ purged: number } | false> => {
      if (memoryId !== undefined && memoryId !== null && (typeof memoryId !== "string" || !MEMORY_ID.test(memoryId))) throw new Error("[oneai] souvenir invalide");
      if (!ctx.shell.confirm) throw new Error("[oneai] confirmation native indisponible, refusé");
      const one = typeof memoryId === "string";
      const ok = await ctx.shell.confirm(
        one ? "Effacer l'historique de ce souvenir ?" : "Effacer tout l'historique de la mémoire ?",
        "Les versions passées et les souvenirs retirés qu'il garde sont effacés pour de bon : ils ne pourront plus être rétablis. Les souvenirs actuels ne changent pas.",
        "Effacer",
      );
      if (!ok) return false;
      return { purged: agent().memory.purgeHistory(one ? (memoryId as string) : undefined) };
    },
  };
}
